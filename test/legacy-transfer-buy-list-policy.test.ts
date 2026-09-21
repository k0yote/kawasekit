import { type Address, getAddress, keccak256, pad, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { createLegacyTransferBuyListPolicies, JPYC_DECIMALS, JPYC_V2_ADDRESS } from "../src";

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
		validUntil: VALID_UNTIL,
	} as const;
}

/** The ENFORCED on-chain callPolicy bytes (lowercased) — getPolicyData(), not the input echo. */
function callPolicyData(policies: ReturnType<typeof createLegacyTransferBuyListPolicies>): string {
	return policies[0].getPolicyData().toLowerCase();
}
/** The 32-byte word an address occupies in the encoded rule data (no `0x`). */
function addressWord(addr: Address): string {
	return pad(addr, { size: 32 }).slice(2).toLowerCase();
}

describe("createLegacyTransferBuyListPolicies — byte-identical to 0.10.0", () => {
	// WHY THIS EXISTS: a session key is revoked by re-supplying the exact policies it was issued
	// with — the validator's identifier hashes them. This builder is kept so that keys issued by
	// kawasekit ≤ 0.10.x stay revocable, which is only true while its output does not move by a
	// byte. The two hashes below were captured from `createBuyListPolicies` on `main` at 0.10.0
	// (commit 76144f5), for exactly these inputs, BEFORE the builder was renamed.
	it("reproduces the policy bytes captured from 0.10.0", () => {
		const policies = createLegacyTransferBuyListPolicies({
			jpycAddress: JPYC,
			merchants: [getAddress(`0x${"22".repeat(20)}`), getAddress(`0x${"33".repeat(20)}`)],
			maxPerTransfer: 2000n * 10n ** 18n,
			validUntil: 1_800_000_900,
			validAfter: 1_800_000_000,
		});
		const call = policies[0].getPolicyData();
		const timestamp = policies[1].getPolicyData();
		expect((call.length - 2) / 2).toBe(704);
		expect(keccak256(call)).toBe(
			"0xe8dc32554bfede6365aec4f80b4d80546bbe3d301ea7481ab20816e9fd426e3e",
		);
		expect((timestamp.length - 2) / 2).toBe(64);
		expect(keccak256(timestamp)).toBe(
			"0xfd76cae4aec5d27bb6d205f17c4bc45a1d71f254dd19e2eeddb25f05372e1a84",
		);
	});
});

describe("createLegacyTransferBuyListPolicies", () => {
	// REGRESSION (0.10.0 / docs/rfc/0004): the bundle is now [callPolicy, timestampPolicy].
	// The `rateLimitPolicy` (a `maxTransfers` count on ZeroDev's scheduled-release contract
	// 0xf63d4139…) was DROPPED — it gated op i at startAt + i·interval with interval = the whole
	// window, so the 2nd transfer was not-due until validUntil and back-to-back multi-merchant
	// payment reverted AA22. Payment is bounded by allowlist + per-tx cap + window + the funded
	// balance; an op-count bound belongs to the consumer's sponsor-gas policy.
	it("returns [callPolicy, timestampPolicy] (NO rate-limit policy)", () => {
		const policies = createLegacyTransferBuyListPolicies(base());
		expect(policies).toHaveLength(2);
		expect(policies[0]?.policyParams.type).toBe("call");
		expect(policies[1]?.policyParams.type).toBe("timestamp");
		// the dropped rate-limit must not reappear in any slot.
		expect(policies.some((p) => p.policyParams.type === "rate-limit")).toBe(false);
	});

	it("ENFORCES the merchant allowlist in the callPolicy bytes (exactly those recipients)", () => {
		const data = callPolicyData(createLegacyTransferBuyListPolicies(base()));
		expect(data).toContain(addressWord(MERCHANT_A));
		expect(data).toContain(addressWord(MERCHANT_B));
		expect(data).not.toContain(addressWord(NON_ALLOWLISTED));
	});

	it("ENFORCES the per-transfer cap (a different cap ⇒ different callPolicy bytes)", () => {
		const lo = callPolicyData(
			createLegacyTransferBuyListPolicies({
				...base(),
				maxPerTransfer: parseUnits("1", JPYC_DECIMALS),
			}),
		);
		const hi = callPolicyData(
			createLegacyTransferBuyListPolicies({
				...base(),
				maxPerTransfer: parseUnits("999", JPYC_DECIMALS),
			}),
		);
		expect(lo).not.toBe(hi);
	});

	it("timestamp policy bounds the schedule window", () => {
		const policies = createLegacyTransferBuyListPolicies({ ...base(), validAfter: 1_000_000_000 });
		const ts = policies[1].policyParams;
		if (ts.type !== "timestamp") throw new Error("expected timestamp");
		expect(ts.validUntil).toBe(VALID_UNTIL);
		expect(ts.validAfter).toBe(1_000_000_000);
	});

	it("defaults validAfter to 0 on the timestamp policy when not given (valid immediately)", () => {
		const policies = createLegacyTransferBuyListPolicies(base());
		const ts = policies[1].policyParams;
		if (ts.type !== "timestamp") throw new Error("expected timestamp");
		expect(ts.validUntil).toBe(VALID_UNTIL);
		expect(ts.validAfter).toBe(0);
	});

	it("collapses mixed-case duplicate merchants to one (shared normalizer)", () => {
		const data = callPolicyData(
			createLegacyTransferBuyListPolicies({
				...base(),
				merchants: [MERCHANT_A, MERCHANT_A.toLowerCase() as Address, MERCHANT_A],
			}),
		);
		// one occurrence of the word (deduped), and the per-tx value cap is still encoded.
		expect(data).toContain(addressWord(MERCHANT_A));
		expect(data).not.toContain(addressWord(MERCHANT_B));
	});

	it("throws on empty merchants (a buy-list must target ≥1 merchant)", () => {
		expect(() => createLegacyTransferBuyListPolicies({ ...base(), merchants: [] })).toThrow(
			/merchants must not be empty/,
		);
	});

	it("throws on non-positive maxPerTransfer (shared builder)", () => {
		expect(() => createLegacyTransferBuyListPolicies({ ...base(), maxPerTransfer: 0n })).toThrow(
			/maxPerTransfer must be positive/,
		);
	});

	it("throws on a non-positive validUntil", () => {
		expect(() => createLegacyTransferBuyListPolicies({ ...base(), validUntil: 0 })).toThrow(
			/validUntil must be a positive/,
		);
	});

	it("throws when validAfter is not before validUntil", () => {
		expect(() =>
			createLegacyTransferBuyListPolicies({
				...base(),
				validAfter: VALID_UNTIL,
				validUntil: VALID_UNTIL,
			}),
		).toThrow(/validAfter .* must be before validUntil/);
	});
});
