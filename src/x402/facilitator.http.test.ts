import { describe, expect, it } from "vitest";
import { readBody, withHttpListener } from "../../test/helpers/http-listener";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { X402FacilitatorTimeoutError, X402SettleOutcomeUnknownError } from "./errors";
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

const SETTLED: X402SettleResponse = {
	success: true,
	transaction: `0x${"12".repeat(32)}`,
	network: "eip155:80002",
	payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
};

const SETTLE_REQ = { x402Version: 2, paymentPayload: PAYLOAD, paymentRequirements: REQS } as const;

/** Answer the first `failures` requests with `fail`, then `ok`; record every body received. */
function flaky(
	failures: number,
	fail: (res: import("node:http").ServerResponse) => void,
	ok: unknown,
): { bodies: string[]; handler: Parameters<typeof withHttpListener>[0] } {
	const bodies: string[] = [];
	return {
		bodies,
		handler: async (req, res) => {
			bodies.push(await readBody(req));
			if (bodies.length <= failures) {
				fail(res);
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(ok));
		},
	};
}

const unavailable =
	(retryAfter?: string) =>
	(res: import("node:http").ServerResponse): void => {
		res.statusCode = 503;
		if (retryAfter !== undefined) res.setHeader("retry-after", retryAfter);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ error: "unavailable" }));
	};

// #53: a facilitator that could not take the request is retried with the SAME body. Resending the
// same authorization cannot charge twice — EIP-3009 consumes its nonce once on chain. But /settle is
// resent ONLY on 503 (the facilitator says it did not take the request): after a 502/504, a dropped
// connection or a timeout the first attempt may have broadcast, and a resend that then answers
// "nonce already used" would be reported as a failed payment that is in fact landing.
describe("createHttpFacilitator — retry on 502/503/504 and network errors (#53)", () => {
	it("retries /settle after a 503 with the identical body, and returns the eventual answer", async () => {
		const f = flaky(2, unavailable("0"), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			const facilitator = createHttpFacilitator({ baseUrl, retry: { initialDelayMs: 1 } });
			const result = await facilitator.settle(SETTLE_REQ);
			expect(result).toEqual(SETTLED);
		});
		expect(f.bodies).toHaveLength(3);
		expect(new Set(f.bodies).size).toBe(1);
	});

	it("retries /verify on 502 and 504 (verify moves no funds)", async () => {
		for (const status of [502, 504]) {
			const f = flaky(
				1,
				(res) => {
					res.statusCode = status;
					res.end("");
				},
				{ isValid: true } satisfies X402VerifyResponse,
			);
			await withHttpListener(f.handler, async (baseUrl) => {
				const facilitator = createHttpFacilitator({ baseUrl, retry: { initialDelayMs: 1 } });
				expect((await facilitator.verify(SETTLE_REQ)).isValid).toBe(true);
			});
			expect(f.bodies).toHaveLength(2);
		}
	});

	it("is on by default", async () => {
		const f = flaky(1, unavailable("0"), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			expect((await createHttpFacilitator({ baseUrl }).settle(SETTLE_REQ)).success).toBe(true);
		});
		expect(f.bodies).toHaveLength(2);
	});

	it("waits Retry-After before the next attempt", async () => {
		const f = flaky(1, unavailable("1"), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			const started = Date.now();
			await createHttpFacilitator({ baseUrl, retry: { initialDelayMs: 1 } }).settle(SETTLE_REQ);
			expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		});
	});

	it("stops at maxAttempts and throws the last failure", async () => {
		const f = flaky(10, unavailable("0"), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			const facilitator = createHttpFacilitator({
				baseUrl,
				retry: { maxAttempts: 2, initialDelayMs: 1 },
			});
			await expect(facilitator.settle(SETTLE_REQ)).rejects.toThrow(/503/);
		});
		expect(f.bodies).toHaveLength(2);
	});

	it("does not start an attempt whose wait would overrun the budget", async () => {
		const f = flaky(10, unavailable("5"), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			const facilitator = createHttpFacilitator({ baseUrl, retry: { budgetMs: 1_000 } });
			const started = Date.now();
			await expect(facilitator.settle(SETTLE_REQ)).rejects.toThrow(/503/);
			expect(Date.now() - started).toBeLessThan(1_000);
		});
		expect(f.bodies).toHaveLength(1);
	});

	it("does not retry other statuses (400, 500)", async () => {
		for (const status of [400, 500]) {
			const f = flaky(
				10,
				(res) => {
					res.statusCode = status;
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ error: "nope" }));
				},
				SETTLED,
			);
			await withHttpListener(f.handler, async (baseUrl) => {
				await expect(
					createHttpFacilitator({ baseUrl, retry: { initialDelayMs: 1 } }).settle(SETTLE_REQ),
				).rejects.toThrow(String(status));
			});
			expect(f.bodies).toHaveLength(1);
		}
	});

	it("retry: false sends once", async () => {
		const f = flaky(1, unavailable("0"), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			await expect(
				createHttpFacilitator({ baseUrl, retry: false }).settle(SETTLE_REQ),
			).rejects.toThrow(/503/);
		});
		expect(f.bodies).toHaveLength(1);
	});

	it("does not resend /settle after a 502 or 504 — the first attempt may have broadcast", async () => {
		for (const status of [502, 504]) {
			const f = flaky(
				1,
				(res) => {
					res.statusCode = status;
					res.end("");
				},
				SETTLED,
			);
			await withHttpListener(f.handler, async (baseUrl) => {
				const error = await createHttpFacilitator({ baseUrl, retry: { initialDelayMs: 1 } })
					.settle(SETTLE_REQ)
					.then(
						() => null,
						(e: unknown) => e,
					);
				expect(error).toBeInstanceOf(X402SettleOutcomeUnknownError);
				expect((error as Error).message).toMatch(String(status));
			});
			expect(f.bodies).toHaveLength(1);
		}
	});

	it("does not resend /settle after a network error, and reports the outcome as unknown", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async (input, init) => {
			calls++;
			if (calls === 1) throw new TypeError("fetch failed");
			return fetch(input, init);
		};
		const f = flaky(0, unavailable(), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			const facilitator = createHttpFacilitator({
				baseUrl,
				fetch: fetchImpl,
				retry: { initialDelayMs: 1 },
			});
			await expect(facilitator.settle(SETTLE_REQ)).rejects.toBeInstanceOf(
				X402SettleOutcomeUnknownError,
			);
		});
		expect(calls).toBe(1);
	});

	it("resends /settle when the connection was refused — nothing was sent", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async (input, init) => {
			calls++;
			if (calls === 1) {
				throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
			}
			return fetch(input, init);
		};
		const f = flaky(0, unavailable(), SETTLED);
		await withHttpListener(f.handler, async (baseUrl) => {
			const facilitator = createHttpFacilitator({
				baseUrl,
				fetch: fetchImpl,
				retry: { initialDelayMs: 1 },
			});
			expect((await facilitator.settle(SETTLE_REQ)).success).toBe(true);
		});
		expect(calls).toBe(2);
	});

	it("retries /verify after a network error (the connection dropped)", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async (input, init) => {
			calls++;
			if (calls === 1) throw new TypeError("fetch failed");
			return fetch(input, init);
		};
		const f = flaky(0, unavailable(), { isValid: true } satisfies X402VerifyResponse);
		await withHttpListener(f.handler, async (baseUrl) => {
			const facilitator = createHttpFacilitator({
				baseUrl,
				fetch: fetchImpl,
				retry: { initialDelayMs: 1 },
			});
			expect((await facilitator.verify(SETTLE_REQ)).isValid).toBe(true);
		});
		expect(calls).toBe(2);
	});
});

