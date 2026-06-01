import type { Hex } from "viem";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { PaymentIntent } from "../signer/types";
import {
	createSpendingPolicy,
	evaluateSpendingPolicy,
	mergeSpendState,
	type SpendingPolicy,
	SpendingPolicyConfigError,
	type SpendState,
} from "./spending-policy";

const TOKEN = getAddress("0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29");
const OTHER_TOKEN = getAddress("0x0000000000000000000000000000000000000ABc");
const FROM = getAddress("0x0000000000000000000000000000000000000001");
const TO = getAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
const OTHER_TO = getAddress("0x0000000000000000000000000000000000000002");
const NONCE = `0x${"0".repeat(64)}` as Hex;
const NOW = 1_700_000_000n;
const EMPTY_STATE: SpendState = { spentPerToken: [] };

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

function policy(over: Partial<SpendingPolicy> = {}): SpendingPolicy {
	return {
		version: "1",
		session: { id: "sess-1", notAfter: 2_000_000_000n },
		perToken: [{ token: TOKEN, maxPerSign: 1000n, cumulativeCap: 5000n }],
		recipientAllowlist: "any",
		revoked: false,
		...over,
	};
}

describe("evaluateSpendingPolicy — allow", () => {
	it("allows an in-policy intent", () => {
		expect(evaluateSpendingPolicy(policy(), intent(), EMPTY_STATE, NOW)).toEqual({ ok: true });
	});

	it("allows value == maxPerSign (boundary)", () => {
		expect(evaluateSpendingPolicy(policy(), intent({ value: 1000n }), EMPTY_STATE, NOW)).toEqual({
			ok: true,
		});
	});

	it("allows spent + value == cumulativeCap (boundary)", () => {
		const state: SpendState = { spentPerToken: [{ token: TOKEN, spent: 4000n }] };
		expect(evaluateSpendingPolicy(policy(), intent({ value: 1000n }), state, NOW)).toEqual({
			ok: true,
		});
	});

	it("allows validBefore == session.notAfter (boundary)", () => {
		const p = policy({ session: { id: "s", notAfter: 1_900_000_000n } });
		expect(
			evaluateSpendingPolicy(p, intent({ validBefore: 1_900_000_000n }), EMPTY_STATE, NOW),
		).toEqual({ ok: true });
	});

	it('"any" recipientAllowlist allows any recipient', () => {
		expect(
			evaluateSpendingPolicy(
				policy({ recipientAllowlist: "any" }),
				intent({ to: OTHER_TO }),
				EMPTY_STATE,
				NOW,
			),
		).toEqual({ ok: true });
	});

	it("matches token/recipient regardless of address checksum casing", () => {
		const p = policy({
			perToken: [{ token: TOKEN.toLowerCase() as `0x${string}`, maxPerSign: 1000n }],
			recipientAllowlist: [TO.toLowerCase() as `0x${string}`],
		});
		expect(
			evaluateSpendingPolicy(
				p,
				intent({ token: TOKEN.toLowerCase() as `0x${string}` }),
				EMPTY_STATE,
				NOW,
			),
		).toEqual({ ok: true });
	});
});

