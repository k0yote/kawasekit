/**
 * `Settlement` deployments.
 *
 * `Settlement` is the contract a kawasekit payment goes through: it pulls an ERC-20 from the
 * caller, forwards it to the merchant in the same call, and emits one `Settled` event carrying the
 * order reference. It holds no funds and has no owner — nobody can designate or change a
 * destination. It is NOT audited.
 *
 * It is deployed with CREATE2 through the deterministic deployment proxy, so the address is the
 * same on every chain. It cannot be upgraded: a new version is a new address, and therefore a new
 * release of this package.
 *
 * @packageDocumentation
 */

import type { Address } from "viem";
import type { SupportedChainId } from "../chains";
import {
	avalanche,
	avalancheFuji,
	ethereum,
	kaia,
	kairos,
	polygon,
	polygonAmoy,
	sepolia,
} from "../chains";

/**
 * Address of `Settlement` v1 on every chain — CREATE2, salt `keccak256("kawasekit.settlement.v1")`.
 *
 * Deployed on:
 * - Polygon Amoy : https://amoy.polygonscan.com/address/0x25BA7329A4c5772945B9d2C0E80ec7dfd41EE485
 */
export const SETTLEMENT_V1_ADDRESS: Address = "0x25BA7329A4c5772945B9d2C0E80ec7dfd41EE485";

/** A `Settlement` deployment on a single chain. */
export interface SettlementDeployment {
	readonly chainId: SupportedChainId;
	readonly address: Address;
	/** `true` if the contract is deployed on this chain right now. */
	readonly isLive: boolean;
}

/**
 * `Settlement` deployments keyed by chain.
 *
 * The address is the same everywhere ({@link SETTLEMENT_V1_ADDRESS}); `isLive` is the separate
 * "is it actually deployed here yet?" axis. **Only Polygon Amoy is live.** Every other entry
 * records where the contract WILL be, and {@link getSettlementAddress} refuses it until then —
 * sending tokens at an address with no code would not fail loudly, so the table has to.
 */
export const settlementDeployments: {
	readonly [chainId in SupportedChainId]: SettlementDeployment;
} = {
	[polygon.id]: { chainId: polygon.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
	[polygonAmoy.id]: { chainId: polygonAmoy.id, address: SETTLEMENT_V1_ADDRESS, isLive: true },
	[kaia.id]: { chainId: kaia.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
	[kairos.id]: { chainId: kairos.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
	[avalanche.id]: { chainId: avalanche.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
	[ethereum.id]: { chainId: ethereum.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
	[avalancheFuji.id]: { chainId: avalancheFuji.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
	[sepolia.id]: { chainId: sepolia.id, address: SETTLEMENT_V1_ADDRESS, isLive: false },
};

/** Thrown when `Settlement` is not deployed on the requested chain. */
export class SettlementNotAvailableError extends Error {
	constructor(chainId: number) {
		super(`Settlement is not yet deployed on chain ID ${chainId}.`);
		this.name = "SettlementNotAvailableError";
	}
}

/**
 * Returns the `Settlement` contract address for a kawasekit-supported chain.
 *
 * @param chainId - A {@link SupportedChainId}.
 * @returns The `Settlement` address on that chain.
 * @throws {SettlementNotAvailableError} If `Settlement` is not live on the chain.
 *
 * @example
 * ```ts
 * import { getSettlementAddress, polygonAmoy } from "kawasekit";
 *
 * const settlement = getSettlementAddress(polygonAmoy.id);
 * ```
 */
export function getSettlementAddress(chainId: SupportedChainId): Address {
	const deployment = settlementDeployments[chainId];
	if (!deployment.isLive) {
		throw new SettlementNotAvailableError(chainId);
	}
	return deployment.address;
}
