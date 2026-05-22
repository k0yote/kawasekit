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
