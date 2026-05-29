/**
 * Reasoning-step idempotency wire-up tests (M5-1, threat 1.8b / 1.8c / §6.1).
 *
 * Covers the §6.1 scenarios with a stub facilitator (no chain): identical
 * re-send replay, disable, header-keyed dedup across differing signatures (H1),
 * cross-tenant isolation, concurrent TOCTOU, plus the client-side derived nonce
 * (Half B) and the wrapFetch header.
 */
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryIdempotencyStore } from "../idempotency";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { createX402PaymentSigner } from "./client";
import {
	decodePaymentRequiredHeader,
	encodePaymentRequiredHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_IDEMPOTENCY_KEY,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "./encoding";
import { wrapFetch } from "./fetch";
import { buildPaymentRequiredResponse } from "./payment-requirements";
import { createX402Handler } from "./server";
import type {
	Facilitator,
	X402PaymentPayload,
	X402PaymentRequirements,
	X402SettleResponse,
	X402VerifyResponse,
} from "./types";

// Anvil/Foundry well-known test key 0.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const REQS: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000",
	asset: JPYC_V2_ADDRESS,
	payTo: getAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C"),
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
};

const SETTLEMENT_OK: X402SettleResponse = {
	success: true,
	transaction: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	network: "eip155:80002",
	payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
	amount: REQS.amount,
};

function payloadWith(nonce: string, accepted: X402PaymentRequirements = REQS): X402PaymentPayload {
	return {
		x402Version: 2,
		accepted,
		payload: {
			signature: `0x${"ab".repeat(65)}`,
			authorization: {
				from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
				to: accepted.payTo,
				value: accepted.amount,
				validAfter: "0",
				validBefore: "9999999999",
				nonce,
			},
		},
	};
}

const NONCE_A = `0x${"f3".repeat(32)}`;
const NONCE_B = `0x${"cd".repeat(32)}`;

function stubFacilitator(overrides: Partial<Facilitator> = {}): Facilitator {
	return {
		verify: vi.fn(async () => ({ isValid: true }) satisfies X402VerifyResponse),
		settle: vi.fn(async () => SETTLEMENT_OK),
		supported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })),
		...overrides,
	};
}

function freshStore() {
	return createInMemoryIdempotencyStore({ warnOnConstruct: false });
}

