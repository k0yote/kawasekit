/**
 * `kawasekit/x402` subpath — x402 v2 client + server + facilitator.
 *
 * This subpath is the allowed barrel for the x402 module; importing one
 * symbol does not pull in the entire root surface. The Hono adapter lives at
 * `kawasekit/x402/hono` (separate subpath so `hono` stays peer-optional).
 *
 * @packageDocumentation
 */

export {
	type CreateX402PaymentSignerParams,
	createX402PaymentSigner,
	type SignX402PaymentParams,
	X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS,
	type X402PaymentSigner,
	type X402TokenDomain,
} from "./client";
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
} from "./encoding";
export { X402InvalidPayloadError } from "./errors";
export {
	type CreateCoinbaseFacilitatorParams,
	type CreateSelfFacilitatorParams,
	createCoinbaseFacilitator,
	createSelfFacilitator,
	X402_FACILITATOR_ERROR_CODES,
} from "./facilitator";
export { type WrapFetchParams, wrapFetch, type X402Fetch } from "./fetch";
export {
	type BuildPaymentRequiredResponseParams,
	type BuildPaymentRequirementsParams,
	buildPaymentRequiredResponse,
	buildPaymentRequirements,
	X402_DEFAULT_MAX_TIMEOUT_SECONDS,
} from "./payment-requirements";
export {
	type CreateX402HandlerParams,
	createX402Handler,
	type X402HandlerContext,
	type X402InnerHandler,
	type X402RequestHandler,
} from "./server";
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
} from "./types";
