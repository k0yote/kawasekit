/**
 * PolicyGatedSigner seam (M6) — public surface for the `kawasekit/signer`
 * subpath. The signing contract whose enforcement *strength* is a first-class,
 * type-visible property, plus the `local` (advisory) adapter and the
 * type-gate. Re-exports only — JSDoc lives on the declarations.
 *
 * @packageDocumentation
 */

export { CoSignUnavailableError, PolicyGatedSignerConfigError } from "./errors";
export { assertNonBypassable, requireNonBypassable } from "./gate";
export { type CreateLocalPolicyGatedSignerParams, createLocalPolicyGatedSigner } from "./local";
export {
	type CoSignConnection,
	type CoSignRequestAuthenticator,
	type CoSignTransport,
	createMpc2pPolicyGatedSigner,
	type Mpc2pCoSignAgent,
	type Mpc2pSignerParams,
	type Mpc2pStepOutcome,
	type Mpc2pWireOptions,
} from "./mpc-2p";
export {
	type CoSignFrame,
	type CoSignRequestEnvelope,
	canonicalRequestBytes,
	MAX_FRAME_BYTES,
	toWireIntent,
	WIRE_VERSION,
	type WireIntent,
} from "./mpc-2p-wire";
export type {
	EnforcementLevel,
	NonBypassableEnforcement,
	PaymentIntent,
	PolicyGatedSigner,
	PolicyRejection,
	SignerDescription,
	SignResult,
} from "./types";
