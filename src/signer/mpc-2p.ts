/**
 * The `mpc-2p` PolicyGatedSigner adapter — `enforcement: "cryptographic"`.
 *
 * A 2-of-2 MPC co-signer: the agent holds ONE DKLs share, the owner backend holds
 * the other + the authoritative policy gate. No valid signature exists without a
 * **policy-passing co-sign**, so — unlike `local` — a single key-holder cannot
 * bypass the policy. That is what earns the non-bypassable `"cryptographic"` label
 * and lets the M6-0 type-gate (`requireNonBypassable`) reject an advisory signer at
 * compile time in bounded flows.
 *
 * **Open-core / thin adapter.** This module is pure orchestration over injected
 * interfaces — it ships in the public SDK with **no crypto, no socket, no key**:
 *
 * - {@link Mpc2pCoSignAgent} — the WASM DKLs share (the private package's compiled
 *   `crypto-core`); drives the agent's half of the ceremony round-by-round.
 * - {@link CoSignTransport} — the authenticated, encrypted (wss/mTLS) frame channel
 *   to the owner backend (the private package's transport).
 * - {@link CoSignRequestAuthenticator} — the A3 HMAC (the pre-shared key never
 *   enters this module).
 *
 * The adapter owns the protocol: it pins the EIP-712 domain, **re-derives the
 * digest from the intent (A4)** via the shared `transferWithAuthorizationTypes`
 * source-of-truth, computes the A3 canonical bytes, frames the versioned
 * {@link CoSignFrame} envelope, pumps the ceremony, and maps the terminal frame to
 * a {@link SignResult}. Crucially it has **no local-signing path**: any
 * transport/availability failure throws {@link CoSignUnavailableError}, never an
 * `{ ok: true }` and never a {@link PolicyRejection} (the no-silent-fallback
 * guarantee, RFC m6-3a constraint 3 / W8).
 *
 * @packageDocumentation
 */

import type { Address, Hex } from "viem";
import { getAddress, hashTypedData, serializeSignature, toHex } from "viem";
import type { X402AssetParam } from "../tokens/asset-domain";
import { resolveAssetParam, resolvedAssetToEip3009Domain } from "../tokens/asset-domain";
import { transferWithAuthorizationTypes } from "../tokens/eip3009";
import { CoSignUnavailableError, PolicyGatedSignerConfigError } from "./errors";
import type { CoSignFrame, CoSignRequestEnvelope } from "./mpc-2p-wire";
import { canonicalRequestBytes, toWireIntent, WIRE_VERSION } from "./mpc-2p-wire";
import type {
	PaymentIntent,
	PolicyGatedSigner,
	PolicyRejection,
	SignerDescription,
	SignResult,
} from "./types";

/** The agent's half of the 2-of-2 ceremony (the injected WASM DKLs share). */
export interface Mpc2pCoSignAgent {
	/** The group 2-of-2 EOA this share controls — must equal the signer's `from`. */
	groupEoa(): Address;
	/** Begin signing the 32-byte EIP-712 `digest`; returns the first outbound round (hex). */
	start(digest: Hex): Hex;
	/** Feed one inbound round (hex); returns the next outbound round, or the final signature. */
	step(incoming: Hex): Mpc2pStepOutcome;
}

/** The result of one {@link Mpc2pCoSignAgent.step}. */
export type Mpc2pStepOutcome =
	| { readonly outbound: Hex }
	| { readonly signature: { readonly r: Hex; readonly s: Hex; readonly v: number } };

/** One authenticated, encrypted ceremony connection to the owner backend. */
export interface CoSignConnection {
	/** Send one control frame. */
	send(frame: CoSignFrame): Promise<void>;
	/** Receive the next control frame (resolves per round). */
	recv(): Promise<CoSignFrame>;
	/** Release the connection (best-effort; errors here are ignored). */
	close(): void | Promise<void>;
}

/** Opens a wss/mTLS {@link CoSignConnection} for a single co-sign ceremony. */
export interface CoSignTransport {
	connect(): Promise<CoSignConnection>;
}

/** The A3 request authenticator — HMAC (or signature) over the canonical request bytes. */
export interface CoSignRequestAuthenticator {
	/** Authenticator tag over {@link canonicalRequestBytes}; the key stays inside. */
	tag(canonicalRequest: Uint8Array): Hex | Promise<Hex>;
}

/** Parameters for {@link createMpc2pPolicyGatedSigner}. */
export interface Mpc2pSignerParams {
	/** The group 2-of-2 EOA; every `intent.from` must equal this (asserted vs the agent). */
	readonly from: Address;
	/** Asset binding — pins the EIP-712 domain `name`/`version`/`verifyingContract` (A4). */
	readonly asset: X402AssetParam;
	/** The bound policy session, for `describe()` (the backend holds the authoritative policy). */
	readonly session: { readonly id: string; readonly notAfter: bigint };
	/** The injected WASM DKLs share (private package). */
	readonly agent: Mpc2pCoSignAgent;
	/** The injected wss/mTLS frame channel (private package). */
	readonly transport: CoSignTransport;
	/** The injected A3 authenticator (the pre-shared key never enters the SDK). */
	readonly authenticator: CoSignRequestAuthenticator;
}

