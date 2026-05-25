/**
 * `kawasekit/session` subpath — session-key lifecycle (issue / restore /
 * revoke / rotate) and envelope (de)serialization.
 *
 * @packageDocumentation
 */

export {
	KAWASEKIT_SESSION_ENVELOPE_VERSION,
	type KawasekitSessionEnvelope,
	type KawasekitSessionEnvelopeVersion,
	type KawasekitSessionPolicySummary,
	parseSessionEnvelope,
	serializeSessionEnvelope,
} from "./envelope";
export {
	SessionEnvelopeChainMismatchError,
	SessionEnvelopeParseError,
	SessionEnvelopeSignerMismatchError,
	SessionEnvelopeVersionError,
} from "./errors";
export { type IssueSessionKeyParams, issueSessionKey } from "./issue";
export { type RestoreSessionAccountParams, restoreSessionAccount } from "./restore";
export {
	type RevokeSessionKeyParams,
	type RevokeSessionKeyResult,
	revokeSessionKey,
} from "./revoke";
export {
	type RotateSessionKeyParams,
	type RotateSessionKeyResult,
	rotateSessionKey,
} from "./rotate";
