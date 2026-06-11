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
 * **Wire hardening (RFC §4.7/§4.8, Track C):** a bounded **transient-only retry**
 * replays the byte-identical intent (nonce included — idempotency-by-nonce is the
 * safety net) under a fresh A3 envelope and accepts the backend's **roundless
 * idempotent-replay result** via an ecrecover/low-S self-check; the **ceremony
 * deadline always fires before `validBefore`** (minus a clock-skew budget, W11),
 * and inbound round payloads are **bounded** before the WASM boundary (M3). Tuning
 * via {@link Mpc2pWireOptions}.
 *
 * @packageDocumentation
 */

import type { Address, Hex } from "viem";
import { getAddress, hashTypedData, recoverAddress, serializeSignature, toHex } from "viem";
import type { X402AssetParam } from "../tokens/asset-domain";
import { resolveAssetParam, resolvedAssetToEip3009Domain } from "../tokens/asset-domain";
import { transferWithAuthorizationTypes } from "../tokens/eip3009";
import { CoSignUnavailableError, PolicyGatedSignerConfigError } from "./errors";
import type { CoSignFrame, CoSignRequestEnvelope } from "./mpc-2p-wire";
import { canonicalRequestBytes, MAX_FRAME_BYTES, toWireIntent, WIRE_VERSION } from "./mpc-2p-wire";
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

/**
 * Wire liveness / retry tuning (RFC m6-3a §4.7 + §4.8). Every field is optional
 * with a safe default. The invariants these enforce:
 *
 * - **Retry (4b/H2):** only the **transient transport class** is retried (connect
 *   failed / connection dropped), replaying the **byte-identical intent** — nonce
 *   included, so the backend's idempotency-by-nonce is the safety net — under a
 *   fresh A3 envelope (the freshness guard rejects a replayed envelope by design).
 *   A delivered rejection, a ban/identifiable-abort, a protocol anomaly, or a
 *   timeout is never retried.
 * - **Liveness (4c/W11/M1+M3):** the ceremony deadline always fires **before**
 *   `intent.validBefore − clockSkewBudgetSecs` (a co-signature must never be born
 *   expired), and a `sign()` whose remaining window is under
 *   `minWindowSecs + clockSkewBudgetSecs` is refused up front.
 * - **Inbound bound (4c/M3):** a `round` payload over `maxFrameBytes` is refused
 *   before it reaches the WASM boundary (mirrors the backend's bound).
 */
export interface Mpc2pWireOptions {
	/** Max ceremony attempts for transient transport failures (default 2 = one retry). */
	readonly maxAttempts?: number;
	/** Overall per-`sign()` budget in ms, across ALL attempts (default 30_000). */
	readonly ceremonyTimeoutMs?: number;
	/** Minimum remaining validity window required at `sign()` start, in seconds (default 30). */
	readonly minWindowSecs?: number;
	/** Max tolerated agent-host clock skew, in seconds (default 30). */
	readonly clockSkewBudgetSecs?: number;
	/** Inbound round-payload bound in bytes (default {@link MAX_FRAME_BYTES} = 8 MiB). */
	readonly maxFrameBytes?: number;
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
	/** Wire liveness / retry tuning (optional; safe defaults — {@link Mpc2pWireOptions}). */
	readonly wire?: Mpc2pWireOptions;
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
	const wire = params.wire ?? {};
	const maxAttempts = Math.max(1, wire.maxAttempts ?? 2);
	const ceremonyTimeoutMs = wire.ceremonyTimeoutMs ?? 30_000;
	const minWindowSecs = wire.minWindowSecs ?? 30;
	const clockSkewBudgetSecs = wire.clockSkewBudgetSecs ?? 30;
	const maxFrameBytes = wire.maxFrameBytes ?? MAX_FRAME_BYTES;

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

			// 4c (W11/M1+M3) — the ceremony-liveness minimum-window invariant: the rounds +
			// the bounded retry budget must all complete BEFORE validBefore, and validity is
			// judged against chain time, so the agent host's clock-skew budget is part of the
			// bar. A window already too small risks a born-expired signature (wasted
			// facilitator gas + retry/cap pressure); the owner has not decided anything, so
			// this throws (never a rejection).
			const validBeforeSecs = Number(intent.validBefore);
			const nowSecs = Math.floor(Date.now() / 1000);
			if (validBeforeSecs - nowSecs < minWindowSecs + clockSkewBudgetSecs) {
				throw new CoSignUnavailableError(
					`intent.validBefore (${validBeforeSecs}) leaves under the minimum ceremony window (${minWindowSecs}s + ${clockSkewBudgetSecs}s clock-skew budget) — refusing a co-sign that risks being born expired (W11)`,
				);
			}
			// One deadline for the whole sign() — every attempt included — capped so the
			// ceremony timeout always fires before validBefore (minus the clock-skew budget).
			const deadlineMs = Math.min(
				Date.now() + ceremonyTimeoutMs,
				(validBeforeSecs - clockSkewBudgetSecs) * 1000,
			);

