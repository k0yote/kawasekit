/**
 * Daily-limit spending policy for JPYC, built on ZeroDev's Permission System.
 *
 * Composes two ZeroDev policies:
 * 1. **callPolicy** — locks the session key to `JPYC.transfer(to, value)`
 *    with `value ≤ maxPerTransfer`, and — when {@link
 *    CreateJpycDailyLimitPoliciesParams.recipientAllowlist} is provided —
 *    restricts `to` to the allowlisted recipients (otherwise any recipient is
 *    allowed). This is the on-chain enforcement behind the "pay only registered
 *    merchants" model: a buy-list resolves to its merchants' addresses, which
 *    are baked into a disposable session key here.
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
import { normalizeRecipientAllowlist } from "./normalize-allowlist";

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
	/**
	 * Recipient restriction. An address list restricts the session key to
	 * `transfer` JPYC only to those recipients (enforced on-chain via the
	 * callPolicy `to` argument, condition `ONE_OF`); every other recipient is
	 * rejected before any funds move. `"any"` (or omitting the field) leaves the
	 * recipient unrestricted.
	 *
	 * The type mirrors the off-chain {@link SpendingPolicy.recipientAllowlist}
	 * (`Address[] | "any"`) so a buy-list's resolved allowlist can feed both the
	 * off-chain and on-chain policy paths unchanged. Two **deliberate** differences
	 * from that sibling, forced by on-chain semantics:
	 * - it is **optional** here (omitted = `"any"`) for backward compatibility —
	 *   the pre-allowlist policy left the recipient unrestricted;
	 * - an **empty** array `[]` **throws** (rather than meaning deny-all as it does
	 *   off-chain) — an on-chain allowlist cannot encode "match nothing"; omit it
	 *   or pass `"any"` for unrestricted, or list ≥1 recipient.
	 *
	 * Entries are checksum-normalized and de-duplicated (shared with the off-chain
	 * path via {@link normalizeRecipientAllowlist}). An address list requires
	 * `callPolicyVersion` ≥ `V0_0_2` (the `ONE_OF` condition is unsupported on
	 * `V0_0_1`); the default `V0_0_4` is fine.
	 */
	readonly recipientAllowlist?: readonly Address[] | "any";
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
 *
 * @example Restrict the session key to a buy-list's merchants only
 * ```ts
 * const policies = createJpycDailyLimitPolicies({
 *   jpycAddress: getJpycAddress(polygonAmoy.id),
 *   maxPerTransfer: parseUnits("100", JPYC_DECIMALS),
 *   maxTransfersPerDay: 5,
 *   // on-chain: any transfer to a non-allowlisted address reverts before funds move
 *   recipientAllowlist: [merchantA, merchantB],
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
	// Resolve the recipient constraint up-front. Omitted or "any" => unrestricted
	// (a `null` arg); an address list => checksum-normalized + de-duped (shared
	// with the off-chain SpendingPolicy). Unlike off-chain, an empty list is a
	// caller bug here — an on-chain allowlist cannot encode "deny all".
	const recipients =
		params.recipientAllowlist === undefined || params.recipientAllowlist === "any"
			? null
			: normalizeRecipientAllowlist(params.recipientAllowlist);
	if (recipients !== null && recipients.length === 0) {
		throw new Error(
			'createJpycDailyLimitPolicies: recipientAllowlist must not be empty — omit it or pass "any" to allow any recipient.',
		);
	}
	// The ONE_OF condition (used to encode an address list) is only supported by
	// the V0_0_2+ CallPolicy contract; catch the incompatible combination here
	// with a typed message rather than a bare error from deep inside toCallPolicy.
	if (recipients !== null && params.callPolicyVersion === CallPolicyVersion.V0_0_1) {
		throw new Error(
			"createJpycDailyLimitPolicies: recipientAllowlist requires callPolicyVersion V0_0_2 or later (the ONE_OF condition is unsupported on V0_0_1).",
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
					// Recipient (`to`): unrestricted (`null`) unless an allowlist resolved
					// above, in which case it is constrained via the ONE_OF condition.
					recipients === null ? null : { condition: ParamCondition.ONE_OF, value: recipients },
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
