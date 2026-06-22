/**
 * Buy-list → ZeroDev policy bundle for a **disposable, scoped session key**
 * (the Agent Commerce Hub authorization flow).
 *
 * A user's resolved buy-list (its merchants + a per-transfer cap + a schedule
 * window) is baked into a single-use session key by composing two on-chain
 * policies:
 * 1. **callPolicy** — `JPYC.transfer(to, value)` with `value ≤ maxPerTransfer`
 *    and `to ∈ merchants` (the allowlist; shared with
 *    {@link createJpycDailyLimitPolicies} via {@link buildJpycTransferCallPolicy}).
 * 2. **timestampPolicy** — the session key is only valid within
 *    `[validAfter, validUntil]`.
 *
 * Cumulative budget ("spend ≤ ¥X total") is NOT a policy field — it is the
 * amount the user funds the account with (funding is the user's responsibility,
 * out of the SDK's scope). These policies bound *who* (allowlist), *how much per
 * transfer* (cap), and *when* (window).
 *
 * The transfer **count** / sponsored-op bound is intentionally NOT a session-key
 * policy — total value is bounded by the funded balance, and an op-count / gas
 * bound (if desired) belongs to the consumer's **sponsor-gas policy**, not this
 * permission bundle. A prior version included a `rateLimitPolicy` for a
 * `maxTransfers` count, but it was built on ZeroDev's **scheduled-release** rate-
 * limit contract (`0xf63d4139…`, which gates op *i* at `startAt + i·interval`)
 * with `interval` = the whole window, so the 2nd transfer was *not-due until
 * `validUntil`* and the 3rd+ never — back-to-back multi-merchant payment reverted
 * `AA22`. It was dropped in `0.10.0`; see `docs/rfc/0004-buylist-drop-scheduled-rate-limit.md`.
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { type CallPolicyVersion, toTimestampPolicy } from "@zerodev/permissions/policies";
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
 *   validUntil: Math.floor(Date.now() / 1000) + 3 * 86_400, // valid 3 days
 * });
 * // user funds the account with their budget; the policies bound who/how-much/when.
 * ```
 */
export function createBuyListPolicies(
	params: CreateBuyListPoliciesParams,
): readonly [Policy, Policy] {
	if (params.merchants.length === 0) {
		throw new Error(
			"createBuyListPolicies: merchants must not be empty — a buy-list must target at least one merchant.",
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

	// timestampPolicy: the key is only valid within the schedule window. Omit
	// validAfter when not given (exactOptionalPropertyTypes: don't pass undefined).
	const timestampPolicy = toTimestampPolicy(
		params.validAfter === undefined
			? { validUntil: params.validUntil }
			: { validAfter: params.validAfter, validUntil: params.validUntil },
	);

	return [callPolicy, timestampPolicy] as const;
}
