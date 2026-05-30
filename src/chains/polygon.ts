import { polygon as viemPolygon, polygonAmoy as viemPolygonAmoy } from "viem/chains";
import type { KawaseChain } from "./types";

/**
 * Polygon mainnet — priority 1 production chain.
 *
 * Built on viem's `polygon` definition (official RPC URLs, block explorers,
 * and `POL` native currency) plus kawasekit metadata. Polygon PoS is
 * probabilistic; the default `4` confirmations ≈ ~8 s of soft finality.
 */
export const polygon = {
	...viemPolygon,
	isTestnet: false,
	defaultConfirmations: 4,
	blockTimeMs: 2_000,
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
	defaultConfirmations: 1,
	blockTimeMs: 2_000,
} satisfies KawaseChain;
