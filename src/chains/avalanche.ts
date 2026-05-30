import { avalanche as viemAvalanche, avalancheFuji as viemAvalancheFuji } from "viem/chains";
import type { KawaseChain } from "./types";

/**
 * Avalanche C-Chain — priority 3 production chain.
 *
 * Snowman BFT gives sub-`2 s` **deterministic finality**, so
 * `defaultConfirmations` of `2` is ample — deep confirmations add latency for
 * no extra safety. JPYC is live at the same address as the other chains.
 *
 * The x402 EOA-payer path works today; the smart-account path via ZeroDev is
 * not yet verified on Avalanche.
 */
export const avalanche = {
	...viemAvalanche,
	isTestnet: false,
	defaultConfirmations: 2,
	blockTimeMs: 2_000,
} satisfies KawaseChain;

/**
 * Avalanche Fuji testnet.
 *
 * ⚠️ JPYC presence on Fuji is **unverified** — `jpycDeployments` marks it
 * `isLive: false`, so `getJpycAddress(avalancheFuji.id)` throws
 * {@link JpycNotAvailableError} until a deployment is confirmed. The chain
 * config ships for completeness; x402 cannot settle here without JPYC.
 */
export const avalancheFuji = {
	...viemAvalancheFuji,
	isTestnet: true,
	defaultConfirmations: 1,
	blockTimeMs: 2_000,
} satisfies KawaseChain;
