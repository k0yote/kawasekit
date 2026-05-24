import { describe, expect, it, vi } from "vitest";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import {
	decodePaymentRequiredHeader,
	decodePaymentResponseHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "./encoding";
import { createX402Handler, type X402HandlerContext } from "./server";
import type {
	Facilitator,
	X402PaymentPayload,
	X402PaymentRequirements,
	X402SettleResponse,
	X402VerifyResponse,
} from "./types";

const REQS: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000",
	asset: JPYC_V2_ADDRESS,
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
};

const PAYLOAD: X402PaymentPayload = {
	x402Version: 2,
	accepted: REQS,
	payload: {
		signature: `0x${"ab".repeat(65)}`,
		authorization: {
			from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
			to: REQS.payTo,
			value: REQS.amount,
			validAfter: "0",
			validBefore: "9999999999",
			nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
		},
	},
};

const SETTLEMENT_OK: X402SettleResponse = {
	success: true,
	transaction: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	network: "eip155:80002",
	payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
	amount: REQS.amount,
};

function stubFacilitator(overrides: Partial<Facilitator> = {}): Facilitator {
	return {
		verify: vi.fn(async () => ({ isValid: true }) satisfies X402VerifyResponse),
		settle: vi.fn(async () => SETTLEMENT_OK),
		supported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })),
		...overrides,
	};
}

function jsonResponse<T>(body: T, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("createX402Handler — pass-through (no requirements)", () => {
	it("invokes inner handler with null context when requirementsFor returns null", async () => {
		const innerHandler = vi.fn(async (_req: Request, ctx: X402HandlerContext | null) => {
			expect(ctx).toBeNull();
			return jsonResponse({ ok: true });
		});
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => null,
			handler: innerHandler,
		});
		const response = await handler(new Request("https://api.example.com/free"));
		expect(response.status).toBe(200);
		expect(innerHandler).toHaveBeenCalledTimes(1);
	});

	it("treats an empty requirements array the same as null", async () => {
		const innerHandler = vi.fn(async () => jsonResponse({ ok: true }));
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [],
			handler: innerHandler,
		});
		const response = await handler(new Request("https://api.example.com/free"));
		expect(response.status).toBe(200);
		expect(innerHandler).toHaveBeenCalledOnce();
	});
});

describe("createX402Handler — 402 issuance", () => {
	it("returns 402 with PAYMENT-REQUIRED header when PAYMENT-SIGNATURE is missing", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(new Request("https://api.example.com/weather"));

		expect(response.status).toBe(402);
		expect(response.headers.get("content-type")).toBe("application/json");
		const headerValue = response.headers.get(X402_HEADER_PAYMENT_REQUIRED);
		expect(headerValue).not.toBeNull();
		const required = decodePaymentRequiredHeader(headerValue!);
		expect(required.x402Version).toBe(2);
		expect(required.accepts).toEqual([REQS]);
		expect(required.resource).toEqual({ url: "https://api.example.com/weather" });
		expect(required.error).toBe("PAYMENT-SIGNATURE header is required");

		const body = JSON.parse(await response.text());
		expect(body).toEqual(required);
	});

	it("returns 402 with a decode-reason error when PAYMENT-SIGNATURE is malformed", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: "!@#$%" },
			}),
		);
		expect(response.status).toBe(402);
		const required = decodePaymentRequiredHeader(
			response.headers.get(X402_HEADER_PAYMENT_REQUIRED)!,
		);
		expect(required.error).toMatch(/base64|payload/);
	});

	it("returns 402 when paymentPayload.accepted does not match any offered requirements", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const wrongAccepted: X402PaymentPayload = {
			...PAYLOAD,
			accepted: { ...REQS, amount: "99999" },
		};
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(wrongAccepted) },
			}),
		);
		expect(response.status).toBe(402);
		const required = decodePaymentRequiredHeader(
			response.headers.get(X402_HEADER_PAYMENT_REQUIRED)!,
		);
		expect(required.error).toMatch(/does not match/);
	});

	it("returns 402 with verify's invalidReason when verify fails", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator({
				verify: async () =>
					({ isValid: false, invalidReason: "insufficient_funds" }) satisfies X402VerifyResponse,
			}),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.status).toBe(402);
		const required = decodePaymentRequiredHeader(
			response.headers.get(X402_HEADER_PAYMENT_REQUIRED)!,
		);
		expect(required.error).toBe("insufficient_funds");
	});

	it("returns 402 with settle's errorReason when settle fails", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator({
				settle: async () =>
					({
						success: false,
						errorReason: "invalid_transaction_state",
						transaction: "",
						network: REQS.network,
					}) satisfies X402SettleResponse,
			}),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.status).toBe(402);
		const required = decodePaymentRequiredHeader(
			response.headers.get(X402_HEADER_PAYMENT_REQUIRED)!,
		);
		expect(required.error).toBe("invalid_transaction_state");
	});

	it("uses resourceFor override when provided", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			resourceFor: () => ({
				url: "https://api.example.com/weather",
				description: "Real-time weather",
				mimeType: "application/json",
			}),
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(new Request("https://api.example.com/weather"));
		const required = decodePaymentRequiredHeader(
			response.headers.get(X402_HEADER_PAYMENT_REQUIRED)!,
		);
		expect(required.resource).toEqual({
			url: "https://api.example.com/weather",
			description: "Real-time weather",
			mimeType: "application/json",
		});
	});
});

