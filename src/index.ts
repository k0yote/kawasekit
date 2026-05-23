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
