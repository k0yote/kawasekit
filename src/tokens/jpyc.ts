/**
 * JPYC stablecoin metadata, deployments, and ABI.
 *
 * JPYC is a Japanese yen-pegged stablecoin issued by JPYC Inc. under the
 * revised Payment Services Act as 電子決済手段 (electronic payment
 * instrument). The new ("v2") JPYC, launched 2025-10, lives at the same
 * address on every chain where it is deployed.
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

/** ERC-20 decimals for JPYC. Constant across every chain. */
export const JPYC_DECIMALS = 18;

/**
 * EIP-712 domain hint for off-chain authorization signing (EIP-3009, EIP-2612).
 *
 * The real JPYC contract does not expose `version()` publicly — it lives in an
 * `internal VERSION` state variable set during proxy initialization. The
 * canonical value is `"1"`, matching the FiatToken lineage; the
 * {@link signTransferWithAuthorization} helper accepts an override if a future
 * deployment changes this.
 *
 * `name` is "JPY Coin" — the on-chain `name()` value on every live deployment.
 */
export const JPYC_EIP712_DOMAIN_HINT = {
	name: "JPY Coin",
	version: "1",
} as const;

/**
 * Address shared by every live JPYC deployment.
 *
 * Verified on:
 * - Ethereum  : https://etherscan.io/token/0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
 * - Polygon   : https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29
 * - Polygon Amoy : https://amoy.polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29
 * - Avalanche : https://snowtrace.io/token/0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
 *
 * Do NOT confuse with the legacy 前払式支払手段 JPYC at `0x431D5dFF...`.
 */
export const JPYC_V2_ADDRESS: Address = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";

/** A JPYC deployment on a single chain. */
export interface JpycDeployment {
	readonly chainId: SupportedChainId;
	readonly address: Address;
	/** `true` if the token is live on this chain right now. */
	readonly isLive: boolean;
}

/**
 * JPYC deployments keyed by chain.
 *
 * JPYC v2 uses the **same address** (`JPYC_V2_ADDRESS`) on every chain where it
 * is live. `isLive` is the separate "is JPYC actually deployed here yet?" axis.
 * All eight supported chains are live at this address: the four mainnets
 * (Polygon, Kaia, Avalanche, Ethereum) + Amoy + Kairos + Avalanche Fuji +
 * Sepolia. Kaia/Kairos/Avalanche/Fuji/Sepolia were confirmed by a read-only
 * on-chain check (`name() == "JPY Coin"`, `symbol() == "JPYC"` at `0xE7C3…`,
 * 2026-05-31); Polygon/Amoy/Ethereum are established. `isLive: false` + the
 * {@link JpycNotAvailableError} path remain for any future chain added before
 * its JPYC deployment lands.
 */
export const jpycDeployments: { readonly [chainId in SupportedChainId]: JpycDeployment } = {
	[polygon.id]: { chainId: polygon.id, address: JPYC_V2_ADDRESS, isLive: true },
	[polygonAmoy.id]: { chainId: polygonAmoy.id, address: JPYC_V2_ADDRESS, isLive: true },
	[kaia.id]: { chainId: kaia.id, address: JPYC_V2_ADDRESS, isLive: true },
	[kairos.id]: { chainId: kairos.id, address: JPYC_V2_ADDRESS, isLive: true },
	[avalanche.id]: { chainId: avalanche.id, address: JPYC_V2_ADDRESS, isLive: true },
	[ethereum.id]: { chainId: ethereum.id, address: JPYC_V2_ADDRESS, isLive: true },
	[avalancheFuji.id]: { chainId: avalancheFuji.id, address: JPYC_V2_ADDRESS, isLive: true },
	[sepolia.id]: { chainId: sepolia.id, address: JPYC_V2_ADDRESS, isLive: true },
};

/**
 * Thrown when JPYC is not deployed on the requested chain.
 *
 * Today this is unreachable (every {@link SupportedChainId} has a live
 * deployment), but the error class is exported for future chains (Kaia) where
 * JPYC is still in development.
 */
export class JpycNotAvailableError extends Error {
	constructor(chainId: number) {
		super(`JPYC is not yet deployed on chain ID ${chainId}.`);
		this.name = "JpycNotAvailableError";
	}
}

/**
 * Returns the JPYC contract address for a kawasekit-supported chain.
 *
 * @param chainId - A {@link SupportedChainId}.
 * @returns The JPYC contract address on that chain.
 * @throws {JpycNotAvailableError} If JPYC is not live on the chain.
 *
 * @example
 * ```ts
 * import { getJpycAddress, polygonAmoy } from "kawasekit";
 *
 * const address = getJpycAddress(polygonAmoy.id);
 * ```
 */
export function getJpycAddress(chainId: SupportedChainId): Address {
	const deployment = jpycDeployments[chainId];
	if (!deployment.isLive) {
		throw new JpycNotAvailableError(chainId);
	}
	return deployment.address;
}

/**
 * Minimal JPYC ABI: ERC-20 + EIP-3009 surface that kawasekit needs.
 *
 * Excludes permit / mint / blocklist / pause — kawasekit only reads balance,
 * sends `transfer()` via UserOp, and constructs / submits EIP-3009
 * authorizations. Bringing in the full FiatTokenV1 ABI would be wasted bytes.
 */
export const jpycAbi = [
	// ----- ERC-20 read -----
	{
		type: "function",
		name: "name",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
	{
		type: "function",
		name: "symbol",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
	{
		type: "function",
		name: "decimals",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint8" }],
	},
	{
		type: "function",
		name: "totalSupply",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "allowance",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
	// ----- ERC-20 write -----
	{
		type: "function",
		name: "transfer",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "transferFrom",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	// ----- EIP-3009 -----
	{
		type: "function",
		name: "transferWithAuthorization",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "receiveWithAuthorization",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "cancelAuthorization",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "authorizer", type: "address" },
			{ name: "nonce", type: "bytes32" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "authorizationState",
		stateMutability: "view",
		inputs: [
			{ name: "authorizer", type: "address" },
			{ name: "nonce", type: "bytes32" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	// ----- Events kawasekit needs to decode -----
	{
		type: "event",
		name: "Transfer",
		inputs: [
			{ name: "from", type: "address", indexed: true },
			{ name: "to", type: "address", indexed: true },
			{ name: "value", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "Approval",
		inputs: [
			{ name: "owner", type: "address", indexed: true },
			{ name: "spender", type: "address", indexed: true },
			{ name: "value", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "AuthorizationUsed",
		inputs: [
			{ name: "authorizer", type: "address", indexed: true },
			{ name: "nonce", type: "bytes32", indexed: true },
		],
	},
	{
		type: "event",
		name: "AuthorizationCanceled",
		inputs: [
			{ name: "authorizer", type: "address", indexed: true },
			{ name: "nonce", type: "bytes32", indexed: true },
		],
	},
] as const;
