import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { polygon, polygonAmoy } from "../chains";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { X402InvalidPayloadError } from "./errors";
import {
	buildPaymentRequiredResponse,
	buildPaymentRequirements,
	X402_DEFAULT_MAX_TIMEOUT_SECONDS,
} from "./payment-requirements";

const PAY_TO: Address = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

describe("buildPaymentRequirements — happy path", () => {
	it("builds a JPYC-on-Amoy requirements with sensible defaults", () => {
		const r = buildPaymentRequirements({
			chainId: polygonAmoy.id,
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			amount: 10_000n,
		});
		expect(r).toEqual({
			scheme: "exact",
			network: "eip155:80002",
			amount: "10000",
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			maxTimeoutSeconds: X402_DEFAULT_MAX_TIMEOUT_SECONDS,
			extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
		});
	});

	it("builds a JPYC-on-Polygon-mainnet requirements", () => {
		const r = buildPaymentRequirements({
			chainId: polygon.id,
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			amount: 10_000n,
		});
		expect(r.network).toBe("eip155:137");
	});

	it("accepts amount as a decimal string", () => {
		const r = buildPaymentRequirements({
			chainId: polygonAmoy.id,
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			amount: "10000",
		});
		expect(r.amount).toBe("10000");
	});

	it("emits amount as a string regardless of bigint input", () => {
		const r = buildPaymentRequirements({
			chainId: polygonAmoy.id,
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			amount: 10n ** 18n,
		});
		expect(r.amount).toBe("1000000000000000000");
		expect(typeof r.amount).toBe("string");
	});

	it("honors explicit maxTimeoutSeconds override", () => {
		const r = buildPaymentRequirements({
			chainId: polygonAmoy.id,
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			amount: 1n,
			maxTimeoutSeconds: 300,
		});
		expect(r.maxTimeoutSeconds).toBe(300);
	});

	it("honors explicit `extra` and does NOT merge with the JPYC default", () => {
		const r = buildPaymentRequirements({
			chainId: polygonAmoy.id,
			asset: JPYC_V2_ADDRESS,
			payTo: PAY_TO,
			amount: 1n,
			extra: { name: "Custom JPYC", version: "9", custom: true },
		});
		expect(r.extra).toEqual({ name: "Custom JPYC", version: "9", custom: true });
	});
});

describe("buildPaymentRequirements — validation", () => {
	it("rejects amount === 0n", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: JPYC_V2_ADDRESS,
				payTo: PAY_TO,
				amount: 0n,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects negative bigint amount", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: JPYC_V2_ADDRESS,
				payTo: PAY_TO,
				amount: -1n,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects non-decimal amount string", () => {
		for (const bad of ["", "0x10", "1.5", "-100", " 100 ", "01"]) {
			expect(() =>
				buildPaymentRequirements({
					chainId: polygonAmoy.id,
					asset: JPYC_V2_ADDRESS,
					payTo: PAY_TO,
					amount: bad,
				}),
			).toThrow(X402InvalidPayloadError);
		}
	});

	it("rejects amount string === '0'", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: JPYC_V2_ADDRESS,
				payTo: PAY_TO,
				amount: "0",
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects amount > uint256 max (bigint)", () => {
		const overflow = 1n << 256n;
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: JPYC_V2_ADDRESS,
				payTo: PAY_TO,
				amount: overflow,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects bad asset address", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: "0xdeadbeef" as Address,
				payTo: PAY_TO,
				amount: 1n,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects bad payTo address", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: JPYC_V2_ADDRESS,
				payTo: "not-an-address" as Address,
				amount: 1n,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects maxTimeoutSeconds <= 0", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: JPYC_V2_ADDRESS,
				payTo: PAY_TO,
				amount: 1n,
				maxTimeoutSeconds: 0,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("rejects non-JPYC asset without extra (caller must provide domain info)", () => {
		expect(() =>
			buildPaymentRequirements({
				chainId: polygonAmoy.id,
				asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				payTo: PAY_TO,
				amount: 1n,
			}),
		).toThrow(X402InvalidPayloadError);
	});

	it("accepts non-JPYC asset when extra is provided", () => {
		const r = buildPaymentRequirements({
			chainId: polygonAmoy.id,
			asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			payTo: PAY_TO,
			amount: 1n,
			extra: { name: "USDC", version: "2" },
		});
		expect(r.extra).toEqual({ name: "USDC", version: "2" });
	});
});

describe("buildPaymentRequiredResponse", () => {
	const requirement = {
		scheme: "exact",
		network: "eip155:80002",
		amount: "10000",
		asset: JPYC_V2_ADDRESS,
		payTo: PAY_TO,
		maxTimeoutSeconds: 60,
		extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
	} as const;

	it("wraps a single requirement with x402Version 2", () => {
		const response = buildPaymentRequiredResponse({
			resource: { url: "https://api.example.com/data" },
			accepts: [requirement],
		});
		expect(response.x402Version).toBe(2);
		expect(response.accepts).toEqual([requirement]);
		expect(response.resource).toEqual({ url: "https://api.example.com/data" });
	});

	it("includes error string when provided", () => {
		const response = buildPaymentRequiredResponse({
			resource: { url: "https://api.example.com/data" },
			accepts: [requirement],
			error: "PAYMENT-SIGNATURE header is required",
		});
		expect(response.error).toBe("PAYMENT-SIGNATURE header is required");
	});

	it("includes extensions object when provided", () => {
		const response = buildPaymentRequiredResponse({
			resource: { url: "https://api.example.com/data" },
			accepts: [requirement],
			extensions: { myExt: { foo: "bar" } },
		});
		expect(response.extensions).toEqual({ myExt: { foo: "bar" } });
	});

	it("omits optional fields when not provided (exactOptionalPropertyTypes)", () => {
		const response = buildPaymentRequiredResponse({
			resource: { url: "https://api.example.com/data" },
			accepts: [requirement],
		});
		expect("error" in response).toBe(false);
		expect("extensions" in response).toBe(false);
	});

	it("includes both error and extensions when both are provided", () => {
		const response = buildPaymentRequiredResponse({
			resource: { url: "https://api.example.com/data" },
			accepts: [requirement],
			error: "boom",
			extensions: { x: 1 },
		});
		expect(response.error).toBe("boom");
		expect(response.extensions).toEqual({ x: 1 });
	});

	it("rejects empty accepts array", () => {
		expect(() =>
			buildPaymentRequiredResponse({
				resource: { url: "https://api.example.com/data" },
				accepts: [],
			}),
		).toThrow(X402InvalidPayloadError);
	});
});
