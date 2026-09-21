/**
 * PolicyGatedSigner error types.
 *
 * @packageDocumentation
 */

/**
 * Thrown for a construction-time / configuration error in a PolicyGatedSigner
 * adapter — e.g. a `local` signer constructed without the required
 * `acknowledgeAdvisory: true`, or a non-bypassable signer asserted on an
 * advisory one (`assertNonBypassable`). Policy *denials* are NOT errors — they
 * are returned as a typed {@link PolicyRejection} in {@link SignResult}.
 *
 * @example
 * ```ts
 * import { createLocalPolicyGatedSigner, PolicyGatedSignerConfigError } from "kawasekit/signer";
 *
 * try {
 *   // @ts-expect-error — acknowledgeAdvisory is required
 *   createLocalPolicyGatedSigner({ account, policy, asset });
 * } catch (error) {
 *   if (error instanceof PolicyGatedSignerConfigError) {
 *     console.error(`${error.field}: ${error.reason}`);
 *   }
 * }
 * ```
 */
export class PolicyGatedSignerConfigError extends Error {
	/** The offending config field. */
	readonly field: string;
	/** Short machine-readable reason. */
	readonly reason: string;

	constructor(field: string, reason: string, options?: { cause?: unknown }) {
		super(`Invalid PolicyGatedSigner config (${field}): ${reason}`, options);
		this.name = "PolicyGatedSignerConfigError";
		this.field = field;
		this.reason = reason;
	}
}