			// 4b (RFC §4.7/H2) — bounded transient-only retry. Every attempt re-presents the
			// *byte-identical* `intent` (nonce included — the backend's idempotency-by-nonce
			// + atomic SpendState are the safety net) under a FRESH A3 envelope: the
			// ceremonyId/ssid/freshness are per-attempt BY DESIGN (the backend's freshness
			// guard rejects a replayed envelope, while idempotency keys on the unchanged
			// EIP-3009 nonce). Only the transient transport class retries — never a
			// delivered rejection, never a ban/identifiable-abort, never a timeout.
			let lastTransient: CoSignUnavailableError | undefined;
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				if (Date.now() >= deadlineMs) break;
				// A3 (v2): a fresh per-ceremony id + ssid + freshness (a timestamp + a
				// per-request nonce, distinct from the EIP-3009 nonce), authenticated over the
				// canonical bytes (the shared SoT; the HMAC key lives inside the injected
				// authenticator). Web Crypto is isomorphic (Node 19+ / browsers).
				const env: CoSignRequestEnvelope = {
					ceremonyId: globalThis.crypto.randomUUID(),
					ssid: globalThis.crypto.randomUUID(),
					intent,
					freshnessTs: Math.floor(Date.now() / 1000),
					freshnessNonce: toHex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
				};
				const authTag = await authenticator.tag(canonicalRequestBytes(env));
				try {
					const conn = await openConnection(transport);
					try {
						return await runCeremony({
							conn,
							agent,
							sessionId: session.id,
							env,
							digest,
							authTag,
							from,
							deadlineMs,
							maxFrameBytes,
						});
					} finally {
						try {
							await conn.close();
						} catch {
							// best-effort cleanup; a close error must not mask the result/throw.
						}
					}
				} catch (error) {
					if (error instanceof CoSignUnavailableError && error.transient && attempt < maxAttempts) {
						lastTransient = error;
						continue;
					}
					throw error;
				}
			}
			throw (
				lastTransient ??
				new CoSignUnavailableError(
					"co-sign ceremony budget exhausted before validBefore (W11) — no attempt could start",
				)
			);
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
		// Connect failure = the transient transport class (the one retried, §4.7).
		throw new CoSignUnavailableError("co-signer connection failed", { cause, transient: true });
	}
}

/** Everything one ceremony attempt needs (one connection, one A3 envelope). */
interface CeremonyContext {
	readonly conn: CoSignConnection;
	readonly agent: Mpc2pCoSignAgent;
	readonly sessionId: string;
	readonly env: CoSignRequestEnvelope;
	readonly digest: Hex;
	readonly authTag: Hex;
	/** The group EOA every result must recover to (the §4.4 self-check). */
	readonly from: Address;
	/** Absolute epoch-ms the ceremony must finish by (fires before validBefore — W11). */
	readonly deadlineMs: number;
	/** Inbound round-payload bound in bytes (mirrors the backend's MAX_FRAME_BYTES). */
	readonly maxFrameBytes: number;
}

/**
 * Drive one full ceremony attempt over `ctx.conn`: send the authenticated request +
 * the agent's first round, then pump rounds until a terminal frame. Returns a
 * {@link SignResult} (success or a policy denial) or throws
 * {@link CoSignUnavailableError}. There is no path that returns `{ ok: true }`
 * without a backend `result` frame that passes the ecrecover/low-S self-check.
 */
