/**
 * Typed errors thrown by the `kawasekit/x402` modules.
 *
 * Centralised so that consumers can `instanceof`-discriminate without importing
 * deep paths. Additional error classes are added here as the corresponding
 * modules come online (server, facilitator, …).
 *
 * @packageDocumentation
 */

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
