import { getAddress, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import {
	createJpycDailyLimitPolicies,
	JPYC_DECIMALS,
	JPYC_V2_ADDRESS,
	ONE_DAY_SECONDS,
} from "../src";

const JPYC = getAddress(JPYC_V2_ADDRESS);

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
});
