/**
 * Spending policy — policy-as-data for the x402 / EIP-3009 PolicyGatedSigner
 * (M6). One declarative {@link SpendingPolicy} (session + expiry, per-token
 * `maxPerSign` + cumulative cap, recipient allowlist, `revoked`) and one pure,
 * deny-closed evaluator {@link evaluateSpendingPolicy}.
 *
 * The same specification is enforced SDK-side (the `local` adapter) and, for the
 * `mpc-2p` adapter, re-implemented backend-side in Rust (the `kawasekit-mpc-2p`
 * co-signer); a shared conformance corpus
 * (`__fixtures__/spending-policy.vectors.json`) keeps the two in lockstep.
 * The evaluator is **check-only** — it reads `SpendState` and never mutates it;
 * the cumulative-cap *commit* (folding a successful spend back in via
 * {@link mergeSpendState}) is the adapter's job, and atomic+authoritative
 * commit is a property of the `cryptographic` adapter only.
 *
 * This is the **x402-EOA** policy path. The smart-account / ZeroDev session-key
 * path is `createJpycDailyLimitPolicies` (`./daily-limit`) — a sibling, not a
 * replacement.
 *
 * @packageDocumentation
 */

import type { Address } from "viem";
import { getAddress } from "viem";
import type { PaymentIntent, PolicyRejection } from "../signer/types";
import { normalizeRecipientAllowlist } from "./normalize-allowlist";

/** Per-token spend limits. A token absent from the policy's `perToken` is NOT allowed. */
export interface TokenLimit {
	readonly token: Address;
	/** Max value per single signature, token base units. Generalizes `maxAmountPerSign` (threat 1.14). */
	readonly maxPerSign: bigint;
	/** Optional total across the session. `undefined` = uncapped. MUST be `>= maxPerSign`. */
	readonly cumulativeCap?: bigint;
}

/**
 * Policy-as-data evaluated for every {@link PaymentIntent}. Deny-closed
 * throughout: a token not listed in `perToken` is rejected, and
 * `recipientAllowlist` is **required** — `"any"` (unrestricted) is a conscious,
 * greppable choice, never a silent default.
 */
export interface SpendingPolicy {
	readonly version: "1";
	/** Session id + expiry (unix seconds). An authorization may not outlive the session. */
	readonly session: { readonly id: string; readonly notAfter: bigint };
	readonly perToken: readonly TokenLimit[];
	/**
	 * Recipient restriction (**required** — no silent allow-open default):
	 * `"any"` = unrestricted, `[]` = deny-all, `[...]` = allowlist. Making
	 * `"any"` explicit keeps the policy deny-closed like `perToken`.
	 *
	 * The on-chain {@link createJpycDailyLimitPolicies} takes the same
	 * `Address[] | "any"` shape, with two on-chain-forced differences: it is
	 * optional (omitted = `"any"`), and `[]` throws there (an on-chain allowlist
	 * cannot encode deny-all).
	 */
	readonly recipientAllowlist: readonly Address[] | "any";
	readonly revoked: boolean;
}

/**
 * Cross-call cumulative spend, per token. Injected into the evaluator (never a
 * module global). For the `local` adapter this is a single-process, caller-managed
 * **read-only view**; the authoritative ledger lives in the `cryptographic`
 * adapter's backend.
 */
export interface SpendState {
	readonly spentPerToken: readonly { readonly token: Address; readonly spent: bigint }[];
}

/** The outcome of {@link evaluateSpendingPolicy}. */
export type PolicyDecision =
	| { readonly ok: true }
	| { readonly ok: false; readonly rejection: PolicyRejection };

/** Thrown by {@link createSpendingPolicy} on a malformed policy. */
export class SpendingPolicyConfigError extends Error {
	readonly field: string;
	readonly reason: string;

	constructor(field: string, reason: string, options?: { cause?: unknown }) {
		super(`Invalid SpendingPolicy (${field}): ${reason}`, options);
		this.name = "SpendingPolicyConfigError";
		this.field = field;
		this.reason = reason;
	}
}

function deny(reason: PolicyRejection["reason"], detail: string): PolicyDecision {
	return { ok: false, rejection: { reason, detail } };
}

/**
 * Evaluate a {@link SpendingPolicy} against a decoded {@link PaymentIntent}.
 *
 * Pure, deterministic, no I/O. Deny-closed; the first failing check wins. All
 * amount comparisons are `bigint`; all address equality uses `getAddress()` on
 * both sides. **Reads `state`, never mutates it** — see {@link mergeSpendState}.
 * `detail` strings never contain the nonce or any signature.
 *
 * @example
 * ```ts
 * const decision = evaluateSpendingPolicy(policy, intent, state, BigInt(Math.floor(Date.now() / 1000)));
 * if (!decision.ok) console.warn(decision.rejection.reason);
 * ```
 */
