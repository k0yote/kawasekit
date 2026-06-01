/**
 * The enforcement-level type-gate — the compile-time (and runtime) mechanism
 * that prevents an advisory signer from being substituted for an enforcing one.
 *
 * @packageDocumentation
 */

import { PolicyGatedSignerConfigError } from "./errors";
import type { NonBypassableEnforcement, PolicyGatedSigner } from "./types";

/**
 * Compile-time gate: accepts only a non-bypassable signer
 * (`cryptographic` | `hardware`). Passing an `advisory` (or `integrator`) signer
 * is a **compile error**, because `PolicyGatedSigner<"advisory">` is not
 * assignable to `PolicyGatedSigner<NonBypassableEnforcement>` (covariant `E`).
 *
 * Use it at the boundary of a bounded/regulated flow so wiring an advisory
 * signer into it fails the build, not silently at runtime.
 *
 * @example
 * ```ts
 * function payBounded(signer: PolicyGatedSigner<NonBypassableEnforcement>) { ... }
 *
 * requireNonBypassable(mpc2pSigner); // ✓ ok — cryptographic
 * // requireNonBypassable(localSigner); // ✗ compile error — advisory
 * ```
 */
export function requireNonBypassable<E extends NonBypassableEnforcement>(
	signer: PolicyGatedSigner<E>,
): PolicyGatedSigner<E> {
	return signer;
}

/**
 * Runtime mirror of {@link requireNonBypassable}, for plain-JS call sites and as
 * defense-in-depth. Throws {@link PolicyGatedSignerConfigError} if the signer is
 * advisory/integrator (i.e. bypassable). On success, narrows the signer type to
 * {@link NonBypassableEnforcement}.
 */
export function assertNonBypassable(
	signer: PolicyGatedSigner,
): asserts signer is PolicyGatedSigner<NonBypassableEnforcement> {
	if (signer.enforcement === "advisory" || signer.enforcement === "integrator") {
		throw new PolicyGatedSignerConfigError(
			"enforcement",
			`expected a non-bypassable signer (cryptographic | hardware), got "${signer.enforcement}" — an ${signer.enforcement} signer's policy can be bypassed by a key-holder`,
		);
	}
}
