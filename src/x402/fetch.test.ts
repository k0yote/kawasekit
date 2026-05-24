import type { IncomingMessage, ServerResponse } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { readBody, withHttpListener } from "../../test/helpers/http-listener";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { createX402PaymentSigner } from "./client";
import {
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
} from "./encoding";
import { wrapFetch } from "./fetch";
import type {
	X402PaymentPayload,
	X402PaymentRequiredResponse,
	X402PaymentRequirements,
} from "./types";

const ACCOUNT_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(ACCOUNT_PK);

const REQS: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000",
	asset: JPYC_V2_ADDRESS,
	payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
};

function build402(
	accepts: readonly X402PaymentRequirements[] = [REQS],
): X402PaymentRequiredResponse {
	return {
		x402Version: 2,
		resource: { url: "https://api.example.com/weather", description: "Real-time weather" },
		accepts,
		error: "PAYMENT-SIGNATURE header is required",
	};
}

/**
 * Helper: a paywall server that returns 402 on first request and 200 on the
 * retry that carries PAYMENT-SIGNATURE.
 */
function paywallHandler(opts: {
	payload?: X402PaymentRequiredResponse;
	includeHeader?: boolean;
	includeBody?: boolean;
	onRetry?: (req: IncomingMessage, body: string, paymentSignature: string) => void;
	successBody?: string;
}) {
	const payload = opts.payload ?? build402();
	const includeHeader = opts.includeHeader !== false;
	const includeBody = opts.includeBody !== false;
	return async (req: IncomingMessage, res: ServerResponse) => {
		const body = await readBody(req);
		const sig = req.headers["payment-signature"];
		if (typeof sig === "string" && sig !== "") {
			opts.onRetry?.(req, body, sig);
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.setHeader(X402_HEADER_PAYMENT_RESPONSE, "encoded-settlement-here");
			res.end(opts.successBody ?? JSON.stringify({ weather: "sunny" }));
			return;
		}
		res.statusCode = 402;
		res.setHeader("content-type", "application/json");
		if (includeHeader) {
			res.setHeader(X402_HEADER_PAYMENT_REQUIRED, encodePaymentRequiredHeader(payload));
		}
		res.end(includeBody ? JSON.stringify(payload) : "");
	};
}

describe("wrapFetch — pass-through", () => {
	it("returns a non-402 response as-is without invoking the signer", async () => {
		const signer = createX402PaymentSigner({ account });
		const signSpy = vi.spyOn(signer, "sign");

		await withHttpListener(
			async (_req, res) => {
				res.statusCode = 200;
				res.end(JSON.stringify({ free: true }));
			},
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				const res = await fetch402(`${baseUrl}/free`);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ free: true });
				expect(signSpy).not.toHaveBeenCalled();
			},
		);
	});

	it("returns the 402 unchanged when accepts is empty", async () => {
		const signer = createX402PaymentSigner({ account });
		await withHttpListener(
			paywallHandler({ payload: { ...build402(), accepts: [] } }),
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				const res = await fetch402(`${baseUrl}/x`);
				expect(res.status).toBe(402);
			},
		);
	});

	it("returns the 402 unchanged when the body has no parseable PAYMENT-REQUIRED", async () => {
		const signer = createX402PaymentSigner({ account });
		await withHttpListener(
			async (_req, res) => {
				res.statusCode = 402;
				res.setHeader("content-type", "text/plain");
				res.end("payment required, friend");
			},
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				const res = await fetch402(`${baseUrl}/x`);
				expect(res.status).toBe(402);
			},
		);
	});
});

