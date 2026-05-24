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