describe("evaluateSpendingPolicy — deny (each reason)", () => {
	it("revoked", () => {
		const d = evaluateSpendingPolicy(policy({ revoked: true }), intent(), EMPTY_STATE, NOW);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("revoked");
	});

	it("expired — now > session.notAfter", () => {
		const d = evaluateSpendingPolicy(policy(), intent(), EMPTY_STATE, 2_000_000_001n);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("expired");
	});

	it("expired — validBefore outlives the session", () => {
		const p = policy({ session: { id: "s", notAfter: 1_000n } });
		const d = evaluateSpendingPolicy(p, intent({ validBefore: 2_000n }), EMPTY_STATE, 500n);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("expired");
	});

	it("token_not_allowed", () => {
		const d = evaluateSpendingPolicy(policy(), intent({ token: OTHER_TOKEN }), EMPTY_STATE, NOW);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("token_not_allowed");
	});

	it("recipient_not_allowed — not on allowlist", () => {
		const p = policy({ recipientAllowlist: [TO] });
		const d = evaluateSpendingPolicy(p, intent({ to: OTHER_TO }), EMPTY_STATE, NOW);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("recipient_not_allowed");
	});

	it("recipient_not_allowed — empty allowlist is deny-all", () => {
		const p = policy({ recipientAllowlist: [] });
		const d = evaluateSpendingPolicy(p, intent(), EMPTY_STATE, NOW);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("recipient_not_allowed");
	});

	it("amount_exceeds_per_sign", () => {
		const d = evaluateSpendingPolicy(policy(), intent({ value: 1001n }), EMPTY_STATE, NOW);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("amount_exceeds_per_sign");
	});

	it("amount_exceeds_cumulative", () => {
		const state: SpendState = { spentPerToken: [{ token: TOKEN, spent: 4001n }] };
		const d = evaluateSpendingPolicy(policy(), intent({ value: 1000n }), state, NOW);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.rejection.reason).toBe("amount_exceeds_cumulative");
	});

	it("never leaks the nonce in detail", () => {
		const d = evaluateSpendingPolicy(policy(), intent({ value: 1001n }), EMPTY_STATE, NOW);
		if (!d.ok) expect(d.rejection.detail).not.toContain(NONCE);
	});
});

describe("createSpendingPolicy — validation", () => {
	const base = {
		session: { id: "s", notAfter: 2_000_000_000n },
		perToken: [{ token: TOKEN, maxPerSign: 1000n }],
		recipientAllowlist: "any" as const,
	};

	it("normalizes addresses to checksum", () => {
		const p = createSpendingPolicy({
			...base,
			perToken: [{ token: TOKEN.toLowerCase() as `0x${string}`, maxPerSign: 1000n }],
			recipientAllowlist: [TO.toLowerCase() as `0x${string}`],
		});
		expect(p.perToken[0]?.token).toBe(TOKEN);
		expect(p.recipientAllowlist?.[0]).toBe(TO);
		expect(p.revoked).toBe(false);
	});

	it("rejects empty perToken (deny-closed)", () => {
		expect(() => createSpendingPolicy({ ...base, perToken: [] })).toThrow(
			SpendingPolicyConfigError,
		);
	});

	it("rejects a non-positive maxPerSign", () => {
		expect(() =>
			createSpendingPolicy({ ...base, perToken: [{ token: TOKEN, maxPerSign: 0n }] }),
		).toThrow(SpendingPolicyConfigError);
	});

	it("rejects cumulativeCap < maxPerSign", () => {
		expect(() =>
			createSpendingPolicy({
				...base,
				perToken: [{ token: TOKEN, maxPerSign: 1000n, cumulativeCap: 999n }],
			}),
		).toThrow(SpendingPolicyConfigError);
	});

	it("rejects duplicate tokens", () => {
		expect(() =>
			createSpendingPolicy({
				...base,
				perToken: [
					{ token: TOKEN, maxPerSign: 1000n },
					{ token: TOKEN.toLowerCase() as `0x${string}`, maxPerSign: 500n },
				],
			}),
		).toThrow(SpendingPolicyConfigError);
	});

	it("rejects an empty session id", () => {
		expect(() => createSpendingPolicy({ ...base, session: { id: "", notAfter: 1n } })).toThrow(
			SpendingPolicyConfigError,
		);
	});
});

describe("mergeSpendState", () => {
	it("adds a new token entry", () => {
		const next = mergeSpendState(EMPTY_STATE, { token: TOKEN, value: 100n });
		expect(next.spentPerToken).toEqual([{ token: TOKEN, spent: 100n }]);
	});

	it("increments an existing token entry (checksum-insensitive)", () => {
		const state: SpendState = { spentPerToken: [{ token: TOKEN, spent: 100n }] };
		const next = mergeSpendState(state, {
			token: TOKEN.toLowerCase() as `0x${string}`,
			value: 50n,
		});
		expect(next.spentPerToken).toEqual([{ token: TOKEN, spent: 150n }]);
	});

	it("does not mutate the input", () => {
		const state: SpendState = { spentPerToken: [{ token: TOKEN, spent: 100n }] };
		mergeSpendState(state, { token: TOKEN, value: 50n });
		expect(state.spentPerToken[0]?.spent).toBe(100n);
	});
});
