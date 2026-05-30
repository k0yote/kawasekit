import { describe, expect, it } from "vitest";
import { getJpycAddress, JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { deriveReceiptTimeoutMs } from "../x402/facilitator";
import {
	avalanche,
	avalancheFuji,
	ChainNotSupportedError,
	ethereum,
	getChain,
	isSupportedChainId,
	kaia,
	kairos,
	polygon,
	polygonAmoy,
	sepolia,
	supportedChains,
} from "./index";

const BASE_CHAIN_ID = 8453; // a real chain kawasekit does NOT support

describe("supportedChains registry", () => {
	it("lists the eight chains in priority order", () => {
		expect(supportedChains.map((c) => c.id)).toEqual([
			137, 80002, 8217, 1001, 43114, 43113, 1, 11155111,
		]);
	});

	it("resolves every supported id via getChain and rejects others", () => {
		for (const chain of supportedChains) {
			expect(getChain(chain.id).id).toBe(chain.id);
			expect(isSupportedChainId(chain.id)).toBe(true);
		}
		expect(isSupportedChainId(BASE_CHAIN_ID)).toBe(false);
		expect(() => getChain(BASE_CHAIN_ID)).toThrow(ChainNotSupportedError);
	});
});

describe("per-chain finality config-as-data", () => {
	it("sets chain-appropriate defaultConfirmations (not copied from Polygon)", () => {
		expect(polygon.defaultConfirmations).toBe(4); // probabilistic
		expect(ethereum.defaultConfirmations).toBe(32); // epoch finality — must be deep
		expect(avalanche.defaultConfirmations).toBe(2); // Snowman deterministic
		expect(kaia.defaultConfirmations).toBe(1); // IBFT immediate finality
		// Deterministic-finality chains must NOT inherit Polygon's depth.
		expect(kaia.defaultConfirmations).toBeLessThan(polygon.defaultConfirmations);
		expect(avalanche.defaultConfirmations).toBeLessThan(polygon.defaultConfirmations);
		// Ethereum must be far deeper than Polygon.
		expect(ethereum.defaultConfirmations).toBeGreaterThan(polygon.defaultConfirmations);
	});

	it("carries a positive block time for every chain", () => {
		for (const chain of supportedChains) {
			expect(chain.blockTimeMs).toBeGreaterThan(0);
		}
		expect(kaia.blockTimeMs).toBe(1_000);
		expect(ethereum.blockTimeMs).toBe(12_000);
	});

	it("flags testnets correctly", () => {
		expect(kaia.isTestnet).toBe(false);
		expect(kairos.isTestnet).toBe(true);
		expect(ethereum.isTestnet).toBe(false);
		expect(sepolia.isTestnet).toBe(true);
	});
});

describe("JPYC deployments across chains", () => {
	it("returns the shared JPYC address on every supported chain (same address everywhere)", () => {
		for (const chain of supportedChains) {
			expect(getJpycAddress(chain.id)).toBe(JPYC_V2_ADDRESS);
		}
	});

	it("returns the address on Fuji / Sepolia too (JPYC verified live on-chain, 2026-05-31)", () => {
		// Read-only on-chain check found name "JPY Coin" / symbol "JPYC" at 0xE7C3
		// on both — the earlier isLive:false was too conservative.
		expect(getJpycAddress(avalancheFuji.id)).toBe(JPYC_V2_ADDRESS);
		expect(getJpycAddress(sepolia.id)).toBe(JPYC_V2_ADDRESS);
	});
});

describe("deriveReceiptTimeoutMs (chain-aware settle timeout)", () => {
	it("keeps the 60 s floor for shallow chains (no regression for Polygon)", () => {
		expect(deriveReceiptTimeoutMs(polygon, 4)).toBe(60_000);
		expect(deriveReceiptTimeoutMs(polygonAmoy, 1)).toBe(60_000);
		expect(deriveReceiptTimeoutMs(kaia, 1)).toBe(60_000);
	});

	it("auto-sizes above the floor for deep-confirmation Ethereum (no default timeout)", () => {
		// 15_000 + 32 × 12_000 × 1.5 = 591_000
		expect(deriveReceiptTimeoutMs(ethereum, 32)).toBe(591_000);
		expect(deriveReceiptTimeoutMs(ethereum, 32)).toBeGreaterThan(60_000);
	});

	it("scales with an operator's confirmations override", () => {
		expect(deriveReceiptTimeoutMs(polygon, 256)).toBeGreaterThan(
			deriveReceiptTimeoutMs(polygon, 64),
		);
	});
});
