import { avalanche, avalancheFuji } from "./avalanche";
import { ethereum, sepolia } from "./ethereum";
import { kaia, kairos } from "./kaia";
import { polygon, polygonAmoy } from "./polygon";
import { type KawaseChain, zerodevRpcUrl } from "./types";

export {
	avalanche,
	avalancheFuji,
	ethereum,
	type KawaseChain,
	kaia,
	kairos,
	polygon,
	polygonAmoy,
	sepolia,
	zerodevRpcUrl,
};

/**
 * All chains kawasekit supports, in priority order (CLAUDE.md chain priority:
 * Polygon → Kaia → Avalanche → Ethereum, each with its testnet).
 *
 * Exposed as a `readonly` tuple — **not** a `Map` — so that bundlers can
 * tree-shake chains a consumer never references.
 *
 * JPYC liveness is a separate axis (`src/tokens/jpyc.ts`): a chain can be
 * supported here while JPYC is not yet live on it (Avalanche Fuji / Sepolia).
 *
 * @example
 * ```ts
 * import { supportedChains } from "kawasekit";
 *
 * for (const chain of supportedChains) {
 * 	console.log(chain.id, chain.name);
 * }
 * ```
 */
export const supportedChains = [
	polygon,
	polygonAmoy,
	kaia,
	kairos,
	avalanche,
	avalancheFuji,
	ethereum,
	sepolia,
] as const;

/**
 * Union of every chain ID kawasekit supports
 * (`137 | 80002 | 8217 | 1001 | 43114 | 43113 | 1 | 11155111`).
 *
 * Derived from {@link supportedChains}, so adding a chain there extends this
 * type automatically.
 */
export type SupportedChainId = (typeof supportedChains)[number]["id"];

/** A single member of {@link supportedChains}, with its literal `id`. */
type SupportedChain = (typeof supportedChains)[number];

/**
 * Internal chain lookup, built once at module scope.
 *
 * This `Map` is an implementation detail and is intentionally **not**
 * exported: the public API exposes the {@link supportedChains} tuple instead,
 * so importing one chain does not pull in all of them.
 */
const chainsById: ReadonlyMap<number, SupportedChain> = new Map(
	supportedChains.map((chain) => [chain.id, chain]),
);

/**
 * Error thrown when a chain ID kawasekit does not support is requested.
 *
 * @example
 * ```ts
 * import { ChainNotSupportedError, getChain } from "kawasekit";
 *
 * try {
 * 	getChain(1);
 * } catch (error) {
 * 	if (error instanceof ChainNotSupportedError) {
 * 		console.error(error.message);
 * 	}
 * }
 * ```
 */
export class ChainNotSupportedError extends Error {
	constructor(chainId: number) {
		const supported = supportedChains.map((chain) => chain.id).join(", ");
		super(
			`Chain ID ${chainId} is not supported by kawasekit. ` + `Supported chain IDs: ${supported}.`,
		);
		this.name = "ChainNotSupportedError";
	}
}

/**
 * Type guard that narrows an arbitrary chain ID to a {@link SupportedChainId}.
 *
 * @param chainId - The numeric chain ID to test.
 * @returns `true` if kawasekit supports this chain ID.
 *
 * @example
 * ```ts
 * import { isSupportedChainId } from "kawasekit";
 *
 * const id = 80002;
 * if (isSupportedChainId(id)) {
 * 	// `id` is now narrowed to SupportedChainId
 * }
 * ```
 */
export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
	return chainsById.has(chainId);
}

/**
 * Looks up a supported chain by its numeric chain ID.
 *
 * The returned chain's `id` is narrowed to {@link SupportedChainId}.
 *
 * @param chainId - The numeric chain ID to look up.
 * @returns The matching {@link KawaseChain}.
 * @throws {ChainNotSupportedError} If `chainId` is not supported.
 *
 * @example
 * ```ts
 * import { getChain } from "kawasekit";
 *
 * const chain = getChain(80002); // Polygon Amoy
 * console.log(chain.name);
 * ```
 */
export function getChain(chainId: number): SupportedChain {
	const chain = chainsById.get(chainId);
	if (chain === undefined) {
		throw new ChainNotSupportedError(chainId);
	}
	return chain;
}
