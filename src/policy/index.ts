/**
 * Spending policy — public surface for the `kawasekit/policy` subpath.
 *
 * Two policy paths live here: the **x402-EOA** `SpendingPolicy` +
 * {@link evaluateSpendingPolicy} (M6), and the **smart-account / ZeroDev**
 * `createJpycDailyLimitPolicies` (M2). They are siblings. Re-exports only.
 *
 * @packageDocumentation
 */

export {
	type CreateJpycDailyLimitPoliciesParams,
	createJpycDailyLimitPolicies,
	ONE_DAY_SECONDS,
} from "./daily-limit";
export {
	type CreateSpendingPolicyParams,
	createSpendingPolicy,
	evaluateSpendingPolicy,
	mergeSpendState,
	type PolicyDecision,
	type SpendingPolicy,
	SpendingPolicyConfigError,
	type SpendState,
	type TokenLimit,
} from "./spending-policy";
