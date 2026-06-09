import type { Address, Hex } from "viem";
import { getAddress, hashTypedData, serializeSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSpendingPolicy } from "../policy/spending-policy";
import { resolveAssetParam, resolvedAssetToEip3009Domain } from "../tokens/asset-domain";
import { transferWithAuthorizationTypes } from "../tokens/eip3009";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { CoSignUnavailableError, PolicyGatedSignerConfigError } from "./errors";
import { requireNonBypassable } from "./gate";
import { createLocalPolicyGatedSigner } from "./local";
import {
	type CoSignConnection,
	type CoSignRequestAuthenticator,
	type CoSignTransport,
	createMpc2pPolicyGatedSigner,
	type Mpc2pCoSignAgent,
	type Mpc2pStepOutcome,
} from "./mpc-2p";
import { type CoSignFrame, type CoSignRequestEnvelope, canonicalRequestBytes } from "./mpc-2p-wire";
import type { NonBypassableEnforcement, PaymentIntent, PolicyGatedSigner } from "./types";

const FROM = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const TOKEN = getAddress(JPYC_V2_ADDRESS);
const TO = getAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
const ASSET = { kind: "known", id: "jpyc-v2" } as const;
const SESSION = { id: "sess-1", notAfter: 2_000_000_000n };
const NONCE = `0x${"1".repeat(64)}` as Hex;

const SIG = { r: `0x${"aa".repeat(32)}` as Hex, s: `0x${"bb".repeat(32)}` as Hex, v: 27 };

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
	return {
		token: TOKEN,
		chainId: 80002,
		from: FROM,
		to: TO,
		value: 1000n,
		validAfter: 0n,
		validBefore: 1_900_000_000n,
		nonce: NONCE,
		...over,
	};
}

/** The A4 digest the adapter must hand to `agent.start` (computed independently). */
function expectedDigest(i: PaymentIntent): Hex {
	return hashTypedData({
		domain: resolvedAssetToEip3009Domain(resolveAssetParam(ASSET), i.chainId),
		types: transferWithAuthorizationTypes,
		primaryType: "TransferWithAuthorization",
		message: {
			from: i.from,
			to: i.to,
			value: i.value,
			validAfter: i.validAfter,
			validBefore: i.validBefore,
			nonce: i.nonce,
		},
	});
}

// --- mocks -----------------------------------------------------------------

function mockAgent(opts: { eoa?: Address; steps?: Mpc2pStepOutcome[] } = {}): Mpc2pCoSignAgent & {
	startedWith: Hex[];
} {
	const steps = opts.steps ?? [{ signature: SIG }];
	let i = 0;
	const startedWith: Hex[] = [];
	return {
		startedWith,
		groupEoa: () => opts.eoa ?? FROM,
		start: (digest: Hex) => {
			startedWith.push(digest);
			return "0xa1" as Hex;
		},
		step: (_incoming: Hex): Mpc2pStepOutcome => {
			const out = steps[i];
			i += 1;
			if (out === undefined) throw new Error("mock agent ran out of scripted steps");
			return out;
		},
	};
}

function mockConn(recvScript: Array<CoSignFrame | (() => never)>): CoSignConnection & {
	sent: CoSignFrame[];
	closed: number;
} {
	const sent: CoSignFrame[] = [];
	let i = 0;
	const state = { sent, closed: 0 };
	return Object.assign(state, {
		send: async (frame: CoSignFrame) => {
			sent.push(frame);
		},
		recv: async (): Promise<CoSignFrame> => {
			const next = recvScript[i];
			i += 1;
			if (next === undefined) throw new Error("mock connection ran out of scripted frames");
			if (typeof next === "function") return next();
			return next;
		},
		close: () => {
			state.closed += 1;
		},
	});
}

function mockTransport(conn: CoSignConnection | (() => never)): CoSignTransport {
	return {
		connect: async () => {
			if (typeof conn === "function") return conn();
			return conn;
		},
	};
}

function mockAuth(tag: Hex = "0xfeed"): CoSignRequestAuthenticator & { inputs: Uint8Array[] } {
	const inputs: Uint8Array[] = [];
	return {
		inputs,
		tag: (bytes: Uint8Array) => {
			inputs.push(bytes);
			return tag;
		},
	};
}

const round = (payload: Hex): CoSignFrame => ({ wire_version: 2, kind: "round", payload });
const result = (r: Hex, s: Hex, v: number): CoSignFrame => ({
	wire_version: 2,
	kind: "result",
	r,
	s,
	v,
});
const reject = (reason: string, detail = "d"): CoSignFrame => ({
	wire_version: 2,
	kind: "rejection",
	reason,
	detail,
});