export function evaluateSpendingPolicy(
	policy: SpendingPolicy,
	intent: PaymentIntent,
	state: SpendState,
	nowSeconds: bigint,
): PolicyDecision {
	if (policy.revoked) {
		return deny("revoked", "the spending policy has been revoked");
	}
	if (nowSeconds > policy.session.notAfter) {
		return deny("expired", `session expired at ${policy.session.notAfter} (now ${nowSeconds})`);
	}
	if (intent.validBefore > policy.session.notAfter) {
		return deny(
			"expired",
			`authorization validBefore ${intent.validBefore} outlives the session (notAfter ${policy.session.notAfter})`,
		);
	}

	const intentToken = getAddress(intent.token);
	const limit = policy.perToken.find((l) => getAddress(l.token) === intentToken);
	if (limit === undefined) {
		return deny("token_not_allowed", `token ${intentToken} is not in the policy`);
	}

	if (policy.recipientAllowlist !== "any") {
		const to = getAddress(intent.to);
		const allowed = policy.recipientAllowlist.some((a) => getAddress(a) === to);
		if (!allowed) {
			return deny("recipient_not_allowed", `recipient ${to} is not on the allowlist`);
		}
	}

	if (intent.value > limit.maxPerSign) {
		return deny(
			"amount_exceeds_per_sign",
			`value ${intent.value} exceeds maxPerSign ${limit.maxPerSign}`,
		);
	}

	if (limit.cumulativeCap !== undefined) {
		const spent = state.spentPerToken.find((s) => getAddress(s.token) === intentToken)?.spent ?? 0n;
		if (spent + intent.value > limit.cumulativeCap) {
			return deny(
				"amount_exceeds_cumulative",
				`spent ${spent} + value ${intent.value} exceeds cumulativeCap ${limit.cumulativeCap}`,
			);
		}
	}

	return { ok: true };
}

/** Parameters for {@link createSpendingPolicy}. */
export interface CreateSpendingPolicyParams {
	readonly session: { readonly id: string; readonly notAfter: bigint };
	readonly perToken: readonly TokenLimit[];
	/** Required: `"any"` (unrestricted), `[]` (deny-all), or an allowlist. No silent default. */
	readonly recipientAllowlist: readonly Address[] | "any";
	/** Defaults to `false`. */
	readonly revoked?: boolean;
}

/**
 * Validate + normalize a {@link SpendingPolicy}. Checksums all addresses
 * (`getAddress`), de-dupes the recipient allowlist (shared
 * {@link normalizeRecipientAllowlist}; `[]` stays deny-all), rejects an empty
 * `perToken` (deny-closed), a non-positive `maxPerSign`/`cumulativeCap`, a
 * `cumulativeCap < maxPerSign`, and duplicate tokens. Throws
 * {@link SpendingPolicyConfigError} on violation.
 *
 * @example
 * ```ts
 * const policy = createSpendingPolicy({
 *   session: { id: conversationId, notAfter: BigInt(deadline) },
 *   perToken: [{ token: JPYC, maxPerSign: 1_000n, cumulativeCap: 10_000n }],
 *   recipientAllowlist: [merchant],
 * });
 * ```
 */
export function createSpendingPolicy(params: CreateSpendingPolicyParams): SpendingPolicy {
	if (typeof params.session.id !== "string" || params.session.id === "") {
		throw new SpendingPolicyConfigError("session.id", "must be a non-empty string");
	}
	if (params.session.notAfter <= 0n) {
		throw new SpendingPolicyConfigError(
			"session.notAfter",
			`must be a positive unix-seconds bigint, got ${params.session.notAfter}`,
		);
	}
	if (params.perToken.length === 0) {
		throw new SpendingPolicyConfigError(
			"perToken",
			"must list at least one token (the policy is deny-closed)",
		);
	}

	const seen = new Set<string>();
	const perToken: readonly TokenLimit[] = params.perToken.map((l) => {
		const token = getAddress(l.token);
		if (seen.has(token)) {
			throw new SpendingPolicyConfigError("perToken", `duplicate token ${token}`);
		}
		seen.add(token);
		if (l.maxPerSign <= 0n) {
			throw new SpendingPolicyConfigError(
				"perToken.maxPerSign",
				`must be positive, got ${l.maxPerSign} for ${token}`,
			);
		}
		if (l.cumulativeCap !== undefined) {
			if (l.cumulativeCap <= 0n) {
				throw new SpendingPolicyConfigError(
					"perToken.cumulativeCap",
					`must be positive, got ${l.cumulativeCap} for ${token}`,
				);
			}
			if (l.cumulativeCap < l.maxPerSign) {
				throw new SpendingPolicyConfigError(
					"perToken.cumulativeCap",
					`cumulativeCap (${l.cumulativeCap}) must be >= maxPerSign (${l.maxPerSign}) for ${token}`,
				);
			}
			return { token, maxPerSign: l.maxPerSign, cumulativeCap: l.cumulativeCap };
		}
		return { token, maxPerSign: l.maxPerSign };
	});

	// Checksum-normalize + de-dupe the allowlist (shared with the on-chain
	// daily-limit path). `[]` stays `[]` — deny-all is a valid off-chain policy.
	const recipientAllowlist =
		params.recipientAllowlist === "any"
			? "any"
			: normalizeRecipientAllowlist(params.recipientAllowlist);

	return {
		version: "1",
		session: { id: params.session.id, notAfter: params.session.notAfter },
		perToken,
		recipientAllowlist,
		revoked: params.revoked ?? false,
	};
}

/**
 * Fold a successful spend back into a {@link SpendState} (pure; returns a new
 * state). The caller of the `local` adapter uses this to keep `cumulativeCap`
 * meaningful across calls — `local` does not own an authoritative ledger.
 */
export function mergeSpendState(
	state: SpendState,
	spend: { readonly token: Address; readonly value: bigint },
): SpendState {
	const token = getAddress(spend.token);
	const exists = state.spentPerToken.some((s) => getAddress(s.token) === token);
	const spentPerToken = exists
		? state.spentPerToken.map((s) =>
				getAddress(s.token) === token ? { token, spent: s.spent + spend.value } : s,
			)
		: [...state.spentPerToken, { token, spent: spend.value }];
	return { spentPerToken };
}