describe("createHttpFacilitator — timeoutMs (#53)", () => {
	const silent: Parameters<typeof withHttpListener>[0] = () => {
		// never answers
	};

	it("a /settle that does not answer in time throws X402SettleOutcomeUnknownError caused by the timeout", async () => {
		await withHttpListener(silent, async (baseUrl) => {
			const facilitator = createHttpFacilitator({ baseUrl, timeoutMs: 50, retry: false });
			const error = await facilitator.settle(SETTLE_REQ).then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(X402SettleOutcomeUnknownError);
			expect((error as Error).message).toMatch(/may still settle/);
			const cause = (error as Error).cause;
			expect(cause).toBeInstanceOf(X402FacilitatorTimeoutError);
			expect((cause as X402FacilitatorTimeoutError).endpoint).toBe("settle");
		});
	});

	it("a timed-out /settle is not resent, even with retry on", async () => {
		let calls = 0;
		await withHttpListener(
			() => {
				calls++;
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({
					baseUrl,
					timeoutMs: 50,
					retry: { initialDelayMs: 1 },
				});
				await expect(facilitator.settle(SETTLE_REQ)).rejects.toBeInstanceOf(
					X402SettleOutcomeUnknownError,
				);
			},
		);
		expect(calls).toBe(1);
	});

	it("a timed-out /verify is retried within the budget, then reported as a timeout", async () => {
		let calls = 0;
		await withHttpListener(
			() => {
				calls++;
			},
			async (baseUrl) => {
				const facilitator = createHttpFacilitator({
					baseUrl,
					timeoutMs: 50,
					retry: { maxAttempts: 2, initialDelayMs: 1 },
				});
				await expect(facilitator.verify(SETTLE_REQ)).rejects.toBeInstanceOf(
					X402FacilitatorTimeoutError,
				);
			},
		);
		expect(calls).toBe(2);
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