async function runCeremony(ctx: CeremonyContext): Promise<SignResult> {
	const { conn, agent, env, digest, from } = ctx;
	const send = async (frame: CoSignFrame): Promise<void> => {
		try {
			await withDeadline(conn.send(frame), ctx.deadlineMs);
		} catch (cause) {
			if (cause instanceof CoSignUnavailableError) throw cause; // the deadline (never retried)
			throw new CoSignUnavailableError("co-sign connection dropped while sending", {
				cause,
				transient: true,
			});
		}
	};
	const recv = async (): Promise<CoSignFrame> => {
		let frame: CoSignFrame;
		try {
			frame = await withDeadline(conn.recv(), ctx.deadlineMs);
		} catch (cause) {
			if (cause instanceof CoSignUnavailableError) throw cause; // the deadline (never retried)
			throw new CoSignUnavailableError("co-sign connection dropped mid-ceremony", {
				cause,
				transient: true,
			});
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
		session_id: ctx.sessionId,
		ceremony_id: env.ceremonyId,
		ssid: env.ssid,
		intent: toWireIntent(env.intent),
		freshness_ts: env.freshnessTs,
		freshness_nonce: env.freshnessNonce,
		auth_tag: ctx.authTag,
	});

	let first: Hex;
	try {
		first = agent.start(digest);
	} catch (cause) {
		// A protocol-level failure, not a transport loss — restart-not-resume classifies
		// only the transient transport class as retry-safe (§4.7), so this never retries.
		throw new CoSignUnavailableError("the agent failed to start the ceremony", { cause });
	}
	await send({ wire_version: WIRE_VERSION, kind: "round", payload: first });

	let agentSig: { r: Hex; s: Hex; v: number } | null = null;
	for (;;) {
		const frame = await recv();
		switch (frame.kind) {
			case "round": {
				// 4c (M3) — the agent-side inbound bound, mirroring the backend's
				// MAX_FRAME_BYTES: an over-bound payload is refused BEFORE hex-decode and
				// before it crosses the WASM boundary.
				const payloadBytes = (frame.payload.length - 2) / 2;
				if (payloadBytes > ctx.maxFrameBytes) {
					throw new CoSignUnavailableError(
						`co-signer sent a ${payloadBytes}-byte round frame (bound ${ctx.maxFrameBytes}) — refused pre-decode`,
					);
				}
				let step: Mpc2pStepOutcome;
				try {
					step = agent.step(frame.payload);
				} catch (cause) {
					// Protocol abort (possibly a cheating peer) — never retried (§4.7).
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
				const signature = assembleSignature({ r: frame.r, s: frame.s, v: frame.v });
				if (agentSig === null) {
					// A ROUNDLESS result = the backend's idempotent replay (§4.7): a retry hit
					// a nonce whose ceremony already committed, and the CACHED signature came
					// back with zero rounds. There is no agent-derived signature to cross-check,
					// so the self-check is recovery: low-S + ecrecover(digest) == from (§4.4).
					await verifyRecovers(digest, signature, frame.s, from, "idempotent-replay");
					return { ok: true, signature, intent: env.intent };
				}
				if (
					frame.r.toLowerCase() !== agentSig.r.toLowerCase() ||
					frame.s.toLowerCase() !== agentSig.s.toLowerCase() ||
					frame.v !== agentSig.v
				) {
					throw new CoSignUnavailableError("the backend and agent derived different signatures");
				}
				// The §4.4 ecrecover/low-S self-check: agent/backend agreement alone does not
				// prove the signature recovers to the group EOA over OUR digest — recovery does.
				await verifyRecovers(digest, signature, frame.s, from, "co-signed");
				return { ok: true, signature, intent: env.intent };
			}
			case "rejection": {
				// A genuine policy denial → typed rejection. A non-policy "rejection"
				// (transient/internal/ban) is "the owner did not decide" → no-fallback throw,
				// and it is NOT the transient transport class (never retried — a ban or an
				// in-flight duplicate must surface, not silently re-spin).
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

/**
 * Race `promise` against the ceremony deadline (W11: the timeout must fire before
 * `validBefore`). A deadline strike throws a NON-transient
 * {@link CoSignUnavailableError} — the retry budget is spent, never re-spun.
 */
function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
	const remaining = deadlineMs - Date.now();
	if (remaining <= 0) {
		return Promise.reject(
			new CoSignUnavailableError(
				"co-sign ceremony timed out (the deadline fires before validBefore — W11)",
			),
		);
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new CoSignUnavailableError(
					"co-sign ceremony timed out (the deadline fires before validBefore — W11)",
				),
			);
		}, remaining);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(cause) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

/** secp256k1 n/2 — the EIP-2 low-S bound. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * The RFC §4.4 result self-check: the signature is low-S (EIP-2) and recovers to
 * the group EOA over the adapter's OWN re-derived digest — the exact check the
 * token contract's `ecrecover` will repeat on-chain.
 */
async function verifyRecovers(
	digest: Hex,
	signature: Hex,
	s: Hex,
	from: Address,
	what: string,
): Promise<void> {
	if (BigInt(s) > SECP256K1_HALF_N) {
		throw new CoSignUnavailableError(`the ${what} signature is not low-S (EIP-2)`);
	}
	let recovered: Address;
	try {
		recovered = await recoverAddress({ hash: digest, signature });
	} catch (cause) {
		throw new CoSignUnavailableError(`the ${what} signature failed to recover`, { cause });
	}
	if (getAddress(recovered) !== from) {
		throw new CoSignUnavailableError(
			`the ${what} signature recovers to ${getAddress(recovered)}, not the group EOA ${from}`,
		);
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
