/**
 * Daily-limit spending policy for JPYC, built on ZeroDev's Permission System.
 *
 * Composes two ZeroDev policies:
 * 1. **callPolicy** — locks the session key to `JPYC.transfer(to, value)`
 *    with `value ≤ maxPerTransfer`. Recipient is unrestricted in M2;
 *    add allowlisting in M3 when use cases firm up.
 * 2. **rateLimitPolicy** — caps userOp count to `maxTransfersPerDay` in any
 *    24-hour rolling window.
 *
 * Effective daily cap = `maxPerTransfer × maxTransfersPerDay`. This is not a
 * cumulative-amount tracker (ZeroDev doesn't ship one), but the agent cannot
 * exceed either dimension, so the spirit of "daily limit" holds.
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import {
	CallPolicyVersion,
	ParamCondition,
	toCallPolicy,
	toRateLimitPolicy,
} from "@zerodev/permissions/policies";
import type { Address } from "viem";
import { jpycAbi } from "../tokens/jpyc";

/** One day in seconds — the period for {@link createJpycDailyLimitPolicies}. */
export const ONE_DAY_SECONDS = 86_400;

/** Parameters for {@link createJpycDailyLimitPolicies}. */
export interface CreateJpycDailyLimitPoliciesParams {
	/** JPYC contract address on the target chain. */
	readonly jpycAddress: Address;
	/** Maximum JPYC (in raw units) the session key may move in one transfer. */
	readonly maxPerTransfer: bigint;
	/** Maximum number of transfer userOps the session key may submit per day. */
	readonly maxTransfersPerDay: number;
	/**
	 * ZeroDev callPolicy on-chain version. Defaults to V0_0_4 (latest at the
	 * time of writing). Bump only after auditing the new version's semantics.
	 */
	readonly callPolicyVersion?: CallPolicyVersion;
}

/**
 * Builds the ZeroDev policy bundle that enforces a JPYC daily spend limit.
 *
 * Plug the returned policies into `toPermissionValidator({ policies, … })`
 * — see {@link createAgentSmartAccount} for the common wiring.
 *
 * @example
 * ```ts
 * import { parseUnits } from "viem";
 * import {
 *   createJpycDailyLimitPolicies,
 *   getJpycAddress,
 *   JPYC_DECIMALS,
 *   polygonAmoy,
 * } from "kawasekit";
 *
 * const policies = createJpycDailyLimitPolicies({
 *   jpycAddress: getJpycAddress(polygonAmoy.id),
 *   maxPerTransfer: parseUnits("100", JPYC_DECIMALS), // 100 JPYC / tx
 *   maxTransfersPerDay: 10,                            // 10 tx / day
 *   // effective daily cap = 1000 JPYC
 * });
 * ```
 */
export function createJpycDailyLimitPolicies(
	params: CreateJpycDailyLimitPoliciesParams,
): readonly [Policy, Policy] {
	if (params.maxPerTransfer <= 0n) {
		throw new Error(
			`createJpycDailyLimitPolicies: maxPerTransfer must be positive, got ${params.maxPerTransfer}.`,
		);
	}
	if (!Number.isInteger(params.maxTransfersPerDay) || params.maxTransfersPerDay < 1) {
		throw new Error(
			`createJpycDailyLimitPolicies: maxTransfersPerDay must be a positive integer, got ${params.maxTransfersPerDay}.`,
		);
	}

	const callPolicy = toCallPolicy({
		policyVersion: params.callPolicyVersion ?? CallPolicyVersion.V0_0_4,
		permissions: [
			{
				target: params.jpycAddress,
				abi: jpycAbi,
				functionName: "transfer",
				args: [
					// Recipient: any address allowed (no allowlist in M2).
					null,
					// value: must be ≤ maxPerTransfer.
					{
						condition: ParamCondition.LESS_THAN_OR_EQUAL,
						value: params.maxPerTransfer,
					},
				],
			},
		],
	});

	const rateLimitPolicy = toRateLimitPolicy({
		interval: ONE_DAY_SECONDS,
		count: params.maxTransfersPerDay,
	});

	return [callPolicy, rateLimitPolicy] as const;
}
