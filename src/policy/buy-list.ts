/**
 * Buy-list → ZeroDev policy bundle for a **disposable, scoped session key**
 * (the Agent Commerce Hub authorization flow).
 *
 * A user's resolved buy-list (its merchants + a per-transfer cap + a total
 * transfer count + a schedule window) is baked into a single-use session key by
 * composing three on-chain policies:
 * 1. **callPolicy** — `JPYC.transfer(to, value)` with `value ≤ maxPerTransfer`
 *    and `to ∈ merchants` (the allowlist; shared with
 *    {@link createJpycDailyLimitPolicies} via {@link buildJpycTransferCallPolicy}).
 * 2. **rateLimitPolicy** — a **total** cap of `maxTransfers` over the whole
 *    schedule window (the rate window is set to span `[validAfter, validUntil]`,
 *    so `count` does NOT reset within the session — it is a session total, not a
 *    per-day limit).
 * 3. **timestampPolicy** — the session key is only valid within
 *    `[validAfter, validUntil]`.
 *
 * Cumulative budget ("spend ≤ ¥X total") is NOT a policy field — it is the
 * amount the user funds the account with (funding is the user's responsibility,
 * out of the SDK's scope). These policies bound *who* (allowlist), *how much per
 * transfer* (cap), *how many* (count), and *when* (window).
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import {
	type CallPolicyVersion,
	toRateLimitPolicy,
	toTimestampPolicy,
} from "@zerodev/permissions/policies";
import type { Address } from "viem";
import { buildJpycTransferCallPolicy } from "./jpyc-call-policy";

/** Parameters for {@link createBuyListPolicies}. */
export interface CreateBuyListPoliciesParams {
	/** JPYC contract address on the target chain. */
	readonly jpycAddress: Address;
	/**
	 * The buy-list's resolved merchant recipient addresses — the allowlist the
	 * session key may pay. **Required and non-empty** (a buy-list always targets
	 * specific merchants); checksum-normalized + de-duplicated.
	 */
	readonly merchants: readonly Address[];
	/** Maximum JPYC (raw units) per single transfer. Must be positive. */
	readonly maxPerTransfer: bigint;
	/**
	 * Maximum number of transfers over the WHOLE window — a session total, not a
	 * per-day limit. Must be a positive integer.
	 */
	readonly maxTransfers: number;
	/** Schedule-window end (unix seconds); the key is invalid after this. Must be a positive integer. */
	readonly validUntil: number;
	/**
	 * Optional schedule-window start (unix seconds); the key is invalid before
	 * this. Defaults to 0 (valid immediately). Must be `< validUntil`.
	 */
	readonly validAfter?: number;
	/** ZeroDev callPolicy on-chain version. Defaults to V0_0_4. */
	readonly callPolicyVersion?: CallPolicyVersion;
}

/**
 * Build the ZeroDev policy bundle for a buy-list-scoped, single-use session key.
 *
 * Plug the returned policies into `toPermissionValidator({ policies, … })` and
 * issue the session key via {@link issueSessionKey}.
 *
 * @example
 * ```ts
 * import { parseUnits } from "viem";
 * import { createBuyListPolicies, getJpycAddress, JPYC_DECIMALS, polygonAmoy } from "kawasekit";
 *
 * const policies = createBuyListPolicies({
 *   jpycAddress: getJpycAddress(polygonAmoy.id),
 *   merchants: [merchantA, merchantB],          // pay ONLY these (allowlist)
 *   maxPerTransfer: parseUnits("500", JPYC_DECIMALS),
 *   maxTransfers: 3,                             // at most 3 transfers, total
 *   validUntil: Math.floor(Date.now() / 1000) + 3 * 86_400, // valid 3 days
 * });
 * // user funds the account with their budget; the policies bound who/how-much/how-many/when.
 * ```
 */
export function createBuyListPolicies(
	params: CreateBuyListPoliciesParams,
): readonly [Policy, Policy, Policy] {
	if (params.merchants.length === 0) {
		throw new Error(
			"createBuyListPolicies: merchants must not be empty — a buy-list must target at least one merchant.",
		);
	}
	if (!Number.isInteger(params.maxTransfers) || params.maxTransfers < 1) {
		throw new Error(
			`createBuyListPolicies: maxTransfers must be a positive integer, got ${params.maxTransfers}.`,
		);
	}
	if (!Number.isInteger(params.validUntil) || params.validUntil <= 0) {
		throw new Error(
			`createBuyListPolicies: validUntil must be a positive unix-seconds integer, got ${params.validUntil}.`,
		);
	}
	const validAfter = params.validAfter ?? 0;
	if (!Number.isInteger(validAfter) || validAfter < 0) {
		throw new Error(
			`createBuyListPolicies: validAfter must be a non-negative unix-seconds integer, got ${params.validAfter}.`,
		);
	}
	if (validAfter >= params.validUntil) {
		throw new Error(
			`createBuyListPolicies: validAfter (${validAfter}) must be before validUntil (${params.validUntil}).`,
		);
	}

	// callPolicy: amount cap + merchant allowlist (shared with daily-limit).
	const callPolicy = buildJpycTransferCallPolicy({
		jpycAddress: params.jpycAddress,
		maxPerTransfer: params.maxPerTransfer,
		recipientAllowlist: params.merchants,
		callPolicyVersion: params.callPolicyVersion,
	});

	// rateLimitPolicy: a TOTAL cap of maxTransfers over the window. Setting the
	// rate window to span exactly [validAfter, validUntil] (interval = the window
	// length, startAt = validAfter) keeps the whole session in one rate bucket, so
	// `count` is a session total — NOT a per-day limit that could reset and let
	// more than maxTransfers through over a multi-day window.
	const rateLimitPolicy = toRateLimitPolicy({
		interval: params.validUntil - validAfter,
		count: params.maxTransfers,
		startAt: validAfter,
	});

	// timestampPolicy: the key is only valid within the schedule window. Omit
	// validAfter when not given (exactOptionalPropertyTypes: don't pass undefined).
	const timestampPolicy = toTimestampPolicy(
		params.validAfter === undefined
			? { validUntil: params.validUntil }
			: { validAfter: params.validAfter, validUntil: params.validUntil },
	);

	return [callPolicy, rateLimitPolicy, timestampPolicy] as const;
}
