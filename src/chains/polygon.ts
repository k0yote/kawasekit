import type { Address, Chain } from "viem";
import { polygon as viemPolygon, polygonAmoy as viemPolygonAmoy } from "viem/chains";

/**
 * A viem {@link Chain} extended with kawasekit-specific metadata.
 *
 * All standard chain fields (`id`, `rpcUrls`, `blockExplorers`,
 * `nativeCurrency`, …) are inherited from viem's `Chain`. kawasekit adds the
 * fields it needs to route stablecoin payments.
 *
 * @example
 * ```ts
 * import { polygon } from "kawasekit";
 *
 * console.log(polygon.id);            // 137
 * console.log(polygon.jpycAddress);   // JPYC contract on Polygon
 * ```
 */
export interface KawaseChain extends Chain {
	/** `true` for test networks, `false` for production networks. */
	readonly isTestnet: boolean;
	/**
	 * JPYC stablecoin contract address on this chain, or `null` when JPYC is
	 * not deployed there (e.g. testnets).
	 */
	readonly jpycAddress: Address | null;
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
	// JPYC (電子決済手段, Funds-Transfer type) on Polygon — verified on
	// PolygonScan: https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29
	jpycAddress: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
} satisfies KawaseChain;

/**
 * Polygon Amoy testnet — the primary M1 development target.
 *
 * Built on viem's `polygonAmoy` definition. JPYC is not deployed on Amoy, so
 * {@link KawaseChain.jpycAddress} is `null`.
 */
export const polygonAmoy = {
	...viemPolygonAmoy,
	isTestnet: true,
	jpycAddress: null,
} satisfies KawaseChain;
