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

/**
 * Thrown by the `mpc-2p` cryptographic adapter when the co-signer is
 * **unreachable or the ceremony could not complete** — endpoint down, TLS
 * failure, connection dropped mid-ceremony, timeout, a malformed/missing
 * terminal frame, or an internal protocol anomaly. It is a transient / internal
 * error on the throws channel (M6-0: throws are reserved for internal/config
 * errors), **distinct from a policy denial**.
 *
 * This is the **no-silent-fallback** guarantee (RFC m6-3a constraint 3 / W8):
 * the adapter has no local-signing path, so an unavailable wire NEVER yields an
 * `{ ok: true }` signature and NEVER a {@link PolicyRejection}. A `rejection`
 * means "the owner decided no" (audit-meaningful); a `CoSignUnavailableError`
 * means "the owner did not decide" — the caller may retry the *same* intent
 * (the backend's idempotency keeps a retry safe).
 *
 * @example
 * ```ts
 * try {
 *   const result = await mpc2pSigner.sign(intent);
 *   if (!result.ok) handleDenial(result.rejection); // owner said no
 * } catch (error) {
 *   if (error instanceof CoSignUnavailableError) retryLater(); // wire was down
 * }
 * ```
 */
export class CoSignUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CoSignUnavailableError";
	}
}
