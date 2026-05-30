import type { Chain } from "viem";

/**
 * A viem {@link Chain} extended with kawasekit-specific routing + finality
 * metadata.
 *
 * All standard chain fields (`id`, `rpcUrls`, `blockExplorers`,
 * `nativeCurrency`, …) are inherited from viem's `Chain`. kawasekit adds only
 * the fields below; per-token deployment info lives in `src/tokens/`.
 *
 * `defaultConfirmations` / `blockTimeMs` are **config-as-data**: the facilitator
 * reads them instead of branching on chain identity, so finality depth is a
 * per-chain property rather than a code path (cf. the finality-tuning recipe at
 * `docs/recipes/facilitator-finality-tuning.md`).
 *
 * @example
 * ```ts
 * import { polygon } from "kawasekit";
 *
 * console.log(polygon.id);                   // 137
 * console.log(polygon.isTestnet);            // false
 * console.log(polygon.defaultConfirmations); // 4
 * ```
 */
export interface KawaseChain extends Chain {
	/** `true` for test networks, `false` for production networks. */
	readonly isTestnet: boolean;
	/**
	 * Default settle confirmation depth for this chain (threat 2.8 / §6.6). Set
	 * by the chain's finality model, **not** copied across chains: probabilistic
	 * chains (Polygon) need depth; deterministic-finality chains (Avalanche
	 * Snowman, Kaia IBFT) need `1-2`; Ethereum needs ~`32`. Operators override
	 * via `CreateSelfFacilitatorParams.confirmations`.
	 */
	readonly defaultConfirmations: number;
	/**
	 * Approximate block time in milliseconds. Used to auto-size the settle
	 * `receiptTimeoutMs` default from the confirmation depth, and as the basis
	 * for the finality-tuning recipe's wall-time estimates.
	 */
	readonly blockTimeMs: number;
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
 * Note: ZeroDev does not support every kawasekit chain (e.g. Kaia uses Pimlico
 * for the smart-account path). This helper only builds the URL string; it does
 * not assert ZeroDev availability. The x402 EOA-payer path does not use ZeroDev.
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
