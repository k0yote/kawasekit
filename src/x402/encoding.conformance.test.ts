/**
 * Conformance tests: kawasekit-encoded payloads must roundtrip through
 * `@x402/core`'s codec without loss, and vice versa.
 *
 * Three fixtures per direction, per header — covering minimal, full-spec, and
 * UTF-8 cases — per the M3 plan's "3 fixture" gate.
 */

import {
	decodePaymentRequiredHeader as coreDecodeRequired,
	decodePaymentResponseHeader as coreDecodeResponse,
	decodePaymentSignatureHeader as coreDecodeSignature,
	encodePaymentRequiredHeader as coreEncodeRequired,
	encodePaymentResponseHeader as coreEncodeResponse,
	encodePaymentSignatureHeader as coreEncodeSignature,
} from "@x402/core/http";
import type {
	PaymentPayload as CorePaymentPayload,
	PaymentRequired as CorePaymentRequired,
	SettleResponse as CoreSettleResponse,
} from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
	decodePaymentRequiredHeader,
	decodePaymentResponseHeader,
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
	encodePaymentSignatureHeader,
} from "./encoding";
import type {
	X402PaymentPayload,
	X402PaymentRequiredResponse,
	X402SettlementResponse,
} from "./types";

// Structural compat is asserted at runtime via byte-identical encode + decode
// roundtrip below. A TS-level `:CorePaymentRequired = ksRequired` assertion
// would fail under `exactOptionalPropertyTypes` because kawasekit uses
// `readonly` arrays whereas `@x402/core` uses mutable arrays — kawasekit is
// strictly stricter, so a `readonly` value cannot widen into a mutable slot.
// Casting via `unknown` (below) is the standard escape hatch and is intentional.

// ---------------------------------------------------------------------------
// Fixtures: 3 PaymentRequired, 3 PaymentPayload, 3 SettlementResponse
// ---------------------------------------------------------------------------

const requirementsAmoyMinimal = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "1000000000000000000",
	asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 300,
	extra: { name: "JPY Coin", version: "1" },
} as const satisfies X402PaymentRequiredResponse["accepts"][number];

const requirementsAmoyFull = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000",
	asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
} as const satisfies X402PaymentRequiredResponse["accepts"][number];

const requirementsPolygonFull = {
	scheme: "exact",
	network: "eip155:137",
	amount: "10000",
	asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
} as const satisfies X402PaymentRequiredResponse["accepts"][number];

const requirementsAmoyUtf8 = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "1000000000000000",
	asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 120,
	extra: { name: "JPY Coin", version: "1", note: "テスト用" },
} as const satisfies X402PaymentRequiredResponse["accepts"][number];

const requiredFixtures: readonly X402PaymentRequiredResponse[] = [
	// Fixture 1: Minimal — just one accepts entry, no error/extensions
	{
		x402Version: 2,
		resource: { url: "https://api.example.com/data" },
		accepts: [requirementsAmoyMinimal],
	},
	// Fixture 2: Full — error message, resource description, multi-accept
	{
		x402Version: 2,
		error: "PAYMENT-SIGNATURE header is required",
		resource: {
			url: "https://api.example.com/weather",
			description: "Real-time weather data",
			mimeType: "application/json",
		},
		accepts: [requirementsAmoyFull, requirementsPolygonFull],
		extensions: {},
	},
	// Fixture 3: UTF-8 — Japanese description in resource
	{
		x402Version: 2,
		resource: {
			url: "https://api.example.com/premium",
			description: "プレミアムAPIアクセス (JPYC 0.001 / call)",
		},
		accepts: [requirementsAmoyUtf8],
	},
];

const payloadFixtures: readonly X402PaymentPayload[] = [
	// Fixture 1: Minimal — no resource, no extensions
	{
		x402Version: 2,
		accepted: requirementsAmoyMinimal,
		payload: {
			signature: `0x${"ab".repeat(65)}`,
			authorization: {
				from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
				to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
				value: "1000000000000000000",
				validAfter: "0",
				validBefore: "1740672154",
				nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
			},
		},
	},
	// Fixture 2: Full — includes resource + extensions
	{
		x402Version: 2,
		resource: {
			url: "https://api.example.com/weather",
			description: "Real-time weather data",
			mimeType: "application/json",
		},
		accepted: requirementsAmoyFull,
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
		extensions: {},
	},
	// Fixture 3: Large uint256 value at the max edge of common balances
	{
		x402Version: 2,
		accepted: requirementsAmoyUtf8,
		payload: {
			signature: `0x${"cd".repeat(65)}`,
			authorization: {
				from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
				to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
				value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
				validAfter: "1",
				validBefore: "99999999999",
				nonce: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			},
		},
	},
];

