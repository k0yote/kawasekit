/**
 * Buy-list → ZeroDev policy bundle for a **disposable, scoped session key**
 * (the Agent Commerce Hub authorization flow).
 *
 * A user's resolved buy-list (its merchants + a per-payment cap + a schedule window) is baked into
 * a session key by composing two on-chain policies:
 * 1. **callPolicy** — the key may pay **only through the `Settlement` contract**:
 *    `JPYC.approve(Settlement, amount ≤ cap)` and
 *    `Settlement.pay(JPYC, merchant ∈ merchants, amount ≤ cap, …)`. A bare `JPYC.transfer` is NOT
 *    in the scope, so every yen such a key moves carries an order reference, and the chain — not
 *    this SDK — guarantees it. ({@link buildSettlementCallPolicy}.)
 * 2. **timestampPolicy** — the session key is only valid within `[validAfter, validUntil]`.
 *
 * A payment is one UserOp carrying `[approve, pay]`; send it with `settleOrder`.
 *
 * Cumulative budget ("spend ≤ ¥X total") is NOT a policy field — it is the amount the user funds
 * the account with (funding is the user's responsibility, out of the SDK's scope). These policies
 * bound *who* (allowlist), *how much per payment* (cap), and *when* (window).
 *
 * The payment **count** is intentionally NOT a session-key policy either, and the call policy does
 * not bound how many calls one UserOp carries: a batch with two `pay` calls passes it. If you
 * sponsor gas, holding a UserOp to ONE payment is your sponsorship policy's job —
 * `buildSettlementPaymentCalls` is the template to compare against. (A `rateLimitPolicy` for a
 * `maxTransfers` count existed until 0.9.x and was dropped in 0.10.0; see
 * `docs/rfc/0004-buylist-drop-scheduled-rate-limit.md`.)
 *
 * Until 0.10.x this bundle scoped the key to `JPYC.transfer`. That builder survives, deprecated, as
 * {@link createLegacyTransferBuyListPolicies} — only so that keys issued by older versions can be
 * revoked. See `docs/rfc/0005-settlement-payments.md`.
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { toTimestampPolicy } from "@zerodev/permissions/policies";
import type { Address } from "viem";
import { buildSettlementCallPolicy } from "./settlement-call-policy";

/** Parameters for {@link createBuyListPolicies}. */
export interface CreateBuyListPoliciesParams {
	/** JPYC contract address on the target chain. */
	readonly jpycAddress: Address;
	/**
	 * The `Settlement` contract on the target chain — pass `getSettlementAddress(chainId)`.
	 *
	 * It MUST be the address `settleOrder` pays through (it resolves the same table): the key's
	 * approval is scoped to this exact spender, so a key built with any other address cannot pay —
	 * the payment is refused on chain with `CallViolatesParamRule()`.
	 */
	readonly settlementAddress: Address;
	/**
	 * The buy-list's resolved merchant recipient addresses — the allowlist the
	 * session key may pay. **Required and non-empty** (a buy-list always targets
	 * specific merchants); checksum-normalized + de-duplicated.
	 */
	readonly merchants: readonly Address[];
	/** Maximum JPYC (raw units) per single payment. Must be positive. */
	readonly maxPerTransfer: bigint;
	/** Schedule-window end (unix seconds); the key is invalid after this. Must be a positive integer. */
	readonly validUntil: number;
	/**
	 * Optional schedule-window start (unix seconds); the key is invalid before
	 * this. Defaults to 0 (valid immediately). Must be `< validUntil`.
	 */
	readonly validAfter?: number;
}

/**
 * Build the ZeroDev policy bundle for a buy-list-scoped session key that pays through `Settlement`.
 *
 * Plug the returned policies into `toPermissionValidator({ policies, … })` and issue the session
 * key via {@link issueSessionKey}. To revoke it later, supply the SAME policies in the SAME order.
 *
 * The on-chain callPolicy version is fixed (`V0_0_4`) — the only one this two-permission scope has
 * been run against.
 *
 * @example
 * ```ts
 * import { parseUnits } from "viem";
 * import {
 *   createBuyListPolicies, getJpycAddress, getSettlementAddress, JPYC_DECIMALS, polygonAmoy,
 * } from "kawasekit";
 *
 * const policies = createBuyListPolicies({
 *   jpycAddress: getJpycAddress(polygonAmoy.id),
 *   settlementAddress: getSettlementAddress(polygonAmoy.id),
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

	// callPolicy: approve(Settlement) + Settlement.pay, under the cap and the merchant allowlist.
	const callPolicy = buildSettlementCallPolicy({
		jpycAddress: params.jpycAddress,
		settlementAddress: params.settlementAddress,
		merchants: params.merchants,
		maxPerPayment: params.maxPerTransfer,
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