/**
 * The backend `rejection` reasons that are genuine **policy denials** (the owner
 * decided "no" — audit-meaningful → `{ ok: false, rejection }`). Any other reason
 * on a rejection frame is treated as "the owner did not cleanly decide" and throws
 * {@link CoSignUnavailableError} (no-silent-fallback; never a misclassified denial).
 */
const POLICY_REASONS: ReadonlySet<PolicyRejection["reason"]> = new Set([
	"revoked",
	"expired",
	"token_not_allowed",
	"recipient_not_allowed",
	"amount_exceeds_per_sign",
	"amount_exceeds_cumulative",
	"intent_digest_mismatch",
	"unauthenticated",
	"from_mismatch",
	"nonce_reuse_conflict",
]);

function rejection(reason: PolicyRejection["reason"], detail: string): SignResult {
	return { ok: false, rejection: { reason, detail } };
}

/**
 * Construct an `mpc-2p` (cryptographic) PolicyGatedSigner over injected agent +
 * transport + authenticator.
 *
 * @example
 * ```ts
 * // The agent, transport and authenticator come from the private `kawasekit-mpc-2p`
 * // package (the WASM share, the wss/mTLS client, the HMAC key) — never bundled here.
 * const signer = createMpc2pPolicyGatedSigner({
 *   from: groupEoa,
 *   asset: { kind: "known", id: "jpyc-v2" },
 *   session: { id: "sess-1", notAfter: 2_000_000_000n },
 *   agent, transport, authenticator,
 * });
 * requireNonBypassable(signer); // ✓ "cryptographic" — passes the type-gate
 * const result = await signer.sign(intent);
 * ```
 */
export function createMpc2pPolicyGatedSigner(
	params: Mpc2pSignerParams,
): PolicyGatedSigner<"cryptographic"> {
	const { agent, transport, authenticator, session } = params;
	const pinned = resolveAssetParam(params.asset);
	const from = getAddress(params.from);

	// The injected share MUST control the declared group EOA, or every signature
	// would recover to the wrong address.
	const agentEoa = getAddress(agent.groupEoa());
	if (agentEoa !== from) {
		throw new PolicyGatedSignerConfigError(
			"from",
			`the agent share controls ${agentEoa} but params.from is ${from}`,
		);
	}

	return {
		enforcement: "cryptographic",
		from,
		async sign(intent: PaymentIntent): Promise<SignResult> {
			// Adapter-local pre-checks (cheap; no wire needed). Same shape as `local`.
			if (getAddress(intent.from) !== from) {
				return rejection(
					"from_mismatch",
					`intent.from ${getAddress(intent.from)} does not equal signer.from ${from}`,
				);
			}
			if (getAddress(intent.token) !== pinned.verifyingContract) {
				return rejection(
					"token_not_allowed",
					`intent.token ${getAddress(intent.token)} does not equal the signer's pinned verifyingContract ${pinned.verifyingContract}`,
				);
			}

			// A4: re-derive the EIP-712 digest from the intent + the pinned domain (the
			// SDK's exported types are the cross-language source of truth). The agent and
			// the backend each sign THIS digest; the SoT keeps them byte-identical.
			const digest = hashTypedData({
				domain: resolvedAssetToEip3009Domain(pinned, intent.chainId),
				types: transferWithAuthorizationTypes,
				primaryType: "TransferWithAuthorization",
				message: {
					from,
					to: intent.to,
					value: intent.value,
					validAfter: intent.validAfter,
					validBefore: intent.validBefore,
					nonce: intent.nonce,
				},
			});

			// A3 (v2): build the request envelope — a fresh per-ceremony id + ssid + freshness
			// (a timestamp + a per-request nonce, distinct from the EIP-3009 nonce) — and
			// authenticate over its canonical bytes (the shared SoT; the HMAC key lives inside
			// the injected authenticator). Web Crypto is isomorphic (Node 19+ / browsers).
			const env: CoSignRequestEnvelope = {
				ceremonyId: globalThis.crypto.randomUUID(),
				ssid: globalThis.crypto.randomUUID(),
				intent,
				freshnessTs: Math.floor(Date.now() / 1000),
				freshnessNonce: toHex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
			};
			const authTag = await authenticator.tag(canonicalRequestBytes(env));

			const conn = await openConnection(transport);
			try {
				return await runCeremony(conn, agent, session.id, env, digest, authTag);
			} finally {
				try {
					await conn.close();
				} catch {
					// best-effort cleanup; a close error must not mask the result/throw.
				}
			}
		},
		describe(): SignerDescription {
			return {
				enforcement: "cryptographic",
				from,
				policyId: session.id,
				notAfter: session.notAfter,
				// The backend owns authoritative revocation (a revoked session → a
				// rejection at sign time); this metadata field is best-effort.
				revoked: false,
			};
		},
	};
}