const settlementFixtures: readonly X402SettlementResponse[] = [
	// Fixture 1: Success — minimal
	{
		success: true,
		transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
		network: "eip155:80002",
		payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
	},
	// Fixture 2: Failure — errorReason + empty tx
	{
		success: false,
		errorReason: "insufficient_funds",
		errorMessage: "client balance 0, required 10000",
		transaction: "",
		network: "eip155:80002",
		payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
	},
	// Fixture 3: Success with amount + extensions
	{
		success: true,
		transaction: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		network: "eip155:137",
		payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
		amount: "10000",
		extensions: {},
	},
];

// ---------------------------------------------------------------------------
// PAYMENT-REQUIRED
// ---------------------------------------------------------------------------

describe("PAYMENT-REQUIRED conformance with @x402/core", () => {
	for (const [i, fixture] of requiredFixtures.entries()) {
		it(`fixture ${i + 1}: kawasekit encode → @x402/core decode is identity`, () => {
			const encoded = encodePaymentRequiredHeader(fixture);
			const decoded = coreDecodeRequired(encoded);
			expect(decoded).toEqual(fixture);
		});

		it(`fixture ${i + 1}: @x402/core encode → kawasekit decode is identity`, () => {
			const encoded = coreEncodeRequired(fixture as unknown as CorePaymentRequired);
			const decoded = decodePaymentRequiredHeader(encoded);
			expect(decoded).toEqual(fixture);
		});

		it(`fixture ${i + 1}: both encoders produce byte-equivalent base64`, () => {
			expect(encodePaymentRequiredHeader(fixture)).toBe(
				coreEncodeRequired(fixture as unknown as CorePaymentRequired),
			);
		});
	}
});

// ---------------------------------------------------------------------------
// PAYMENT-SIGNATURE
// ---------------------------------------------------------------------------

describe("PAYMENT-SIGNATURE conformance with @x402/core", () => {
	for (const [i, fixture] of payloadFixtures.entries()) {
		it(`fixture ${i + 1}: kawasekit encode → @x402/core decode is identity`, () => {
			const encoded = encodePaymentSignatureHeader(fixture);
			const decoded = coreDecodeSignature(encoded);
			expect(decoded).toEqual(fixture);
		});

		it(`fixture ${i + 1}: @x402/core encode → kawasekit decode is identity`, () => {
			const encoded = coreEncodeSignature(fixture as unknown as CorePaymentPayload);
			const decoded = decodePaymentSignatureHeader(encoded);
			expect(decoded).toEqual(fixture);
		});

		it(`fixture ${i + 1}: both encoders produce byte-equivalent base64`, () => {
			expect(encodePaymentSignatureHeader(fixture)).toBe(
				coreEncodeSignature(fixture as unknown as CorePaymentPayload),
			);
		});
	}
});

// ---------------------------------------------------------------------------
// PAYMENT-RESPONSE
// ---------------------------------------------------------------------------

describe("PAYMENT-RESPONSE conformance with @x402/core", () => {
	for (const [i, fixture] of settlementFixtures.entries()) {
		it(`fixture ${i + 1}: kawasekit encode → @x402/core decode is identity`, () => {
			const encoded = encodePaymentResponseHeader(fixture);
			const decoded = coreDecodeResponse(encoded);
			expect(decoded).toEqual(fixture);
		});

		it(`fixture ${i + 1}: @x402/core encode → kawasekit decode is identity`, () => {
			const encoded = coreEncodeResponse(fixture as unknown as CoreSettleResponse);
			const decoded = decodePaymentResponseHeader(encoded);
			expect(decoded).toEqual(fixture);
		});

		it(`fixture ${i + 1}: both encoders produce byte-equivalent base64`, () => {
			expect(encodePaymentResponseHeader(fixture)).toBe(
				coreEncodeResponse(fixture as unknown as CoreSettleResponse),
			);
		});
	}
});
