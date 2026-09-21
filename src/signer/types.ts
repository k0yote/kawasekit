/**
 * PolicyGatedSigner seam — the M6 signing contract whose enforcement *strength*
 * is a first-class, type-visible property.
 *
 * A `PolicyGatedSigner` signs the decoded EIP-3009 intent
 * `{token, chainId, from, to, value, validAfter, validBefore, nonce}` **only if
 * owner policy approves it**, and returns a typed {@link PolicyRejection}
 * otherwise — there is no "sign first, check later" surface. The
 * {@link EnforcementLevel} declares whether that policy is a *guarantee*
 * (`cryptographic`/`hardware` — a key-holder cannot bypass it) or a *request*
 * (`advisory` — a `local` signer's holder can sign directly). Because `E`
 * appears in the covariant `readonly enforcement` position, a flow that demands
 * a non-bypassable signer ({@link NonBypassableEnforcement}) **fails to compile**
 * when handed an `advisory` one (see `requireNonBypassable`).
 *
 * This package ships the seam and ONE adapter: `local`, which is `advisory`. No adapter at a
 * non-bypassable level ships here — the `mpc-2p` reference adapter was removed in 0.11.0 — so a
 * flow that requires one must bring its own implementation of {@link PolicyGatedSigner}. See
 * `docs/rfc/policy-gated-signer.md`.
 *
 * @packageDocumentation
 */

import type { Address, Hex } from "viem";

/**
 * How strongly a {@link PolicyGatedSigner} enforces its policy.
 *
 * - `advisory` — a single party holds a key that can sign without the gate
 *   (the `local` adapter). The policy is a *request*, not a guarantee.
 * - `cryptographic` — the key is split (e.g. threshold signing); no valid signature exists
 *   without a policy-passing co-signature. No adapter at this level ships in this package.
 * - `hardware` — enclave-sealed key + policy (the reserved `tee` adapter).
 * - `integrator` — delegated to the integrator's HSM/KMS (the reserved `byo`
 *   adapter); the enforcement strength is integrator-defined.
 */
export type EnforcementLevel = "advisory" | "cryptographic" | "hardware" | "integrator";

/**
 * The enforcement levels whose policy a single key-holder **cannot** bypass.
 * A bounded/regulated flow should type its signer dependency as
 * `PolicyGatedSigner<NonBypassableEnforcement>` (or call `requireNonBypassable`)
 * so an `advisory` signer is rejected at compile time.
 */
export type NonBypassableEnforcement = Exclude<EnforcementLevel, "advisory" | "integrator">;

/**
 * A decoded EIP-3009 `TransferWithAuthorization` intent — never a pre-computed
 * digest (A4, "no blind signing"). An adapter recomputes the EIP-712 digest
 * from these fields plus the trusted pinned domain (`name`/`version` resolved
 * from a `(token, chainId)` config, **not** from advertised wire data), so the
 * policy can evaluate exactly what will be signed.
 *
 * The `nonce` is supplied by the caller (the x402 wiring), not generated here —
 * double-pay protection is M5's `deriveAuthorizationNonce` + the token
 * contract's `authorizationState`, a separate concern from spend policy.
 */
export interface PaymentIntent {
	/** EIP-712 `verifyingContract` — the JPYC/USDC token contract. */
	readonly token: Address;
	/** EIP-712 domain `chainId` — pins cross-chain replay. */
	readonly chainId: number;
	/** EIP-3009 authorizer; MUST equal the signer's `from`. */
	readonly from: Address;
	/** Recipient. */
	readonly to: Address;
	/** Amount, token base units. */
	readonly value: bigint;
	/** EIP-3009 window start (unix seconds). */
	readonly validAfter: bigint;
	/** EIP-3009 window end / expiry (unix seconds). */
	readonly validBefore: bigint;
	/** EIP-3009 32-byte nonce (from M5; supplied by the caller). */
	readonly nonce: Hex;
}

