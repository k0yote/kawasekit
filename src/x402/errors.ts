/**
 * Typed errors thrown by the `kawasekit/x402` modules.
 *
 * Centralised so that consumers can `instanceof`-discriminate without importing
 * deep paths. Additional error classes are added here as the corresponding
 * modules come online (server, facilitator, …).
 *
 * @packageDocumentation
 */

import type { PolicyRejection } from "../signer/types";

/**
 * Thrown when an x402 wire-format payload is malformed: invalid base64, invalid
 * JSON, or a value that cannot represent the expected schema.
 *
 * Carries the offending header / context name so callers can produce actionable
 * log lines without re-parsing the message string.
 *
 * @example
 * ```ts
 * import { decodePaymentSignatureHeader, X402InvalidPayloadError } from "kawasekit";
 *
 * try {
 *   decodePaymentSignatureHeader(headerValue);
 * } catch (error) {
 *   if (error instanceof X402InvalidPayloadError) {
 *     console.warn(`reject ${error.context}: ${error.reason}`);
 *   }
 * }
 * ```
 */
export class X402InvalidPayloadError extends Error {
	/** Logical name of the payload that failed (e.g. `"PAYMENT-SIGNATURE"`). */
	readonly context: string;
	/** Short machine-readable reason code. */
	readonly reason: string;

	constructor(context: string, reason: string, options?: { cause?: unknown }) {
		super(`Invalid ${context} payload: ${reason}`, options);
		this.name = "X402InvalidPayloadError";
		this.context = context;
		this.reason = reason;
	}
}

/**
 * Thrown when an x402 SDK construction-time configuration is invalid: an
 * unknown `asset.kind`, a known asset id that kawasekit does not ship a
 * domain for, missing required fields on an `unsafeOverride`, etc.
 *
 * Distinct from {@link X402InvalidPayloadError} (which describes wire-format
 * problems): config errors are integrator bugs, not adversarial inputs.
 *
 * @example
 * ```ts
 * import { createX402PaymentSigner, X402InvalidConfigError } from "kawasekit";
 *
 * try {
 *   createX402PaymentSigner({
 *     network: "testnet",
 *     account,
 *     // @ts-expect-error — kind: "foo" is not a known kind
 *     asset: { kind: "foo" },
 *   });
 * } catch (error) {
 *   if (error instanceof X402InvalidConfigError) {
 *     console.error(`${error.field}: ${error.reason}`);
 *   }
 * }
 * ```
 */
export class X402InvalidConfigError extends Error {
	/** Logical name of the config field that failed (e.g. `"asset"`). */
	readonly field: string;
	/** Short machine-readable reason code. */
	readonly reason: string;

	constructor(field: string, reason: string, options?: { cause?: unknown }) {
		super(`Invalid ${field} config: ${reason}`, options);
		this.name = "X402InvalidConfigError";
		this.field = field;
		this.reason = reason;
	}
}

/**
 * A facilitator request that did not answer within `timeoutMs` ({@link createHttpFacilitator}).
 * Thrown as is for `/verify`; for `/settle` it is the `cause` of an
 * {@link X402SettleOutcomeUnknownError}, because a settle that did not answer may still land.
 *
 * @example
 * ```ts
 * import { X402FacilitatorTimeoutError } from "kawasekit";
 *
 * try {
 *   await facilitator.verify(request);
 * } catch (error) {
 *   if (error instanceof X402FacilitatorTimeoutError) {
 *     console.warn(`verify timed out after ${error.timeoutMs} ms`);
 *   }
 * }
 * ```
 */
export class X402FacilitatorTimeoutError extends Error {
	/** The facilitator endpoint that timed out. */
	readonly endpoint: "verify" | "settle";
	/** The per-attempt timeout, in milliseconds. */
	readonly timeoutMs: number;

	constructor(endpoint: "verify" | "settle", timeoutMs: number, options?: { cause?: unknown }) {
		super(`Facilitator ${endpoint} did not answer within ${timeoutMs} ms`, options);
		this.name = "X402FacilitatorTimeoutError";
		this.endpoint = endpoint;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * A `/settle` whose outcome is **unknown** ({@link createHttpFacilitator}): the facilitator may
 * have acted on it — a 502 / 504 from something in front of it, a connection dropped after the
 * request went out, a `timeoutMs` timeout — and the request is not resent. The transaction may
 * already be broadcast and may still land.
 *
 * Do not treat it as a failed payment, and never ask the payer for a new authorization because of
 * it: reconcile on chain first (the authorization's nonce is spent once it settles).
 * {@link createX402Handler} answers it with 500 `facilitator_settle_outcome_unknown` and keeps the
 * idempotency lease. The underlying failure is `cause`.
 *
 * @example
 * ```ts
 * import { X402SettleOutcomeUnknownError } from "kawasekit";
 *
 * try {
 *   await facilitator.settle(request);
 * } catch (error) {
 *   if (error instanceof X402SettleOutcomeUnknownError) {
 *     // check the authorization's nonce on chain before anything else
 *   }
 * }
 * ```
 */
export class X402SettleOutcomeUnknownError extends Error {
	constructor(cause: Error) {
		super(
			`Facilitator settle outcome unknown (${cause.message}) — the payment may still settle. Reconcile on chain; do not ask for a new authorization.`,
			{ cause },
		);
		this.name = "X402SettleOutcomeUnknownError";
	}
}

/**
 * Thrown by {@link createX402PaymentSigner} (the `signer` variant) when the bound
 * `PolicyGatedSigner` refuses to sign — i.e. its `sign()` returned
 * `{ ok: false }`. Carries the typed {@link PolicyRejection} so callers can
 * branch on `reason`. This is the policy-driven analog of the `account`
 * variant's `maxAmountPerSign` throw ({@link X402InvalidPayloadError}): the
 * `X402PaymentSigner.sign()` surface returns a payload or throws, unchanged.
 *
 * @example
 * ```ts
 * import { X402PolicyRejectedError } from "kawasekit";
 *
 * try {
 *   await signer.sign({ paymentRequirements });
 * } catch (error) {
 *   if (error instanceof X402PolicyRejectedError) {
 *     console.warn(`policy refused: ${error.reason}`);
 *   }
 * }
 * ```
 */
export class X402PolicyRejectedError extends Error {
	/** The policy rejection reason (e.g. `"amount_exceeds_per_sign"`). */
	readonly reason: PolicyRejection["reason"];
	/** The full typed rejection (its `detail` never contains the nonce or signature). */
	readonly rejection: PolicyRejection;

	constructor(rejection: PolicyRejection, options?: { cause?: unknown }) {
		super(`x402 payment rejected by policy: ${rejection.reason} (${rejection.detail})`, options);
		this.name = "X402PolicyRejectedError";
		this.reason = rejection.reason;
		this.rejection = rejection;
	}
}
