import { type Address, getAddress, pad, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { createBuyListPolicies, JPYC_DECIMALS, JPYC_V2_ADDRESS } from "../src";

const JPYC = getAddress(JPYC_V2_ADDRESS);
const MERCHANT_A = getAddress(`0x${"11".repeat(20)}`);
const MERCHANT_B = getAddress(`0x${"22".repeat(20)}`);
const NON_ALLOWLISTED = getAddress(`0x${"33".repeat(20)}`);
const VALID_UNTIL = 2_000_000_000;

function base() {
	return {
		jpycAddress: JPYC,
		merchants: [MERCHANT_A, MERCHANT_B],
		maxPerTransfer: parseUnits("500", JPYC_DECIMALS),
		maxTransfers: 3,
		validUntil: VALID_UNTIL,
	} as const;
}

/** The ENFORCED on-chain callPolicy bytes (lowercased) — getPolicyData(), not the input echo. */
function callPolicyData(policies: ReturnType<typeof createBuyListPolicies>): string {
	return policies[0].getPolicyData().toLowerCase();
}
/** The 32-byte word an address occupies in the encoded rule data (no `0x`). */
function addressWord(addr: Address): string {
	return pad(addr, { size: 32 }).slice(2).toLowerCase();
}

describe("createBuyListPolicies", () => {
	it("returns [callPolicy, rateLimitPolicy, timestampPolicy]", () => {
		const policies = createBuyListPolicies(base());
		expect(policies).toHaveLength(3);
		expect(policies[0]?.policyParams.type).toBe("call");
		expect(policies[1]?.policyParams.type).toBe("rate-limit");
		expect(policies[2]?.policyParams.type).toBe("timestamp");
	});

	it("ENFORCES the merchant allowlist in the callPolicy bytes (exactly those recipients)", () => {
		const data = callPolicyData(createBuyListPolicies(base()));
		expect(data).toContain(addressWord(MERCHANT_A));
		expect(data).toContain(addressWord(MERCHANT_B));
		expect(data).not.toContain(addressWord(NON_ALLOWLISTED));
	});

	it("rate limit is a TOTAL over the window: count = maxTransfers, interval spans [validAfter, validUntil]", () => {
		const policies = createBuyListPolicies({
			...base(),
			validAfter: 1_000_000_000,
			maxTransfers: 3,
		});
		const rate = policies[1].policyParams;
		if (rate.type !== "rate-limit") throw new Error("expected rate-limit");
		expect(rate.count).toBe(3);
		// one rate bucket spanning the whole window → count never resets within the session.
		expect(rate.interval).toBe(VALID_UNTIL - 1_000_000_000);
		expect(rate.startAt).toBe(1_000_000_000);
	});

	it("defaults validAfter to 0 (valid immediately); interval then spans [0, validUntil]", () => {
		const policies = createBuyListPolicies(base());
		const rate = policies[1].policyParams;
		if (rate.type !== "rate-limit") throw new Error("expected rate-limit");
		expect(rate.interval).toBe(VALID_UNTIL);
		expect(rate.startAt).toBe(0);
	});

	it("timestamp policy bounds the schedule window", () => {
		const policies = createBuyListPolicies({ ...base(), validAfter: 1_000_000_000 });
		const ts = policies[2].policyParams;
		if (ts.type !== "timestamp") throw new Error("expected timestamp");
		expect(ts.validUntil).toBe(VALID_UNTIL);
		expect(ts.validAfter).toBe(1_000_000_000);
	});

	it("collapses mixed-case duplicate merchants to one (shared normalizer)", () => {
		const data = callPolicyData(
			createBuyListPolicies({
				...base(),
				merchants: [MERCHANT_A, MERCHANT_A.toLowerCase() as Address, MERCHANT_A],
			}),
		);
		// one occurrence of the word (deduped), and the per-tx value cap is still encoded.
		expect(data).toContain(addressWord(MERCHANT_A));
		expect(data).not.toContain(addressWord(MERCHANT_B));
	});

	it("throws on empty merchants (a buy-list must target ≥1 merchant)", () => {
		expect(() => createBuyListPolicies({ ...base(), merchants: [] })).toThrow(
			/merchants must not be empty/,
		);
	});

	it("throws on non-positive maxPerTransfer (shared builder)", () => {
		expect(() => createBuyListPolicies({ ...base(), maxPerTransfer: 0n })).toThrow(
			/maxPerTransfer must be positive/,
		);
	});

	it("throws on a non-integer / non-positive maxTransfers", () => {
		expect(() => createBuyListPolicies({ ...base(), maxTransfers: 0 })).toThrow(
			/maxTransfers must be a positive integer/,
		);
		expect(() => createBuyListPolicies({ ...base(), maxTransfers: 2.5 })).toThrow(
			/maxTransfers must be a positive integer/,
		);
	});

	it("throws on a non-positive validUntil", () => {
		expect(() => createBuyListPolicies({ ...base(), validUntil: 0 })).toThrow(
			/validUntil must be a positive/,
		);
	});

	it("throws when validAfter is not before validUntil", () => {
		expect(() =>
			createBuyListPolicies({ ...base(), validAfter: VALID_UNTIL, validUntil: VALID_UNTIL }),
		).toThrow(/validAfter .* must be before validUntil/);
	});
});
