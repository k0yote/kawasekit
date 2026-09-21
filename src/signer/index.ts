/**
 * PolicyGatedSigner seam (M6) — public surface for the `kawasekit/signer`
 * subpath. The signing contract whose enforcement *strength* is a first-class,
 * type-visible property, plus the `local` (advisory) adapter and the
 * type-gate. Re-exports only — JSDoc lives on the declarations.
 *
 * @packageDocumentation
 */

export { PolicyGatedSignerConfigError } from "./errors";
export { assertNonBypassable, requireNonBypassable } from "./gate";
export { type CreateLocalPolicyGatedSignerParams, createLocalPolicyGatedSigner } from "./local";
export type {
	EnforcementLevel,
	NonBypassableEnforcement,
	PaymentIntent,
	PolicyGatedSigner,
	PolicyRejection,
	SignerDescription,
	SignResult,
} from "./types";
