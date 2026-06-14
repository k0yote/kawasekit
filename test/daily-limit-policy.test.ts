import { CallPolicyVersion, ParamCondition } from "@zerodev/permissions/policies";
import { type Address, getAddress, pad, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import {
	createJpycDailyLimitPolicies,
	JPYC_DECIMALS,
	JPYC_V2_ADDRESS,
	ONE_DAY_SECONDS,
} from "../src";

const JPYC = getAddress(JPYC_V2_ADDRESS);
const MERCHANT_A = getAddress(`0x${"11".repeat(20)}`);
const MERCHANT_B = getAddress(`0x${"22".repeat(20)}`);
const NON_ALLOWLISTED = getAddress(`0x${"33".repeat(20)}`);

/** Narrow `policies[0]` to its call permission's `args` tuple, or fail loudly. */
function callArgs(policies: ReturnType<typeof createJpycDailyLimitPolicies>) {
	const call = policies[0].policyParams;
	if (call.type !== "call") {
		throw new Error("expected call policy");
	}
	const permission = call.permissions?.[0];
	if (!permission || !("args" in permission) || !permission.args) {
		throw new Error("expected an ABI-bound permission with args");
	}
	return permission.args;
}

/**
 * The ENFORCED on-chain policy bytes (lowercased). `getPolicyData()` is what the
 * deployed CallPolicy actually checks against — unlike `policyParams.…args`,
 * which is only the verbatim input echo. Assertions about recipient enforcement
 * must read this, or a mis-encoded ONE_OF would pass while allowing any payee.
 */
function enforcedData(policies: ReturnType<typeof createJpycDailyLimitPolicies>): string {
	return policies[0].getPolicyData().toLowerCase();
}

/** The 32-byte word an address occupies in the encoded rule data (no `0x`). */
function addressWord(addr: Address): string {
	return pad(addr, { size: 32 }).slice(2).toLowerCase();
}

describe("createJpycDailyLimitPolicies", () => {
	it("returns exactly one call policy and one rate-limit policy", () => {
		const policies = createJpycDailyLimitPolicies({
			jpycAddress: JPYC,
			maxPerTransfer: parseUnits("100", JPYC_DECIMALS),
			maxTransfersPerDay: 10,
		});
		expect(policies).toHaveLength(2);
		expect(policies[0]?.policyParams.type).toBe("call");
		expect(policies[1]?.policyParams.type).toBe("rate-limit");
	});

	it("rate-limit policy uses a 24-hour interval", () => {
		const policies = createJpycDailyLimitPolicies({
			jpycAddress: JPYC,
			maxPerTransfer: 1n,
			maxTransfersPerDay: 1,
		});
		const rate = policies[1].policyParams;
		if (rate.type !== "rate-limit") {
			throw new Error("expected rate-limit policy");
		}
		expect(rate.interval).toBe(ONE_DAY_SECONDS);
		expect(rate.count).toBe(1);
	});

	it("call policy is bound to the JPYC contract address and transfer ABI", () => {
		const policies = createJpycDailyLimitPolicies({
			jpycAddress: JPYC,
			maxPerTransfer: parseUnits("50", JPYC_DECIMALS),
			maxTransfersPerDay: 3,
		});
		const call = policies[0].policyParams;
		if (call.type !== "call") {
			throw new Error("expected call policy");
		}
		expect(call.permissions).toHaveLength(1);
		const permission = call.permissions?.[0];
		// The Permission type splits PermissionWithABI / PermissionManual;
		// the helper returns the WithABI variant.
		expect(permission?.target).toBe(JPYC);
		// abi may not be present on PermissionManual; narrow before asserting.
		if (permission && "functionName" in permission) {
			expect(permission.functionName).toBe("transfer");
		} else {
			throw new Error("expected ABI-bound permission");
		}
	});

	it("rejects non-positive maxPerTransfer", () => {
		expect(() =>
			createJpycDailyLimitPolicies({
				jpycAddress: JPYC,
				maxPerTransfer: 0n,
				maxTransfersPerDay: 1,
			}),
		).toThrow(/maxPerTransfer must be positive/);
	});

	it("rejects non-integer maxTransfersPerDay", () => {
		expect(() =>
			createJpycDailyLimitPolicies({
				jpycAddress: JPYC,
				maxPerTransfer: 1n,
				maxTransfersPerDay: 0,
			}),
		).toThrow(/positive integer/);
		expect(() =>
			createJpycDailyLimitPolicies({
				jpycAddress: JPYC,
				maxPerTransfer: 1n,
				maxTransfersPerDay: 1.5,
			}),
		).toThrow(/positive integer/);
	});

	describe("recipientAllowlist", () => {
		it("omitted => recipient unconstrained, and NOT enforced in the policy bytes", () => {
			const maxPerTransfer = parseUnits("100", JPYC_DECIMALS);
			const policies = createJpycDailyLimitPolicies({
				jpycAddress: JPYC,
				maxPerTransfer,
				maxTransfersPerDay: 10,
			});
			// input echo: `to` arg unrestricted (null).
			const args = callArgs(policies);
			expect(args[0]).toBeNull();
			expect(args[1]).toEqual({
				condition: ParamCondition.LESS_THAN_OR_EQUAL,
				value: maxPerTransfer,
			});
			// enforcement: no recipient word is encoded into the on-chain policy data
			// (backward-compatible — no recipient rule exists).
			expect(enforcedData(policies)).not.toContain(addressWord(MERCHANT_A));
		});

		it("provided => the allowlist is ENFORCED in the policy bytes (exactly those recipients)", () => {
			const maxPerTransfer = parseUnits("100", JPYC_DECIMALS);
			const policies = createJpycDailyLimitPolicies({
				jpycAddress: JPYC,
				maxPerTransfer,
				maxTransfersPerDay: 5,
				recipientAllowlist: [MERCHANT_A, MERCHANT_B],
			});
			// Enforcement (getPolicyData = the actual on-chain bytes): both allowlisted
			// recipients are encoded; a non-allowlisted one is NOT. This proves the
			// ONE_OF rule is really emitted — not just echoed in the input args.
			const data = enforcedData(policies);
			expect(data).toContain(addressWord(MERCHANT_A));
			expect(data).toContain(addressWord(MERCHANT_B));
			expect(data).not.toContain(addressWord(NON_ALLOWLISTED));
			// input echo: the ONE_OF condition is built over exactly the allowlist.
			expect(callArgs(policies)[0]).toEqual({
				condition: ParamCondition.ONE_OF,
				value: [MERCHANT_A, MERCHANT_B],
			});
			// value cap preserved (still encoded), rate-limit untouched.
			expect(callArgs(policies)[1]).toEqual({
				condition: ParamCondition.LESS_THAN_OR_EQUAL,
				value: maxPerTransfer,
			});
			const rate = policies[1].policyParams;
			if (rate.type !== "rate-limit") {
				throw new Error("expected rate-limit policy");
			}
			expect(rate.interval).toBe(ONE_DAY_SECONDS);
			expect(rate.count).toBe(5);
		});

		it('"any" is treated as unrestricted (same as omitted), not enforced', () => {
			const policies = createJpycDailyLimitPolicies({
				jpycAddress: JPYC,
				maxPerTransfer: 1n,
				maxTransfersPerDay: 1,
				recipientAllowlist: "any",
			});
			expect(callArgs(policies)[0]).toBeNull();
			expect(enforcedData(policies)).not.toContain(addressWord(MERCHANT_A));
		});

		it('"any" with callPolicyVersion V0_0_1 does NOT throw (no ONE_OF is emitted)', () => {
			expect(() =>
				createJpycDailyLimitPolicies({
					jpycAddress: JPYC,
					maxPerTransfer: 1n,
					maxTransfersPerDay: 1,
					recipientAllowlist: "any",
					callPolicyVersion: CallPolicyVersion.V0_0_1,
				}),
			).not.toThrow();
		});

		it("collapses mixed-case duplicate addresses to one checksummed entry", () => {
			// Exercises normalizeRecipientAllowlist: the lowercase variant is a distinct
			// string, so without getAddress-normalization it would survive as a second
			// entry — this asserts it collapses to exactly one.
			expect(
				callArgs(
					createJpycDailyLimitPolicies({
						jpycAddress: JPYC,
						maxPerTransfer: 1n,
						maxTransfersPerDay: 1,
						recipientAllowlist: [MERCHANT_A, MERCHANT_A.toLowerCase() as Address, MERCHANT_A],
					}),
				)[0],
			).toEqual({ condition: ParamCondition.ONE_OF, value: [MERCHANT_A] });
		});

		it("throws on an empty allowlist (never silently deny-all)", () => {
			expect(() =>
				createJpycDailyLimitPolicies({
					jpycAddress: JPYC,
					maxPerTransfer: 1n,
					maxTransfersPerDay: 1,
					recipientAllowlist: [],
				}),
			).toThrow(/recipientAllowlist must not be empty/);
		});

		it("throws when combined with callPolicyVersion V0_0_1 (ONE_OF unsupported there)", () => {
			expect(() =>
				createJpycDailyLimitPolicies({
					jpycAddress: JPYC,
					maxPerTransfer: 1n,
					maxTransfersPerDay: 1,
					recipientAllowlist: [MERCHANT_A],
					callPolicyVersion: CallPolicyVersion.V0_0_1,
				}),
			).toThrow(/requires callPolicyVersion V0_0_2 or later/);
		});
	});
});
