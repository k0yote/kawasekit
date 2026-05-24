import { describe, expect, it } from "vitest";
import {
	decodePaymentRequiredHeader,
	decodePaymentResponseHeader,
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "./encoding";
import { X402InvalidPayloadError } from "./errors";
import type {
	X402PaymentPayload,
	X402PaymentRequiredResponse,
	X402SettlementResponse,
} from "./types";

const STD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const USDC_AMOY_REQUIREMENTS = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000",
	asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 60,
	extra: {
		assetTransferMethod: "eip3009",
		name: "JPY Coin",
		version: "1",
	},
} as const satisfies X402PaymentRequiredResponse["accepts"][number];

const USDC_AMOY: X402PaymentRequiredResponse = {
	x402Version: 2,
	error: "PAYMENT-SIGNATURE header is required",
	resource: {
		url: "https://api.example.com/premium-data",
		description: "Access to premium market data",
		mimeType: "application/json",
	},
	accepts: [USDC_AMOY_REQUIREMENTS],
};

const PAYLOAD: X402PaymentPayload = {
	x402Version: 2,
	resource: { url: "https://api.example.com/premium-data" },
	accepted: USDC_AMOY_REQUIREMENTS,
	payload: {
		signature:
			"0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
		authorization: {
			from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
			to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
			value: "10000",
			validAfter: "1740672089",
			validBefore: "1740672154",
			nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
		},
	},
};

const SETTLEMENT: X402SettlementResponse = {
	success: true,
	transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
	network: "eip155:80002",
	payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
};

describe("header name constants", () => {
	it("match the x402 v2 transport spec verbatim", () => {
		expect(X402_HEADER_PAYMENT_REQUIRED).toBe("PAYMENT-REQUIRED");
		expect(X402_HEADER_PAYMENT_SIGNATURE).toBe("PAYMENT-SIGNATURE");
		expect(X402_HEADER_PAYMENT_RESPONSE).toBe("PAYMENT-RESPONSE");
	});
});

describe("encodePaymentRequiredHeader / decodePaymentRequiredHeader", () => {
	it("roundtrips a representative PAYMENT-REQUIRED payload", () => {
		const encoded = encodePaymentRequiredHeader(USDC_AMOY);
		expect(encoded).toMatch(STD_BASE64);
		expect(decodePaymentRequiredHeader(encoded)).toEqual(USDC_AMOY);
	});

	it("produces output that decodes back to byte-identical JSON", () => {
		const encoded = encodePaymentRequiredHeader(USDC_AMOY);
		const json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		expect(json).toEqual(USDC_AMOY);
	});
});

describe("encodePaymentSignatureHeader / decodePaymentSignatureHeader", () => {
	it("roundtrips a representative PAYMENT-SIGNATURE payload", () => {
		const encoded = encodePaymentSignatureHeader(PAYLOAD);
		expect(encoded).toMatch(STD_BASE64);
		expect(decodePaymentSignatureHeader(encoded)).toEqual(PAYLOAD);
	});

	it("uses standard (not URL-safe) base64 — never emits '-' or '_'", () => {
		const encoded = encodePaymentSignatureHeader(PAYLOAD);
		expect(encoded).not.toMatch(/[-_]/);
	});
});

describe("encodePaymentResponseHeader / decodePaymentResponseHeader", () => {
	it("roundtrips a representative PAYMENT-RESPONSE payload", () => {
		const encoded = encodePaymentResponseHeader(SETTLEMENT);
		expect(encoded).toMatch(STD_BASE64);
		expect(decodePaymentResponseHeader(encoded)).toEqual(SETTLEMENT);
	});

	it("roundtrips a failure response with an empty transaction string", () => {
		const failure: X402SettlementResponse = {
			success: false,
			errorReason: "insufficient_funds",
			transaction: "",
			network: "eip155:80002",
			payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
		};
		const encoded = encodePaymentResponseHeader(failure);
		expect(decodePaymentResponseHeader(encoded)).toEqual(failure);
	});
});

describe("BigInt-safe encoding", () => {
	it("rewrites stray bigint values to their decimal string form", () => {
		// Type-cheat: a caller forgot to convert `value` from bigint to string.
		const payloadOriginal = PAYLOAD.payload as { authorization: Record<string, unknown> };
		const corrupt = {
			...PAYLOAD,
			payload: {
				...PAYLOAD.payload,
				authorization: {
					...payloadOriginal.authorization,
					value: 10_000n,
					validAfter: 1_740_672_089n,
				},
			},
		} as unknown as X402PaymentPayload;

		const encoded = encodePaymentSignatureHeader(corrupt);
		const decoded = decodePaymentSignatureHeader(encoded);
		const auth = (decoded.payload as { authorization: { value: unknown; validAfter: unknown } })
			.authorization;
		expect(auth.value).toBe("10000");
		expect(auth.validAfter).toBe("1740672089");
	});
});

describe("UTF-8 safety", () => {
	it("roundtrips multi-byte characters in string fields", () => {
		const withJapanese: X402PaymentRequiredResponse = {
			...USDC_AMOY,
			resource: {
				url: "https://api.example.com/premium-data",
				description: "プレミアム市場データへのアクセス",
			},
		};
		const encoded = encodePaymentRequiredHeader(withJapanese);
		expect(decodePaymentRequiredHeader(encoded)).toEqual(withJapanese);
	});
});

describe("decoder error handling", () => {
	it("rejects values outside the base64 alphabet", () => {
		expect(() => decodePaymentSignatureHeader("not!base64@here")).toThrow(X402InvalidPayloadError);
	});

	it("rejects URL-safe base64 (contains '-' or '_')", () => {
		const valid = encodePaymentSignatureHeader(PAYLOAD);
		// Swap to URL-safe — alphabet differs, so the regex check fires.
		const urlSafe = valid.replace(/\+/g, "-").replace(/\//g, "_");
		if (urlSafe !== valid) {
			expect(() => decodePaymentSignatureHeader(urlSafe)).toThrow(X402InvalidPayloadError);
		}
	});

	it("rejects valid base64 whose payload is not JSON", () => {
		const garbage = Buffer.from("not json {[", "utf8").toString("base64");
		expect(() => decodePaymentSignatureHeader(garbage)).toThrow(X402InvalidPayloadError);
	});

	it("rejects valid JSON that is not an object", () => {
		for (const nonObject of ["42", '"string"', "null", "[1,2,3]", "true"]) {
			const encoded = Buffer.from(nonObject, "utf8").toString("base64");
			expect(() => decodePaymentSignatureHeader(encoded)).toThrow(X402InvalidPayloadError);
		}
	});

	it("attaches the failing header context to the error", () => {
		try {
			decodePaymentRequiredHeader("!!!");
			throw new Error("should not reach");
		} catch (error) {
			expect(error).toBeInstanceOf(X402InvalidPayloadError);
			expect((error as X402InvalidPayloadError).context).toBe("PAYMENT-REQUIRED");
			expect((error as X402InvalidPayloadError).reason).toMatch(/base64/);
		}
	});
});

describe("encoded golden length", () => {
	it("emits the canonical base64 length for a known fixture", () => {
		// Sanity that we are not accidentally padding-stripping or URL-encoding.
		const json = JSON.stringify(PAYLOAD);
		const expectedLength = 4 * Math.ceil(Buffer.byteLength(json, "utf8") / 3);
		const encoded = encodePaymentSignatureHeader(PAYLOAD);
		expect(encoded.length).toBe(expectedLength);
	});
});