describe("wrapFetch — sign-and-retry happy path", () => {
	it("signs the chosen requirements and retries with PAYMENT-SIGNATURE", async () => {
		const signer = createX402PaymentSigner({ account });
		let capturedSignature = "";

		await withHttpListener(
			paywallHandler({
				onRetry: (_req, _body, sig) => {
					capturedSignature = sig;
				},
			}),
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				const res = await fetch402(`${baseUrl}/weather`);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ weather: "sunny" });
				expect(capturedSignature).not.toBe("");

				const decoded = decodePaymentSignatureHeader(capturedSignature);
				expect(decoded.accepted).toEqual(REQS);
			},
		);
	});

	it("falls back to parsing the body when PAYMENT-REQUIRED header is absent", async () => {
		const signer = createX402PaymentSigner({ account });
		await withHttpListener(
			paywallHandler({ includeHeader: false, includeBody: true }),
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				const res = await fetch402(`${baseUrl}/weather`);
				expect(res.status).toBe(200);
			},
		);
	});

	it("preserves PAYMENT-RESPONSE header from the success response", async () => {
		const signer = createX402PaymentSigner({ account });
		await withHttpListener(paywallHandler({}), async (baseUrl) => {
			const fetch402 = wrapFetch({ signer });
			const res = await fetch402(`${baseUrl}/weather`);
			expect(res.headers.get(X402_HEADER_PAYMENT_RESPONSE)).toBe("encoded-settlement-here");
		});
	});

	it("preserves request method on retry", async () => {
		const signer = createX402PaymentSigner({ account });
		let retryMethod = "";
		await withHttpListener(
			paywallHandler({
				onRetry: (req) => {
					retryMethod = req.method ?? "";
				},
			}),
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				await fetch402(`${baseUrl}/weather`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ q: "hi" }),
				});
				expect(retryMethod).toBe("POST");
			},
		);
	});

	it("preserves request body on retry", async () => {
		const signer = createX402PaymentSigner({ account });
		let retryBody = "";
		await withHttpListener(
			paywallHandler({
				onRetry: (_req, body) => {
					retryBody = body;
				},
			}),
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				await fetch402(`${baseUrl}/weather`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ q: "hi" }),
				});
				expect(retryBody).toBe('{"q":"hi"}');
			},
		);
	});

	it("preserves caller-supplied headers and merges PAYMENT-SIGNATURE alongside", async () => {
		const signer = createX402PaymentSigner({ account });
		let retryAuthHeader = "";
		await withHttpListener(
			async (req, res) => {
				const sig = req.headers["payment-signature"];
				if (typeof sig === "string" && sig !== "") {
					retryAuthHeader = String(req.headers.authorization ?? "");
					res.statusCode = 200;
					res.end("{}");
					return;
				}
				res.statusCode = 402;
				res.setHeader(X402_HEADER_PAYMENT_REQUIRED, encodePaymentRequiredHeader(build402()));
				res.end(JSON.stringify(build402()));
			},
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				await fetch402(`${baseUrl}/x`, { headers: { Authorization: "Bearer caller-token" } });
				expect(retryAuthHeader).toBe("Bearer caller-token");
			},
		);
	});

	it("echoes the server's resource info back inside the signed payload", async () => {
		const signer = createX402PaymentSigner({ account });
		const payload = build402();
		let echoed: X402PaymentPayload["resource"];
		await withHttpListener(
			paywallHandler({
				payload,
				onRetry: (_req, _body, sig) => {
					echoed = decodePaymentSignatureHeader(sig).resource;
				},
			}),
			async (baseUrl) => {
				const fetch402 = wrapFetch({ signer });
				await fetch402(`${baseUrl}/x`);
				expect(echoed).toEqual({
					url: "https://api.example.com/weather",
					description: "Real-time weather",
				});
			},
		);
	});
});

describe("wrapFetch — selectRequirements policy", () => {
	it("uses the caller-supplied selector to pick a non-first entry", async () => {
		const cheap: X402PaymentRequirements = { ...REQS, amount: "1000" };
		const expensive: X402PaymentRequirements = { ...REQS, amount: "100000" };
		const signer = createX402PaymentSigner({ account });
		let chosenAmount = "";
		await withHttpListener(
			paywallHandler({
				payload: { ...build402([cheap, expensive]) },
				onRetry: (_req, _body, sig) => {
					chosenAmount = decodePaymentSignatureHeader(sig).accepted.amount;
				},
			}),
			async (baseUrl) => {
				// Prefer the cheaper one.
				const fetch402 = wrapFetch({
					signer,
					selectRequirements: (accepts) =>
						[...accepts].sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)))[0] ?? null,
				});
				await fetch402(`${baseUrl}/x`);
				expect(chosenAmount).toBe("1000");
			},
		);
	});

	it("aborts the retry when selectRequirements returns null", async () => {
		const signer = createX402PaymentSigner({ account });
		const signSpy = vi.spyOn(signer, "sign");
		await withHttpListener(paywallHandler({}), async (baseUrl) => {
			const fetch402 = wrapFetch({ signer, selectRequirements: () => null });
			const res = await fetch402(`${baseUrl}/x`);
			expect(res.status).toBe(402);
			expect(signSpy).not.toHaveBeenCalled();
		});
	});
});

describe("wrapFetch — onPayment hook", () => {
	it("is called with chosen requirements and parsed 402 body", async () => {
		const signer = createX402PaymentSigner({ account });
		let captured: {
			requirements: X402PaymentRequirements;
			paymentRequired: X402PaymentRequiredResponse;
		} | null = null;
		await withHttpListener(paywallHandler({}), async (baseUrl) => {
			const fetch402 = wrapFetch({
				signer,
				onPayment: (requirements, paymentRequired) => {
					captured = { requirements, paymentRequired };
					return true;
				},
			});
			await fetch402(`${baseUrl}/x`);
			expect(captured).not.toBeNull();
			expect(captured!.requirements).toEqual(REQS);
			expect(captured!.paymentRequired.x402Version).toBe(2);
		});
	});

	it("aborts the retry when onPayment returns false (budget guard)", async () => {
		const signer = createX402PaymentSigner({ account });
		const signSpy = vi.spyOn(signer, "sign");
		await withHttpListener(paywallHandler({}), async (baseUrl) => {
			const fetch402 = wrapFetch({ signer, onPayment: () => false });
			const res = await fetch402(`${baseUrl}/x`);
			expect(res.status).toBe(402);
			expect(signSpy).not.toHaveBeenCalled();
		});
	});
});

describe("wrapFetch — custom fetch", () => {
	it("uses the caller-supplied fetch implementation", async () => {
		const signer = createX402PaymentSigner({ account });
		const customFetch = vi.fn(globalThis.fetch);
		await withHttpListener(paywallHandler({}), async (baseUrl) => {
			const fetch402 = wrapFetch({ signer, fetch: customFetch });
			await fetch402(`${baseUrl}/x`);
			// One call for the initial 402, one for the retry.
			expect(customFetch).toHaveBeenCalledTimes(2);
		});
	});
});