function makeSigner(
	over: {
		agent?: Mpc2pCoSignAgent;
		transport?: CoSignTransport;
		authenticator?: CoSignRequestAuthenticator;
	} = {},
): PolicyGatedSigner<"cryptographic"> {
	return createMpc2pPolicyGatedSigner({
		from: FROM,
		asset: ASSET,
		session: SESSION,
		agent: over.agent ?? mockAgent(),
		transport:
			over.transport ?? mockTransport(mockConn([round("0xb1"), result(SIG.r, SIG.s, SIG.v)])),
		authenticator: over.authenticator ?? mockAuth(),
	});
}

// --- construction ----------------------------------------------------------

describe("createMpc2pPolicyGatedSigner — construction", () => {
	it("exposes enforcement=cryptographic, from, and describe()", () => {
		const s = makeSigner();
		expect(s.enforcement).toBe("cryptographic");
		expect(s.from).toBe(FROM);
		expect(s.describe()).toEqual({
			enforcement: "cryptographic",
			from: FROM,
			policyId: "sess-1",
			notAfter: 2_000_000_000n,
			revoked: false,
		});
	});

	it("throws if the agent share controls a different EOA than `from`", () => {
		expect(() => makeSigner({ agent: mockAgent({ eoa: TO }) })).toThrow(
			PolicyGatedSignerConfigError,
		);
	});
});

// --- type-gate -------------------------------------------------------------

describe("createMpc2pPolicyGatedSigner — type-gate", () => {
	it("passes requireNonBypassable (cryptographic is non-bypassable)", () => {
		const s = makeSigner();
		expect(requireNonBypassable(s)).toBe(s);
		expectTypeOf(s).toMatchTypeOf<PolicyGatedSigner<NonBypassableEnforcement>>();
	});

	it("an advisory local signer is rejected by the gate (NEGATIVE direction)", () => {
		const local = createLocalPolicyGatedSigner({
			account: privateKeyToAccount(`0x${"1".repeat(64)}`),
			policy: createSpendingPolicy({
				session: SESSION,
				perToken: [{ token: TOKEN, maxPerSign: 1000n }],
				recipientAllowlist: "any",
			}),
			asset: ASSET,
			acknowledgeAdvisory: true,
		});
		// @ts-expect-error — "advisory" is not assignable to NonBypassableEnforcement.
		requireNonBypassable(local);
	});
});

// --- happy path ------------------------------------------------------------

