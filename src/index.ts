/**
 * kawasekit — TypeScript SDK for stablecoin payments by AI agents.
 *
 * This is the public API surface. The package root is the one allowed barrel
 * file; it contains re-exports only — no logic. JSDoc lives on the original
 * declarations.
 *
 * @packageDocumentation
 */

export {
	type CreateAgentSmartAccountParams,
	createAgentSmartAccount,
} from "./account/session-key";
export {
	ChainNotSupportedError,
	getChain,
	isSupportedChainId,
	type KawaseChain,
	polygon,
	polygonAmoy,
	type SupportedChainId,
	supportedChains,
	zerodevRpcUrl,
} from "./chains";
export {
	type ConfiguredKernelClient,
	TransferJpycInputError,
	type TransferJpycParams,
	type TransferJpycResult,
	transferJpyc,
} from "./client/transfer-jpyc";
export {
	type CreateJpycDailyLimitPoliciesParams,
	createJpycDailyLimitPolicies,
	ONE_DAY_SECONDS,
} from "./policy/daily-limit";
export {
	authorizationDeadlineFromNow,
	type CancelAuthorizationMessage,
	type Eip3009Domain,
	generateAuthorizationNonce,
	type ReceiveWithAuthorizationMessage,
	type SignedAuthorization,
	signCancelAuthorization,
	signReceiveWithAuthorization,
	signTransferWithAuthorization,
	type TransferWithAuthorizationMessage,
} from "./tokens/eip3009";
export {
	getJpycAddress,
	JPYC_DECIMALS,
	JPYC_EIP712_DOMAIN_HINT,
	JPYC_V2_ADDRESS,
	type JpycDeployment,
	JpycNotAvailableError,
	jpycAbi,
	jpycDeployments,
} from "./tokens/jpyc";

// ---------------------------------------------------------------------------
// x402 v2 (M3-1)
// ---------------------------------------------------------------------------

export {
	getKnownAssetDomain,
	type KnownAssetDomain,
	type KnownAssetId,
	listKnownAssetIds,
} from "./tokens/known-assets";
export {
	type CreateX402PaymentSignerParams,
	createX402PaymentSigner,
	type SignX402PaymentParams,
	X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS,
	type X402AssetParam,
	type X402PaymentSigner,
	type X402TokenDomain,
} from "./x402/client";
export {
	decodePaymentRequiredHeader,
	decodePaymentResponseHeader,
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "./x402/encoding";
export { X402InvalidConfigError, X402InvalidPayloadError } from "./x402/errors";
export {
	/** @deprecated Renamed to `CreateHttpFacilitatorParams`. Removed in v0.2.0. */
	type CreateCoinbaseFacilitatorParams,
	type CreateHttpFacilitatorParams,
	type CreateSelfFacilitatorParams,
	/** @deprecated Renamed to `createHttpFacilitator`. Removed in v0.2.0. */
	createCoinbaseFacilitator,
	createHttpFacilitator,
	createSelfFacilitator,
	X402_FACILITATOR_ERROR_CODES,
} from "./x402/facilitator";
export { type WrapFetchParams, wrapFetch, type X402Fetch } from "./x402/fetch";
export {
	type BuildPaymentRequiredResponseParams,
	type BuildPaymentRequirementsParams,
	buildPaymentRequiredResponse,
	buildPaymentRequirements,
	X402_DEFAULT_MAX_TIMEOUT_SECONDS,
} from "./x402/payment-requirements";
export {
	type CreateX402HandlerParams,
	createX402Handler,
	type X402HandlerContext,
	type X402InnerHandler,
	type X402RequestHandler,
} from "./x402/server";
export {
	chainIdToX402Network,
	type Facilitator,
	isX402Network,
	X402_VERSION,
	type X402AssetTransferMethod,
	type X402ExactEvmAuthorization,
	type X402ExactEvmExtra,
	type X402ExactEvmPayload,
	type X402Network,
	type X402PaymentPayload,
	type X402PaymentRequiredResponse,
	type X402PaymentRequirements,
	type X402ResourceInfo,
	type X402Scheme,
	type X402SettlementResponse,
	type X402SettleRequest,
	type X402SettleResponse,
	type X402SupportedKind,
	type X402SupportedResponse,
	type X402VerifyRequest,
	type X402VerifyResponse,
	type X402Version,
	x402NetworkToChainId,
} from "./x402/types";

// ---------------------------------------------------------------------------
// Session-key lifecycle (M3-2)
// ---------------------------------------------------------------------------

export {
	KAWASEKIT_SESSION_ENVELOPE_VERSION,
	type KawasekitSessionEnvelope,
	type KawasekitSessionEnvelopeVersion,
	type KawasekitSessionPolicySummary,
	parseSessionEnvelope,
	serializeSessionEnvelope,
} from "./session/envelope";
export {
	SessionEnvelopeChainMismatchError,
	SessionEnvelopeParseError,
	SessionEnvelopeSignerMismatchError,
	SessionEnvelopeVersionError,
} from "./session/errors";
export { type IssueSessionKeyParams, issueSessionKey } from "./session/issue";
export { type RestoreSessionAccountParams, restoreSessionAccount } from "./session/restore";
export {
	type RevokeSessionKeyParams,
	type RevokeSessionKeyResult,
	revokeSessionKey,
} from "./session/revoke";
export {
	type RotateSessionKeyParams,
	type RotateSessionKeyResult,
	rotateSessionKey,
} from "./session/rotate";

// ---------------------------------------------------------------------------
// Observability (M4-2)
// ---------------------------------------------------------------------------

export {
	type ClientPaymentEvent,
	extractAcceptedNetworks,
	type HookCallback,
	invokeHookSafely,
	type ObservabilityEvent,
	type ObservabilityEventBase,
	type ObservabilityHooks,
	type PaymentAcceptedEvent,
	type PaymentRequiredEvent,
	type SettleEvent,
	type VerifyEvent,
} from "./observability/hooks";