describe("createX402Handler — 500 propagation", () => {
	it("returns 500 when facilitator.verify throws", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator({
				verify: async () => {
					throw new Error("boom-verify");
				},
			}),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.status).toBe(500);
		const body = JSON.parse(await response.text());
		expect(body.error).toBe("facilitator_verify_failed");
		expect(body.message).toContain("boom-verify");
	});

	it("returns 500 when facilitator.settle throws", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator({
				settle: async () => {
					throw new Error("boom-settle");
				},
			}),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.status).toBe(500);
		const body = JSON.parse(await response.text());
		expect(body.error).toBe("facilitator_settle_failed");
	});

	it("returns 500 when requirementsFor throws", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => {
				throw new Error("boom-req");
			},
			handler: async () => jsonResponse({ never: "reached" }),
		});
		const response = await handler(new Request("https://api.example.com/x"));
		expect(response.status).toBe(500);
		const body = JSON.parse(await response.text());
		expect(body.error).toBe("requirements_resolution_failed");
	});
});

describe("createX402Handler — happy path", () => {
	it("invokes inner handler with context and attaches PAYMENT-RESPONSE header", async () => {
		let received: X402HandlerContext | null = null;
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async (_req, ctx) => {
				received = ctx;
				return jsonResponse({ weather: "sunny" });
			},
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.status).toBe(200);
		const responseHeader = response.headers.get(X402_HEADER_PAYMENT_RESPONSE);
		expect(responseHeader).not.toBeNull();
		const decodedSettlement = decodePaymentResponseHeader(responseHeader!);
		expect(decodedSettlement).toEqual(SETTLEMENT_OK);
		expect(received).not.toBeNull();
		expect(received!.paymentPayload).toEqual(PAYLOAD);
		expect(received!.matchedRequirements).toBe(REQS);
		expect(received!.settlement).toEqual(SETTLEMENT_OK);
		const body = JSON.parse(await response.text());
		expect(body).toEqual({ weather: "sunny" });
	});

	it("preserves inner handler's status code (404, 500, etc.) while still attaching PAYMENT-RESPONSE", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async () =>
				new Response("Not Found", {
					status: 404,
					headers: { "content-type": "text/plain" },
				}),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.status).toBe(404);
		expect(response.headers.get(X402_HEADER_PAYMENT_RESPONSE)).not.toBeNull();
		expect(await response.text()).toBe("Not Found");
	});

	it("preserves inner handler's other headers (e.g. caching)", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async () =>
				new Response(JSON.stringify({ ok: true }), {
					headers: {
						"content-type": "application/json",
						"cache-control": "public, max-age=300",
					},
				}),
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get(X402_HEADER_PAYMENT_RESPONSE)).not.toBeNull();
	});

	it("preserves streaming response bodies", async () => {
		const handler = createX402Handler({
			facilitator: stubFacilitator(),
			requirementsFor: () => [REQS],
			handler: async () => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("chunk-1 "));
						controller.enqueue(new TextEncoder().encode("chunk-2"));
						controller.close();
					},
				});
				return new Response(stream, { headers: { "content-type": "text/plain" } });
			},
		});
		const response = await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(await response.text()).toBe("chunk-1 chunk-2");
	});
});

describe("createX402Handler — facilitator integration", () => {
	it("forwards the chosen requirements to verify() and settle()", async () => {
		const verifySpy = vi.fn(async () => ({ isValid: true }) satisfies X402VerifyResponse);
		const settleSpy = vi.fn(async () => SETTLEMENT_OK);
		const handler = createX402Handler({
			facilitator: stubFacilitator({ verify: verifySpy, settle: settleSpy }),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ ok: true }),
		});
		await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(verifySpy).toHaveBeenCalledWith({
			x402Version: 2,
			paymentPayload: PAYLOAD,
			paymentRequirements: REQS,
		});
		expect(settleSpy).toHaveBeenCalledWith({
			x402Version: 2,
			paymentPayload: PAYLOAD,
			paymentRequirements: REQS,
		});
	});

	it("calls settle only after verify succeeds (skips settle on verify failure)", async () => {
		const settleSpy = vi.fn(async () => SETTLEMENT_OK);
		const handler = createX402Handler({
			facilitator: stubFacilitator({
				verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }),
				settle: settleSpy,
			}),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ ok: true }),
		});
		await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(settleSpy).not.toHaveBeenCalled();
	});

	it("picks the matching offered requirements when multiple are offered", async () => {
		const cheap: X402PaymentRequirements = { ...REQS, amount: "1000" };
		const expensive: X402PaymentRequirements = { ...REQS, amount: "50000" };
		const chosen: X402PaymentRequirements = { ...REQS, amount: "1000" };
		const verifySpy = vi.fn(async () => ({ isValid: true }) satisfies X402VerifyResponse);
		const handler = createX402Handler({
			facilitator: stubFacilitator({ verify: verifySpy }),
			requirementsFor: () => [cheap, expensive],
			handler: async () => jsonResponse({ ok: true }),
		});
		const payload: X402PaymentPayload = {
			...PAYLOAD,
			accepted: chosen,
			payload: {
				...PAYLOAD.payload,
				authorization: {
					...(PAYLOAD.payload as { authorization: object }).authorization,
					value: "1000",
				},
			},
		};
		await handler(
			new Request("https://api.example.com/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(payload) },
			}),
		);
		expect(verifySpy).toHaveBeenCalledWith({
			x402Version: 2,
			paymentPayload: payload,
			paymentRequirements: cheap,
		});
	});
});
