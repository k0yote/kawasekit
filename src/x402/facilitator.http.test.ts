import { describe, expect, it } from "vitest";
import { readBody, withHttpListener } from "../../test/helpers/http-listener";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { createCoinbaseFacilitator, createHttpFacilitator } from "./facilitator";
import type {
	X402PaymentPayload,
	X402PaymentRequirements,
	X402SettleResponse,
	X402SupportedResponse,
	X402VerifyResponse,
} from "./types";

const REQS: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000",
	asset: JPYC_V2_ADDRESS,
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 60,
	extra: { name: "JPY Coin", version: "1" },
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

describe("createHttpFacilitator — verify", () => {
	it("POSTs the right body to /verify and returns the parsed response", async () => {
		let receivedPath = "";
		let receivedMethod = "";
		let receivedBody = "";

		await withHttpListener(
			async (req, res) => {
				receivedPath = req.url ?? "";
				receivedMethod = req.method ?? "";
				receivedBody = await readBody(req);
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						isValid: true,
						payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
					} satisfies X402VerifyResponse),
				);
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				const result = await facilitator.verify({
					x402Version: 2,
					paymentPayload: PAYLOAD,
					paymentRequirements: REQS,
				});

				expect(receivedPath).toBe("/verify");
				expect(receivedMethod).toBe("POST");
				const parsed = JSON.parse(receivedBody);
				expect(parsed.x402Version).toBe(2);
				expect(parsed.paymentPayload).toEqual(PAYLOAD);
				expect(parsed.paymentRequirements).toEqual(REQS);

				expect(result.isValid).toBe(true);
				expect(result.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
			},
		);
	});

	it("strips trailing slash from baseUrl", async () => {
		let receivedPath = "";
		await withHttpListener(
			async (req, res) => {
				receivedPath = req.url ?? "";
				await readBody(req);
				res.end(JSON.stringify({ isValid: true } satisfies X402VerifyResponse));
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl: `${baseUrl}/` });
				await facilitator.verify({
					x402Version: 2,
					paymentPayload: PAYLOAD,
					paymentRequirements: REQS,
				});
				expect(receivedPath).toBe("/verify");
			},
		);
	});

	it("sends auth headers from getAuthHeaders callback", async () => {
		let receivedAuth = "";
		let receivedEndpointArg = "";
		await withHttpListener(
			async (req, res) => {
				receivedAuth = String(req.headers.authorization ?? "");
				await readBody(req);
				res.end(JSON.stringify({ isValid: true } satisfies X402VerifyResponse));
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({
					baseUrl,
					getAuthHeaders: async (endpoint) => {
						receivedEndpointArg = endpoint;
						return { Authorization: "Bearer secret-token" };
					},
				});
				await facilitator.verify({
					x402Version: 2,
					paymentPayload: PAYLOAD,
					paymentRequirements: REQS,
				});
				expect(receivedAuth).toBe("Bearer secret-token");
				expect(receivedEndpointArg).toBe("verify");
			},
		);
	});

	it("throws on non-2xx response with a structured error body", async () => {
		await withHttpListener(
			async (_req, res) => {
				res.statusCode = 400;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ isValid: false, invalidReason: "invalid_payload" }));
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				await expect(
					facilitator.verify({
						x402Version: 2,
						paymentPayload: PAYLOAD,
						paymentRequirements: REQS,
					}),
				).rejects.toThrow(/400/);
			},
		);
	});

	it("throws on non-JSON response body", async () => {
		await withHttpListener(
			async (_req, res) => {
				res.setHeader("content-type", "text/plain");
				res.end("not json");
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				await expect(
					facilitator.verify({
						x402Version: 2,
						paymentPayload: PAYLOAD,
						paymentRequirements: REQS,
					}),
				).rejects.toThrow(/non-JSON/);
			},
		);
	});
});

