import type { Chain } from "viem";
import { polygon as viemPolygon, polygonAmoy as viemPolygonAmoy } from "viem/chains";

/**
 * A viem {@link Chain} extended with kawasekit-specific metadata.
 *
 * All standard chain fields (`id`, `rpcUrls`, `blockExplorers`,
 * `nativeCurrency`, …) are inherited from viem's `Chain`. kawasekit adds only
 * routing flags here; per-token deployment info lives in `src/tokens/`.
 *
 * @example
 * ```ts
 * import { polygon } from "kawasekit";
 *
 * console.log(polygon.id);          // 137
 * console.log(polygon.isTestnet);   // false
 * ```
 */
export interface KawaseChain extends Chain {
	/** `true` for test networks, `false` for production networks. */
	readonly isTestnet: boolean;
}

/** Base URL of the ZeroDev v3 RPC service. */
const ZERODEV_RPC_BASE = "https://rpc.zerodev.app/api/v3";

/**
 * Builds the ZeroDev v3 RPC URL for a chain.
 *
 * In ZeroDev v3 a single URL serves as **both** the ERC-4337 bundler endpoint
 * and the paymaster endpoint. Obtain a project ID from
 * {@link https://dashboard.zerodev.app}.
 *
 * @param chain - A kawasekit-supported chain.
 * @param projectId - ZeroDev project ID.
 * @returns Fully-qualified ZeroDev v3 RPC URL.
 *
 * @example
 * ```ts
 * import { polygonAmoy, zerodevRpcUrl } from "kawasekit";
 *
 * const rpc = zerodevRpcUrl(polygonAmoy, "my-zerodev-project-id");
 * // https://rpc.zerodev.app/api/v3/my-zerodev-project-id/chain/80002
 * ```
 */
export function zerodevRpcUrl(chain: KawaseChain, projectId: string): string {
	return `${ZERODEV_RPC_BASE}/${projectId}/chain/${chain.id}`;
}

/**
 * Polygon mainnet — priority 1 production chain.
 *
 * Built on viem's `polygon` definition (official RPC URLs, block explorers,
 * and `POL` native currency) plus kawasekit metadata.
 */
export const polygon = {
	...viemPolygon,
	isTestnet: false,
} satisfies KawaseChain;

/**
 * Polygon Amoy testnet — the primary kawasekit development target.
 *
 * Built on viem's `polygonAmoy` definition. JPYC is also live on Amoy at the
 * same address as mainnet; see `src/tokens/jpyc.ts`.
 */
export const polygonAmoy = {
	...viemPolygonAmoy,
	isTestnet: true,
} satisfies KawaseChain;
