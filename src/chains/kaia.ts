import { kaia as viemKaia, kairos as viemKairos } from "viem/chains";
import type { KawaseChain } from "./types";

/**
 * Kaia mainnet — priority 2 production chain.
 *
 * Kaia (Klaytn + Finschia) runs IBFT consensus with **immediate finality** — a
 * single confirmed block is final — so `defaultConfirmations` is `1` (do NOT
 * copy Polygon's `4`). JPYC is live at the same address as the other chains
 * (`src/tokens/jpyc.ts`).
 *
 * Note: ZeroDev does not support Kaia, so the **smart-account path** (session
 * keys, sponsored UserOps) is not yet available here — it is planned via
 * Pimlico (M5-3 Phase 2). The **x402 EOA-payer path** works today.
 */
export const kaia = {
	...viemKaia,
	isTestnet: false,
	defaultConfirmations: 1,
	blockTimeMs: 1_000,
} satisfies KawaseChain;

/**
 * Kairos — Kaia testnet. JPYC is available via the Kaia faucet at the same
 * address as mainnet; suitable for the same Amoy→Polygon-style testnet→mainnet
 * verification pattern.
 */
export const kairos = {
	...viemKairos,
	isTestnet: true,
	defaultConfirmations: 1,
	blockTimeMs: 1_000,
} satisfies KawaseChain;
