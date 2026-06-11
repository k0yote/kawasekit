import type { Address, Hex } from "viem";
import { getAddress, hashTypedData, parseSignature, serializeSignature } from "viem";
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
	type Mpc2pWireOptions,
} from "./mpc-2p";
import { type CoSignFrame, type CoSignRequestEnvelope, canonicalRequestBytes } from "./mpc-2p-wire";
import type { NonBypassableEnforcement, PaymentIntent, PolicyGatedSigner } from "./types";

const FROM = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const TOKEN = getAddress(JPYC_V2_ADDRESS);
const TO = getAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
const ASSET = { kind: "known", id: "jpyc-v2" } as const;
const SESSION = { id: "sess-1", notAfter: 2_000_000_000n };
const NONCE = `0x${"1".repeat(64)}` as Hex;

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

// FROM's well-known test key (anvil account #1): the adapter now performs the RFC
// §4.4 ecrecover/low-S self-check on every result, so the mock signature must be a
// REAL low-S signature over the canonical test intent's digest, recovering to FROM.
const FROM_ACCOUNT = privateKeyToAccount(
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const SIG = await (async () => {
	const parsed = parseSignature(await FROM_ACCOUNT.sign({ hash: expectedDigest(intent()) }));
	return { r: parsed.r, s: parsed.s, v: Number(parsed.yParity) + 27 };
})();

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
		wire?: Mpc2pWireOptions;
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
		...(over.wire === undefined ? {} : { wire: over.wire }),
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
		expect(res.signature).toBe(serializeSignature({ r: SIG.r, s: SIG.s, yParity: SIG.v - 27 }));
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

	it("throws when a roundless result does NOT recover to the group EOA (fake sig)", async () => {
		// A garbage r/s cannot pass the §4.4 ecrecover self-check that guards the
		// roundless (idempotent-replay) acceptance path.
		const conn = mockConn([result(`0x${"aa".repeat(32)}`, `0x${"1b".repeat(32)}`, 27)]);
		await expect(
			makeSigner({ transport: mockTransport(conn), wire: { maxAttempts: 1 } }).sign(intent()),
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

// --- 4b: transient-only retry (RFC §4.7/H2) --------------------------------

describe("createMpc2pPolicyGatedSigner — transient retry (4b)", () => {
	const fail = () => {
		throw new Error("boom");
	};

	it("retries a mid-ceremony drop: byte-identical intent under a FRESH A3 envelope", async () => {
		const agent = mockAgent({ steps: [{ signature: SIG }] });
		const conn1 = mockConn([fail]); // drops after request + first round were sent
		const conn2 = mockConn([round("0xb1"), result(SIG.r, SIG.s, SIG.v)]);
		const conns = [conn1, conn2];
		const connect = vi.fn(async (): Promise<CoSignConnection> => {
			const c = conns.shift();
			if (!c) throw new Error("no more scripted connections");
			return c;
		});
		const auth = mockAuth();
		const i = intent();
		const res = await makeSigner({ agent, transport: { connect }, authenticator: auth }).sign(i);

		expect(res.ok).toBe(true);
		expect(connect).toHaveBeenCalledTimes(2);
		const [req1, req2] = [conn1.sent[0], conn2.sent[0]];
		if (req1?.kind !== "request" || req2?.kind !== "request") throw new Error("unreachable");
		// H2: the EIP-3009 intent (nonce included) is replayed byte-identically…
		expect(req2.intent).toEqual(req1.intent);
		// …under a FRESH A3 envelope (the backend's freshness anti-replay requires it).
		expect(req2.ceremony_id).not.toBe(req1.ceremony_id);
		expect(req2.freshness_nonce).not.toBe(req1.freshness_nonce);
		expect(auth.inputs).toHaveLength(2);
		// One intent ⇒ one digest, for every attempt.
		expect(agent.startedWith).toEqual([expectedDigest(i), expectedDigest(i)]);
		// The dropped connection was still closed (no leak).
		expect(conn1.closed).toBe(1);
		expect(conn2.closed).toBe(1);
	});

	it("retries a failed connect and succeeds on the second attempt", async () => {
		let attempts = 0;
		const conn = mockConn([round("0xb1"), result(SIG.r, SIG.s, SIG.v)]);
		const connect = vi.fn(async (): Promise<CoSignConnection> => {
			attempts += 1;
			if (attempts === 1) throw new Error("ECONNREFUSED");
			return conn;
		});
		const res = await makeSigner({ transport: { connect } }).sign(intent());
		expect(res.ok).toBe(true);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry a delivered policy rejection", async () => {
		const connect = vi.fn(async () => mockConn([reject("revoked", "owner pulled the plug")]));
		const res = await makeSigner({ transport: { connect } }).sign(intent());
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.rejection.reason).toBe("revoked");
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry a ban (non-policy rejection): single attempt, throws", async () => {
		const connect = vi.fn(async () => mockConn([reject("banned", "counterparty cheated")]));
		await expect(makeSigner({ transport: { connect } }).sign(intent())).rejects.toBeInstanceOf(
			CoSignUnavailableError,
		);
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("exhausts maxAttempts then throws the last transient error", async () => {
		const connect = vi.fn(async (): Promise<CoSignConnection> => {
			throw new Error("ECONNREFUSED");
		});
		const err = await makeSigner({ transport: { connect } })
			.sign(intent())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CoSignUnavailableError);
		if (!(err instanceof CoSignUnavailableError)) throw new Error("unreachable");
		expect(err.transient).toBe(true);
		expect(connect).toHaveBeenCalledTimes(2); // default maxAttempts = 2
	});

	it("maxAttempts: 1 disables the retry entirely", async () => {
		const connect = vi.fn(async (): Promise<CoSignConnection> => {
			throw new Error("ECONNREFUSED");
		});
		await expect(
			makeSigner({ transport: { connect }, wire: { maxAttempts: 1 } }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
		expect(connect).toHaveBeenCalledTimes(1);
	});
});

// --- 4b: the roundless idempotent-replay result (RFC §4.7) ------------------

describe("createMpc2pPolicyGatedSigner — idempotent-replay result", () => {
	it("accepts a roundless result whose signature recovers to the group EOA", async () => {
		// The backend's idempotency-by-nonce returns the CACHED signature with zero
		// rounds; the adapter verifies it by recovery over its own digest (§4.4).
		const conn = mockConn([result(SIG.r, SIG.s, SIG.v)]);
		const i = intent();
		const res = await makeSigner({ transport: mockTransport(conn) }).sign(i);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("unreachable");
		expect(res.signature).toBe(serializeSignature({ r: SIG.r, s: SIG.s, yParity: SIG.v - 27 }));
		expect(res.intent).toBe(i);
	});

	it("rejects a roundless result signed by a DIFFERENT key (valid sig, wrong recovery)", async () => {
		const other = privateKeyToAccount(`0x${"2".repeat(64)}`);
		const parsed = parseSignature(await other.sign({ hash: expectedDigest(intent()) }));
		const conn = mockConn([result(parsed.r, parsed.s, Number(parsed.yParity) + 27)]);
		await expect(
			makeSigner({ transport: mockTransport(conn), wire: { maxAttempts: 1 } }).sign(intent()),
		).rejects.toBeInstanceOf(CoSignUnavailableError);
	});
});

// --- 4c: liveness window + ceremony deadline + inbound bound ----------------

describe("createMpc2pPolicyGatedSigner — liveness + bounds (4c)", () => {
	it("refuses up front when validBefore leaves under the minimum window (W11)", async () => {
		const connect = vi.fn();
		const s = makeSigner({ transport: { connect } });
		const tooClose = BigInt(Math.floor(Date.now() / 1000) + 10); // < default 30s + 30s skew
		await expect(s.sign(intent({ validBefore: tooClose }))).rejects.toBeInstanceOf(
			CoSignUnavailableError,
		);
		expect(connect).not.toHaveBeenCalled();
	});

	it("times out a hung ceremony (deadline fires; the connection is closed; no retry)", async () => {
		let closed = 0;
		const conn: CoSignConnection = {
			send: async () => {},
			recv: () => new Promise<never>(() => {}), // hangs forever
			close: () => {
				closed += 1;
			},
		};
		const connect = vi.fn(async () => conn);
		const s = makeSigner({
			transport: { connect },
			wire: { ceremonyTimeoutMs: 60 },
		});
		await expect(s.sign(intent())).rejects.toThrow(/timed out/);
		expect(closed).toBe(1);
		// A deadline strike is NOT the transient class — it must not re-spin.
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("refuses an over-bound inbound round payload BEFORE the WASM boundary (M3)", async () => {
		const agent = mockAgent({ steps: [] });
		const stepSpy = vi.spyOn(agent, "step");
		const big = `0x${"00".repeat(2_049)}` as Hex; // 2 049 bytes > the 2 048 test bound
		const conn = mockConn([round(big)]);
		const s = makeSigner({
			agent,
			transport: mockTransport(conn),
			wire: { maxFrameBytes: 2_048, maxAttempts: 1 },
		});
		await expect(s.sign(intent())).rejects.toThrow(/round frame/);
		expect(stepSpy).not.toHaveBeenCalled();
	});
});