describe("createMpc2pPolicyGatedSigner — sign (success)", () => {
	it("co-signs over the wire and returns a serialized signature", async () => {
		const agent = mockAgent({ steps: [{ signature: SIG }] });
		const conn = mockConn([round("0xb1"), result(SIG.r, SIG.s, SIG.v)]);
		const auth = mockAuth("0xfeed");
		const s = makeSigner({ agent, transport: mockTransport(conn), authenticator: auth });

		const i = intent();
		const res = await s.sign(i);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("unreachable");
		expect(res.signature).toBe(serializeSignature({ r: SIG.r, s: SIG.s, yParity: 0 }));
		expect(res.intent).toBe(i);
		expect(conn.closed).toBe(1);
	});

	it("A4: hands the agent the EIP-712 digest recomputed from the intent", async () => {
		const agent = mockAgent();
		const s = makeSigner({ agent });
		await s.sign(intent());
		expect(agent.startedWith).toEqual([expectedDigest(intent())]);
	});

	it("A3 v2: request carries fresh ceremony/ssid/freshness + a tag over canonicalRequestBytes", async () => {
		const agent = mockAgent();
		const conn = mockConn([round("0xb1"), result(SIG.r, SIG.s, SIG.v)]);
		const auth = mockAuth("0xc0ffee");
		const i = intent();
		await makeSigner({ agent, transport: mockTransport(conn), authenticator: auth }).sign(i);

		const request = conn.sent.find((f) => f.kind === "request");
		expect(request).toBeDefined();
		if (request?.kind !== "request") throw new Error("unreachable");
		expect(request.auth_tag).toBe("0xc0ffee");
		expect(request.session_id).toBe("sess-1");
		expect(request.intent.value).toBe("1000");
		// v2: a per-ceremony id + ssid + freshness are generated and present.
		expect(request.ceremony_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(request.ssid).toMatch(/^[0-9a-f-]{36}$/);
		expect(typeof request.freshness_ts).toBe("number");
		expect(request.freshness_nonce).toMatch(/^0x[0-9a-f]{32}$/);
		// The authenticator HMAC'd exactly canonicalRequestBytes(env) — reconstruct it from the
		// sent frame + the original intent and assert byte-equality (no injection needed).
		expect(auth.inputs).toHaveLength(1);
		const env: CoSignRequestEnvelope = {
			ceremonyId: request.ceremony_id,
			ssid: request.ssid,
			intent: i,
			freshnessTs: request.freshness_ts,
			freshnessNonce: request.freshness_nonce,
		};
		expect(auth.inputs[0]).toEqual(canonicalRequestBytes(env));
		// The agent's first round is sent right after the request.
		expect(conn.sent[1]).toEqual({ wire_version: 2, kind: "round", payload: "0xa1" });
	});
});

// --- policy denials (typed rejection, never a throw) -----------------------

describe("createMpc2pPolicyGatedSigner — policy denials", () => {
	it("from_mismatch is decided locally, without touching the wire", async () => {
		const connect = vi.fn();
		const s = makeSigner({ transport: { connect } });
		const res = await s.sign(intent({ from: TO }));
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.rejection.reason).toBe("from_mismatch");
		expect(connect).not.toHaveBeenCalled();
	});

	it("token_not_allowed is decided locally", async () => {
		const connect = vi.fn();
		const s = makeSigner({ transport: { connect } });
		const res = await s.sign(
			intent({ token: getAddress("0x0000000000000000000000000000000000000abc") }),
		);
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.rejection.reason).toBe("token_not_allowed");
		expect(connect).not.toHaveBeenCalled();
	});

	it("a backend policy rejection maps to a typed SignResult (not a throw)", async () => {
		const conn = mockConn([reject("amount_exceeds_per_sign", "over cap")]);
		const res = await makeSigner({ transport: mockTransport(conn) }).sign(intent());
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.rejection).toEqual({ reason: "amount_exceeds_per_sign", detail: "over cap" });
		expect(conn.closed).toBe(1);
	});

	it("nonce_reuse_conflict (B7) surfaces as a typed rejection", async () => {
		const conn = mockConn([reject("nonce_reuse_conflict", "same nonce, different fields")]);
		const res = await makeSigner({ transport: mockTransport(conn) }).sign(intent());
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.rejection.reason).toBe("nonce_reuse_conflict");
	});
});

// --- no-silent-fallback (every wire failure throws; never {ok:true}) -------

describe("createMpc2pPolicyGatedSigner — no-silent-fallback", () => {
	const fail = () => {
		throw new Error("boom");
	};

	it("throws CoSignUnavailableError when the transport cannot connect", async () => {
		const s = makeSigner({ transport: mockTransport(fail) });
		await expect(s.sign(intent())).rejects.toBeInstanceOf(CoSignUnavailableError);
	});

	it("throws when the connection drops mid-ceremony (recv fails)", async () => {
		const conn = mockConn([fail]);
		await expect(
			makeSigner({ transport: mockTransport(conn) }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});

	it("throws when a result arrives before the agent has a signature", async () => {
		// recv yields result immediately; the agent never produced a signature.
		const conn = mockConn([result(SIG.r, SIG.s, SIG.v)]);
		await expect(
			makeSigner({ transport: mockTransport(conn) }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});

	it("throws when the backend signature disagrees with the agent's", async () => {
		const agent = mockAgent({ steps: [{ signature: SIG }] });
		const conn = mockConn([round("0xb1"), result(`0x${"cc".repeat(32)}`, SIG.s, SIG.v)]);
		await expect(
			makeSigner({ agent, transport: mockTransport(conn) }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});

	it("throws (does NOT reject) on a non-policy 'rejection' reason", async () => {
		const conn = mockConn([reject("store_error", "db down")]);
		await expect(
			makeSigner({ transport: mockTransport(conn) }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});

	it("throws on an explicit error frame", async () => {
		const conn = mockConn([{ wire_version: 2, kind: "error", message: "internal" }]);
		await expect(
			makeSigner({ transport: mockTransport(conn) }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});

	it("throws on a wire_version mismatch", async () => {
		const conn = mockConn([
			{ wire_version: 99, kind: "result", r: SIG.r, s: SIG.s, v: SIG.v } as unknown as CoSignFrame,
		]);
		await expect(
			makeSigner({ transport: mockTransport(conn) }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});
});
