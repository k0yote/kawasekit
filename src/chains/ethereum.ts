import { mainnet as viemMainnet, sepolia as viemSepolia } from "viem/chains";
import type { KawaseChain } from "./types";

/**
 * Ethereum mainnet — priority 4 production chain (institutional use cases).
 *
 * Casper FFG finalises in epochs (~12.8 min). `defaultConfirmations` of `32`
 * (~6.4 min at ~12 s blocks) gives finalised-grade safety. **Do NOT use
 * Polygon's `4` here** — 4 blocks (~48 s) is nowhere near finalised, and would
 * re-open the settle-reorg gap (threat 2.8). The facilitator auto-sizes
 * `receiptTimeoutMs` from this depth (~10 min), so the default does not time
 * out. JPYC is live at the same address as the other chains.
 */
export const ethereum = {
	...viemMainnet,
	isTestnet: false,
	defaultConfirmations: 32,
	blockTimeMs: 12_000,
} satisfies KawaseChain;

/**
 * Sepolia — Ethereum testnet.
 *
 * ⚠️ JPYC presence on Sepolia is **unverified** — `jpycDeployments` marks it
 * `isLive: false`, so `getJpycAddress(sepolia.id)` throws until a deployment is
 * confirmed. The chain config ships for completeness.
 */
export const sepolia = {
	...viemSepolia,
	isTestnet: true,
	defaultConfirmations: 4,
	blockTimeMs: 12_000,
} satisfies KawaseChain;