async function openConnection(transport: CoSignTransport): Promise<CoSignConnection> {
	try {
		return await transport.connect();
	} catch (cause) {
		throw new CoSignUnavailableError("co-signer connection failed", { cause });
	}
}

/**
 * Drive the full ceremony over `conn`: send the authenticated request + the agent's
 * first round, then pump rounds until a terminal frame. Returns a {@link SignResult}
 * (success or a policy denial) or throws {@link CoSignUnavailableError}. There is no
 * path that returns `{ ok: true }` without a backend `result` frame.
 */
async function runCeremony(
	conn: CoSignConnection,
	agent: Mpc2pCoSignAgent,
	sessionId: string,
	env: CoSignRequestEnvelope,
	digest: Hex,
	authTag: Hex,
): Promise<SignResult> {
	const send = async (frame: CoSignFrame): Promise<void> => {
		try {
			await conn.send(frame);
		} catch (cause) {
			throw new CoSignUnavailableError("co-sign connection dropped while sending", { cause });
		}
	};
	const recv = async (): Promise<CoSignFrame> => {
		let frame: CoSignFrame;
		try {
			frame = await conn.recv();
		} catch (cause) {
			throw new CoSignUnavailableError("co-sign connection dropped mid-ceremony", { cause });
		}
		if (frame.wire_version !== WIRE_VERSION) {
			throw new CoSignUnavailableError(
				`co-signer spoke wire_version ${frame.wire_version}, expected ${WIRE_VERSION}`,
			);
		}
		return frame;
	};

	await send({
		wire_version: WIRE_VERSION,
		kind: "request",
		session_id: sessionId,
		ceremony_id: env.ceremonyId,
		ssid: env.ssid,
		intent: toWireIntent(env.intent),
		freshness_ts: env.freshnessTs,
		freshness_nonce: env.freshnessNonce,
		auth_tag: authTag,
	});

	let first: Hex;
	try {
		first = agent.start(digest);
	} catch (cause) {
		throw new CoSignUnavailableError("the agent failed to start the ceremony", { cause });
	}
	await send({ wire_version: WIRE_VERSION, kind: "round", payload: first });

	let agentSig: { r: Hex; s: Hex; v: number } | null = null;
	for (;;) {
		const frame = await recv();
		switch (frame.kind) {
			case "round": {
				let step: Mpc2pStepOutcome;
				try {
					step = agent.step(frame.payload);
				} catch (cause) {
					throw new CoSignUnavailableError("the agent rejected a round frame", { cause });
				}
				if ("outbound" in step) {
					await send({ wire_version: WIRE_VERSION, kind: "round", payload: step.outbound });
				} else {
					agentSig = step.signature;
				}
				break;
			}
			case "result": {
				if (agentSig === null) {
					throw new CoSignUnavailableError(
						"the backend returned a result before the agent derived a signature",
					);
				}
				if (
					frame.r.toLowerCase() !== agentSig.r.toLowerCase() ||
					frame.s.toLowerCase() !== agentSig.s.toLowerCase() ||
					frame.v !== agentSig.v
				) {
					throw new CoSignUnavailableError("the backend and agent derived different signatures");
				}
				return { ok: true, signature: assembleSignature(agentSig), intent: env.intent };
			}
			case "rejection": {
				// A genuine policy denial → typed rejection. A non-policy "rejection"
				// (transient/internal) is "the owner did not decide" → no-fallback throw.
				if (POLICY_REASONS.has(frame.reason as PolicyRejection["reason"])) {
					// reason membership verified against POLICY_REASONS above.
					return rejection(frame.reason as PolicyRejection["reason"], frame.detail);
				}
				throw new CoSignUnavailableError(
					`co-signer returned a non-policy rejection (${frame.reason}): ${frame.detail}`,
				);
			}
			case "error": {
				throw new CoSignUnavailableError(`co-signer error: ${frame.message}`);
			}
			default: {
				// Unknown frame kind — never a silent success.
				throw new CoSignUnavailableError("co-signer sent an unexpected frame");
			}
		}
	}
}

/** Assemble a 65-byte EIP-3009 signature from the agent's `{ r, s, v }` (v = recovery_id + 27). */
function assembleSignature(sig: { r: Hex; s: Hex; v: number }): Hex {
	const yParity = sig.v - 27;
	if (yParity !== 0 && yParity !== 1) {
		throw new CoSignUnavailableError(`malformed recovery id v=${sig.v} (expected 27 or 28)`);
	}
	return serializeSignature({ r: sig.r, s: sig.s, yParity });
}
