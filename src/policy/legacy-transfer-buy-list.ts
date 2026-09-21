/**
 * **Legacy.** The buy-list policy bundle as kawasekit ≤ 0.10.x built it: a session key scoped to
 * `JPYC.transfer(to ∈ merchants, value ≤ maxPerTransfer)` inside a time window.
 *
 * Since 0.11.0 a buy-list key pays through the `Settlement` contract instead
 * ({@link createBuyListPolicies}), and a plain `transfer` is outside its scope. This module exists
 * for ONE reason: **revocation**. `revokeSessionKey` / `buildRevokeSessionKeyCall` must be given the
 * exact policies a key was issued with — ZeroDev does not keep them on chain in a retrievable form —
 * so without this builder, a key issued by an older version could not be revoked by a newer one and
 * would stay live until its `validUntil`.
 *
 * Do not issue new keys with it. It will be removed in 0.12.0.
 *
 * The bundle is `[callPolicy, timestampPolicy]`, byte-identical to 0.10.0's for the same inputs
 * (pinned by a test). The `rateLimitPolicy` of 0.9.x is not part of it; see
 * `docs/rfc/0004-buylist-drop-scheduled-rate-limit.md`.
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { type CallPolicyVersion, toTimestampPolicy } from "@zerodev/permissions/policies";
import type { Address } from "viem";
import { buildJpycTransferCallPolicy } from "./jpyc-call-policy";

/**
 * Parameters for {@link createLegacyTransferBuyListPolicies}.
 *
 * @deprecated See {@link createLegacyTransferBuyListPolicies}.
 */
export interface CreateLegacyTransferBuyListPoliciesParams {
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
 * Rebuild the policy bundle of a buy-list session key issued by kawasekit ≤ 0.10.x — so that it
 * can be revoked.
 *
 * @deprecated Exists only to revoke keys issued by kawasekit ≤ 0.10.x. Issue new keys with
 *   {@link createBuyListPolicies}. Removed in 0.12.0.
 *
 * @example
 * ```ts
 * import { createLegacyTransferBuyListPolicies, revokeSessionKey } from "kawasekit";
 *
 * // the SAME inputs the key was issued with, in the same order
 * const policies = createLegacyTransferBuyListPolicies({ jpycAddress, merchants, maxPerTransfer, validUntil });
 * await revokeSessionKey({ ...revokeParams, policies });
 * ```
 */
export function createLegacyTransferBuyListPolicies(
	params: CreateLegacyTransferBuyListPoliciesParams,
): readonly [Policy, Policy] {
	if (params.merchants.length === 0) {
		throw new Error(
			"createLegacyTransferBuyListPolicies: merchants must not be empty — a buy-list must target at least one merchant.",
		);
	}
	if (!Number.isInteger(params.validUntil) || params.validUntil <= 0) {
		throw new Error(
			`createLegacyTransferBuyListPolicies: validUntil must be a positive unix-seconds integer, got ${params.validUntil}.`,
		);
	}
	const validAfter = params.validAfter ?? 0;
	if (!Number.isInteger(validAfter) || validAfter < 0) {
		throw new Error(
			`createLegacyTransferBuyListPolicies: validAfter must be a non-negative unix-seconds integer, got ${params.validAfter}.`,
		);
	}
	if (validAfter >= params.validUntil) {
		throw new Error(
			`createLegacyTransferBuyListPolicies: validAfter (${validAfter}) must be before validUntil (${params.validUntil}).`,
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