describe("createHttpFacilitator — settle", () => {
	it("POSTs to /settle and returns the parsed response", async () => {
		let receivedPath = "";
		await withHttpListener(
			async (req, res) => {
				receivedPath = req.url ?? "";
				await readBody(req);
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						success: true,
						transaction: "0xdeadbeef",
						network: "eip155:80002",
						payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
					} satisfies X402SettleResponse),
				);
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				const result = await facilitator.settle({
					x402Version: 2,
					paymentPayload: PAYLOAD,
					paymentRequirements: REQS,
				});
				expect(receivedPath).toBe("/settle");
				expect(result.success).toBe(true);
				expect(result.transaction).toBe("0xdeadbeef");
				expect(result.network).toBe("eip155:80002");
			},
		);
	});

	it("propagates a structured failure response (success=false)", async () => {
		await withHttpListener(
			async (_req, res) => {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						success: false,
						errorReason: "insufficient_funds",
						transaction: "",
						network: "eip155:80002",
					} satisfies X402SettleResponse),
				);
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				const result = await facilitator.settle({
					x402Version: 2,
					paymentPayload: PAYLOAD,
					paymentRequirements: REQS,
				});
				expect(result.success).toBe(false);
				expect(result.errorReason).toBe("insufficient_funds");
			},
		);
	});
});

describe("createHttpFacilitator — supported", () => {
	it("GETs /supported and returns parsed response", async () => {
		let receivedMethod = "";
		let receivedPath = "";
		await withHttpListener(
			async (req, res) => {
				receivedMethod = req.method ?? "";
				receivedPath = req.url ?? "";
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
						extensions: [],
						signers: { "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"] },
					} satisfies X402SupportedResponse),
				);
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				const result = await facilitator.supported();
				expect(receivedMethod).toBe("GET");
				expect(receivedPath).toBe("/supported");
				expect(result.kinds).toHaveLength(1);
				expect(result.kinds[0]?.network).toBe("eip155:8453");
			},
		);
	});

	it("allows the demo to detect 'Amoy not supported' so it can skip", async () => {
		await withHttpListener(
			async (_req, res) => {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
						extensions: [],
						signers: {},
					} satisfies X402SupportedResponse),
				);
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl });
				const result = await facilitator.supported();
				const amoy = result.kinds.find((k) => k.network === "eip155:80002");
				expect(amoy).toBeUndefined(); // demo script should branch on this
			},
		);
	});
});

describe("createCoinbaseFacilitator (deprecated alias)", () => {
	it("delegates to createHttpFacilitator and emits a DeprecationWarning once", async () => {
		const warnings: { message: string; code: string | undefined }[] = [];
		const onWarning = (warning: Error & { code?: string }): void => {
			warnings.push({ message: warning.message, code: warning.code });
		};
		process.on("warning", onWarning);
		try {
			await withHttpListener(
				async (req, res) => {
					await readBody(req);
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ isValid: true } satisfies X402VerifyResponse));
				},
				async (baseUrl) => {
					const facilitator = createCoinbaseFacilitator({ baseUrl });
					const result = await facilitator.verify({
						x402Version: 2,
						paymentPayload: PAYLOAD,
						paymentRequirements: REQS,
					});
					expect(result.isValid).toBe(true);
					// Second call MUST NOT emit a second warning (one-shot per process).
					const second = createCoinbaseFacilitator({ baseUrl });
					await second.verify({
						x402Version: 2,
						paymentPayload: PAYLOAD,
						paymentRequirements: REQS,
					});
				},
			);
			// Allow the warning event loop tick to flush.
			await new Promise((resolve) => setImmediate(resolve));
			const deprecation = warnings.find((w) => w.code === "KAWASEKIT_DEP_001");
			expect(deprecation).toBeDefined();
			expect(deprecation?.message).toMatch(/createHttpFacilitator/);
			expect(warnings.filter((w) => w.code === "KAWASEKIT_DEP_001")).toHaveLength(1);
		} finally {
			process.off("warning", onWarning);
		}
	});
});
