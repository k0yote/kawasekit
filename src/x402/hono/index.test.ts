import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { JPYC_V2_ADDRESS } from "../../tokens/jpyc";
import {
	decodePaymentRequiredHeader,
	decodePaymentResponseHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "../encoding";
import type { X402HandlerContext } from "../server";
import type {
	Facilitator,
	X402PaymentPayload,
	X402PaymentRequirements,
	X402SettleResponse,
	X402VerifyResponse,
} from "../types";
import { X402_HONO_CONTEXT_KEY, type X402HonoEnv, x402Middleware } from "./index";

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

describe("x402Middleware — pass-through", () => {
	it("forwards to the route when requirementsFor returns null", async () => {
		const routeSpy = vi.fn((c) => c.json({ free: true }));
		const app = new Hono();
		app.use(
			"*",
			x402Middleware({
				facilitator: stubFacilitator(),
				requirementsFor: () => null,
			}),
		);
		app.get("/free", routeSpy);

		const res = await app.fetch(new Request("http://x/free"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ free: true });
		expect(routeSpy).toHaveBeenCalledOnce();
		expect(res.headers.get(X402_HEADER_PAYMENT_RESPONSE)).toBeNull();
	});
});

describe("x402Middleware — 402 issuance", () => {
	it("returns 402 with PAYMENT-REQUIRED header when PAYMENT-SIGNATURE is missing", async () => {
		const routeSpy = vi.fn((c) => c.json({ never: "reached" }));
		const app = new Hono();
		app.use(
			"*",
			x402Middleware({
				facilitator: stubFacilitator(),
				requirementsFor: () => [REQS],
			}),
		);
		app.get("/weather", routeSpy);

		const res = await app.fetch(new Request("http://x/weather"));
		expect(res.status).toBe(402);
		expect(routeSpy).not.toHaveBeenCalled();
		const headerValue = res.headers.get(X402_HEADER_PAYMENT_REQUIRED);
		expect(headerValue).not.toBeNull();
		const required = decodePaymentRequiredHeader(headerValue!);
		expect(required.accepts).toEqual([REQS]);
		expect(required.error).toBe("PAYMENT-SIGNATURE header is required");
	});

	it("returns 402 when facilitator.verify rejects (route is not invoked)", async () => {
		const routeSpy = vi.fn((c) => c.json({ never: "reached" }));
		const app = new Hono();
		app.use(
			"*",
			x402Middleware({
				facilitator: stubFacilitator({
					verify: async () =>
						({ isValid: false, invalidReason: "insufficient_funds" }) satisfies X402VerifyResponse,
				}),
				requirementsFor: () => [REQS],
			}),
		);
		app.get("/weather", routeSpy);

		const res = await app.fetch(
			new Request("http://x/weather", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(res.status).toBe(402);
		expect(routeSpy).not.toHaveBeenCalled();
		const required = decodePaymentRequiredHeader(res.headers.get(X402_HEADER_PAYMENT_REQUIRED)!);
		expect(required.error).toBe("insufficient_funds");
	});
});

describe("x402Middleware — settled happy path", () => {
	it("invokes the route, exposes ctx via c.get('x402'), attaches PAYMENT-RESPONSE", async () => {
		let received: X402HandlerContext | undefined;
		const app = new Hono<X402HonoEnv>();
		app.use(
			"/weather/*",
			x402Middleware({
				facilitator: stubFacilitator(),
				requirementsFor: () => [REQS],
			}),
		);
		app.get("/weather/:city", (c) => {
			received = c.get(X402_HONO_CONTEXT_KEY);
			return c.json({ city: c.req.param("city"), weather: "sunny" });
		});

		const res = await app.fetch(
			new Request("http://x/weather/Tokyo", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ city: "Tokyo", weather: "sunny" });

		const responseHeader = res.headers.get(X402_HEADER_PAYMENT_RESPONSE);
		expect(responseHeader).not.toBeNull();
		expect(decodePaymentResponseHeader(responseHeader!)).toEqual(SETTLEMENT_OK);

		expect(received).not.toBeUndefined();
		expect(received?.paymentPayload).toEqual(PAYLOAD);
		expect(received?.settlement).toEqual(SETTLEMENT_OK);
	});

	it("preserves route's status code and content-type", async () => {
		const app = new Hono();
		app.use(
			"*",
			x402Middleware({
				facilitator: stubFacilitator(),
				requirementsFor: () => [REQS],
			}),
		);
		app.get("/x", (c) => c.text("not found", 404));

		const res = await app.fetch(
			new Request("http://x/x", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("not found");
		expect(res.headers.get(X402_HEADER_PAYMENT_RESPONSE)).not.toBeNull();
	});

	it("supports a custom contextKey", async () => {
		let receivedUnderDefault: unknown;
		let receivedUnderCustom: unknown;
		const app = new Hono<{
			Variables: { x402?: X402HandlerContext; payment?: X402HandlerContext };
		}>();
		app.use(
			"*",
			x402Middleware({
				facilitator: stubFacilitator(),
				requirementsFor: () => [REQS],
				contextKey: "payment",
			}),
		);
		app.get("/x", (c) => {
			receivedUnderDefault = c.get(X402_HONO_CONTEXT_KEY);
			receivedUnderCustom = c.get("payment");
			return c.json({ ok: true });
		});

		await app.fetch(
			new Request("http://x/x", {
				headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(PAYLOAD) },
			}),
		);
		expect(receivedUnderDefault).toBeUndefined();
		expect(receivedUnderCustom).not.toBeUndefined();
	});
});

describe("x402Middleware — route-scoped mounting", () => {
	it("does not paywall sibling routes when mounted on a specific path", async () => {
		const app = new Hono();
		app.use(
			"/paid/*",
			x402Middleware({
				facilitator: stubFacilitator(),
				requirementsFor: () => [REQS],
			}),
		);
		app.get("/paid/data", (c) => c.json({ data: "paid" }));
		app.get("/free/data", (c) => c.json({ data: "free" }));

		const paidNoSig = await app.fetch(new Request("http://x/paid/data"));
		expect(paidNoSig.status).toBe(402);

		const freeNoSig = await app.fetch(new Request("http://x/free/data"));
		expect(freeNoSig.status).toBe(200);
		expect(await freeNoSig.json()).toEqual({ data: "free" });
	});
});