/**
 * Why a {@link PolicyGatedSigner} refused to sign. `detail` is human-readable
 * and MUST NOT contain the nonce or any signature material.
 *
 * The evaluator (`evaluateSpendingPolicy`) emits the `revoked` / `expired` /
 * `token_not_allowed` / `recipient_not_allowed` / `amount_exceeds_*` reasons;
 * the adapter additionally emits `from_mismatch`, and an OUT-OF-PROCESS adapter (one whose policy
 * is enforced by a separate signer it talks to) may emit `intent_digest_mismatch` /
 * `unauthenticated` / `nonce_reuse_conflict`. The `local` adapter never emits those three. The
 * consumer handles one `SignResult` regardless of adapter.
 */
export interface PolicyRejection {
	readonly reason:
		| "revoked"
		| "expired"
		| "token_not_allowed"
		| "recipient_not_allowed"
		| "amount_exceeds_per_sign"
		| "amount_exceeds_cumulative"
		| "intent_digest_mismatch"
		| "unauthenticated"
		| "from_mismatch"
		/**
		 * (out-of-process adapters) The remote signer was presented a **previously-seen EIP-3009
		 * nonce with different intent fields** — a same-nonce/different-fields fund-correctness
		 * anomaly, which it denies and audits. Double-pay protection (same nonce, same fields →
		 * cached result) is a separate, non-rejection path (`deriveAuthorizationNonce` +
		 * `authorizationState`).
		 */
		| "nonce_reuse_conflict";
	/** Human-readable reason; never contains the nonce or a signature. */
	readonly detail: string;
}

/**
 * The result of {@link PolicyGatedSigner.sign} — a typed result object, never a
 * throw on a policy denial (throws are reserved for internal/config errors).
 */
export type SignResult =
	| { readonly ok: true; readonly signature: Hex; readonly intent: PaymentIntent }
	| { readonly ok: false; readonly rejection: PolicyRejection };

/** Non-secret description of a signer, for audit / telemetry. */
export interface SignerDescription {
	readonly enforcement: EnforcementLevel;
	readonly from: Address;
	/** The bound policy's session id. */
	readonly policyId: string;
	/** The bound policy's session expiry (unix seconds). */
	readonly notAfter: bigint;
	readonly revoked: boolean;
}

/**
 * A signer that signs an EIP-3009 {@link PaymentIntent} iff owner policy
 * approves it, with a first-class, type-visible {@link EnforcementLevel}.
 *
 * `E` is covariant (it appears only in the `readonly enforcement` output
 * position), so `PolicyGatedSigner<"advisory">` is **not** assignable to
 * `PolicyGatedSigner<NonBypassableEnforcement>` — the basis of the type-gate.
 *
 * @example
 * ```ts
 * import { createLocalPolicyGatedSigner } from "kawasekit/signer";
 * import { requireNonBypassable } from "kawasekit/signer";
 *
 * const local = createLocalPolicyGatedSigner({ account, policy, asset, acknowledgeAdvisory: true });
 * // local: PolicyGatedSigner<"advisory">
 *
 * // A bounded flow demands non-bypassable enforcement:
 * // requireNonBypassable(local); // ✗ compile error — "advisory" not assignable
 *
 * const result = await local.sign(intent);
 * if (result.ok) {
 *   // result.signature is a valid EIP-3009 authorization
 * } else {
 *   console.warn(`payment refused: ${result.rejection.reason}`);
 * }
 * ```
 */
export interface PolicyGatedSigner<E extends EnforcementLevel = EnforcementLevel> {
	/** First-class, visible enforcement strength. Covariant in `E` (drives the type-gate). */
	readonly enforcement: E;
	/** The EOA whose authorization this signer produces; `intent.from` must equal this. */
	readonly from: Address;
	/** Sign iff owner policy approves the decoded `intent`; never throws on a policy denial. */
	sign(intent: PaymentIntent): Promise<SignResult>;
	/** Non-secret description for audit/telemetry. */
	describe(): SignerDescription;
}