function jsonResponse<T>(body: T): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function paidRequest(
	url: string,
	payload: X402PaymentPayload,
	extraHeaders: Record<string, string> = {},
): Request {
	const headers = new Headers({
		[X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentSignatureHeader(payload),
	});
	for (const [k, v] of Object.entries(extraHeaders)) {
		headers.set(k, v);
	}
	return new Request(url, { method: "GET", headers });
}

function nonceOf(payload: X402PaymentPayload): string {
	// Narrow the open payload to read the authorization nonce.
	const inner = payload.payload as { authorization?: { nonce?: unknown } };
	const nonce = inner.authorization?.nonce;
	if (typeof nonce !== "string") {
		throw new Error("payload has no nonce");
	}
	return nonce;
}

describe("server idempotency — §6.1 scenarios", () => {
	it("replays the cached response on an identical re-send (settles once)", async () => {
		const settle = vi.fn(async () => SETTLEMENT_OK);
		const inner = vi.fn(async () => jsonResponse({ weather: "sunny" }));
		const handler = createX402Handler({
			facilitator: stubFacilitator({ settle }),
			requirementsFor: () => [REQS],
			handler: inner,
			idempotency: { store: freshStore() },
		});

		const r1 = await handler(paidRequest("https://api.example.com/weather", payloadWith(NONCE_A)));
		const r2 = await handler(paidRequest("https://api.example.com/weather", payloadWith(NONCE_A)));

		expect(settle).toHaveBeenCalledTimes(1);
		expect(inner).toHaveBeenCalledTimes(1);
		expect(r1.headers.get("Idempotency-Replayed")).toBeNull();
		expect(r2.headers.get("Idempotency-Replayed")).toBe("true");
		expect(await r2.json()).toEqual({ weather: "sunny" });
	});

	it("settles twice when idempotency is disabled (store: none)", async () => {
		const settle = vi.fn(async () => SETTLEMENT_OK);
		const handler = createX402Handler({
			facilitator: stubFacilitator({ settle }),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ ok: true }),
			idempotency: { store: "none" },
		});
		await handler(paidRequest("https://api.example.com/weather", payloadWith(NONCE_A)));
		await handler(paidRequest("https://api.example.com/weather", payloadWith(NONCE_A)));
		expect(settle).toHaveBeenCalledTimes(2);
	});

	it("deduplicates on the Idempotency-Key header even when the signature differs (H1)", async () => {
		const settle = vi.fn(async () => SETTLEMENT_OK);
		const handler = createX402Handler({
			facilitator: stubFacilitator({ settle }),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ ok: true }),
			idempotency: { store: freshStore() },
		});
		// Same logical key, DIFFERENT nonces (a re-sign): the header dedups them.
		await handler(
			paidRequest("https://api/x", payloadWith(NONCE_A), { "Idempotency-Key": "step-7" }),
		);
		const r2 = await handler(
			paidRequest("https://api/x", payloadWith(NONCE_B), { "Idempotency-Key": "step-7" }),
		);
		expect(settle).toHaveBeenCalledTimes(1);
		expect(r2.headers.get("Idempotency-Replayed")).toBe("true");
	});

	it("namespaces by (network, payTo, asset) so the same key across merchants does not collide", async () => {
		const reqs2: X402PaymentRequirements = {
			...REQS,
			payTo: getAddress("0x1111111111111111111111111111111111111111"),
		};
		const settle = vi.fn(async () => SETTLEMENT_OK);
		const handler = createX402Handler({
			facilitator: stubFacilitator({ settle }),
			requirementsFor: () => [REQS, reqs2],
			handler: async () => jsonResponse({ ok: true }),
			idempotency: { store: freshStore() },
		});
		await handler(
			paidRequest("https://api/x", payloadWith(NONCE_A, REQS), { "Idempotency-Key": "k" }),
		);
		await handler(
			paidRequest("https://api/x", payloadWith(NONCE_A, reqs2), { "Idempotency-Key": "k" }),
		);
		expect(settle).toHaveBeenCalledTimes(2);
	});

	it("rejects a concurrent duplicate while the first settles (TOCTOU)", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let reached: () => void = () => {};
		const settleReached = new Promise<void>((r) => {
			reached = r;
		});
		const settle = vi.fn(async () => {
			reached();
			await gate;
			return SETTLEMENT_OK;
		});
		const handler = createX402Handler({
			facilitator: stubFacilitator({ settle }),
			requirementsFor: () => [REQS],
			handler: async () => jsonResponse({ ok: true }),
			idempotency: { store: freshStore() }, // inFlight: "reject" (default)
		});

		const p1 = handler(paidRequest("https://api/x", payloadWith(NONCE_A)));
		await settleReached; // p1 now holds the lease, parked in settle
		const r2 = await handler(paidRequest("https://api/x", payloadWith(NONCE_A)));
		expect(r2.status).toBe(402);
		const required = decodePaymentRequiredHeader(
			r2.headers.get(X402_HEADER_PAYMENT_REQUIRED) ?? "",
		);
		expect(required.error).toBe("payment_in_progress");

		release();
		expect((await p1).status).toBe(200);
		expect(settle).toHaveBeenCalledTimes(1);
	});
});

describe("client idempotency — derived nonce (Half B)", () => {
	const signer = createX402PaymentSigner({
		network: "testnet",
		account: privateKeyToAccount(TEST_PK),
		asset: { kind: "known", id: "jpyc-v2" },
	});

	it("derives the same EIP-3009 nonce for the same idempotency key", async () => {
		const a = await signer.sign({ paymentRequirements: REQS, idempotencyKey: "conv:0" });
		const b = await signer.sign({ paymentRequirements: REQS, idempotencyKey: "conv:0" });
		expect(nonceOf(a)).toBe(nonceOf(b));
	});

	it("derives a different nonce for a different key, and random without a key", async () => {
		const a = await signer.sign({ paymentRequirements: REQS, idempotencyKey: "conv:0" });
		const b = await signer.sign({ paymentRequirements: REQS, idempotencyKey: "conv:1" });
		const random1 = await signer.sign({ paymentRequirements: REQS });
		const random2 = await signer.sign({ paymentRequirements: REQS });
		expect(nonceOf(a)).not.toBe(nonceOf(b));
		expect(nonceOf(random1)).not.toBe(nonceOf(random2));
	});
});

describe("wrapFetch — idempotency key propagation", () => {
	it("attaches the Idempotency-Key header on the retry and forwards it to the signer", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account: privateKeyToAccount(TEST_PK),
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const requiredBody = buildPaymentRequiredResponse({
			resource: { url: "https://api/weather" },
			accepts: [REQS],
			error: "payment required",
		});
		let retryHeaders: Headers | undefined;
		let calls = 0;
		const baseFetch = async (
			_input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			calls += 1;
			if (calls === 1) {
				return new Response(JSON.stringify(requiredBody), {
					status: 402,
					headers: { [X402_HEADER_PAYMENT_REQUIRED]: encodePaymentRequiredHeader(requiredBody) },
				});
			}
			retryHeaders = new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		};

		const f = wrapFetch({
			signer,
			fetch: baseFetch,
			onPayment: () => true,
			idempotencyKeyFor: () => "my-step-key",
		});
		const res = await f("https://api/weather");
		expect(res.status).toBe(200);
		expect(retryHeaders?.get(X402_HEADER_IDEMPOTENCY_KEY)).toBe("my-step-key");
	});
});
