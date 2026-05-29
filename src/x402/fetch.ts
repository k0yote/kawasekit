/**
 * `wrapFetch()` — turn any WHATWG `fetch` implementation into an x402-aware
 * client.
 *
 * The returned function makes a first request as usual. If the server replies
 * with `402 Payment Required`, the wrapper decodes the `PAYMENT-REQUIRED`
 * header (or response body as a fallback), picks one entry from `accepts`,
 * signs it with the configured {@link X402PaymentSigner}, and retries the
 * same request with a `PAYMENT-SIGNATURE` header. Non-402 responses are
 * returned unchanged.
 *
 * The wrapper does **not** poll or back off — the latency budget (Polygon Amoy
 * bundler inclusion can take ~60 s) lives entirely on the server side, which
 * holds the connection open while it broadcasts and waits for the receipt.
 * If the second attempt still fails the wrapper returns that response so the
 * caller can decide how to recover.
 *
 * Streaming request bodies are not retry-safe; the wrapper passes `init.body`
 * through verbatim, so callers who need retry must pass a buffered body
 * (string / Uint8Array / ArrayBuffer / FormData).
 *
 * @packageDocumentation
 */

import type { Hex } from "viem";
import {
	type ClientPaymentEvent,
	invokeHookSafely,
	type ObservabilityHooks,
} from "../observability/hooks";
import type { X402PaymentSigner } from "./client";
import {
	decodePaymentRequiredHeader,
	decodePaymentResponseHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_IDEMPOTENCY_KEY,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "./encoding";
import type { X402PaymentRequiredResponse, X402PaymentRequirements } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function shape matching the WHATWG `fetch` global. */
export type X402Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Parameters for {@link wrapFetch}. */
export interface WrapFetchParams {
	/**
	 * The signer used to produce {@link X402PaymentPayload}s when the server
	 * returns 402. Bound to one EOA.
	 */
	readonly signer: X402PaymentSigner;
	/**
	 * Optional underlying fetch implementation. Defaults to `globalThis.fetch`.
	 */
	readonly fetch?: X402Fetch;
	/**
	 * Optional policy for choosing one entry from the server's `accepts` list.
	 * Defaults to the first entry. Return `null` to abort — the original 402
	 * response is returned without retry.
	 */
	readonly selectRequirements?: (
		accepts: readonly X402PaymentRequirements[],
		response: Response,
	) => X402PaymentRequirements | null;
	/**
	 * Required gate invoked just before the retry request goes out. Receives
	 * the chosen requirements and the parsed 402 body so the caller can log
	 * spending, prompt the user, or enforce a budget.
	 *
	 * Returning `false` aborts the retry — the original 402 is returned.
	 * Returning `true` (or `undefined`) proceeds with the signed retry.
	 *
	 * This callback is **required** at the type level: a 402 retry transfers
	 * real funds, and kawasekit refuses to default to "always pay" silently.
	 * If your caller already enforces a budget elsewhere, return `true`
	 * explicitly — the empty function `() => true` is a deliberate opt-in.
	 *
	 * See `docs/THREAT_MODEL.md` Threat 1.8 / §6.1.
	 */
	readonly onPayment: (
		requirements: X402PaymentRequirements,
		paymentRequired: X402PaymentRequiredResponse,
	) => boolean | undefined | Promise<boolean | undefined>;
	/**
	 * Optional observability callbacks. {@link wrapFetch} emits an
	 * `onClientPayment` event for every paywall round-trip — `success` when the
	 * retry returns 2xx with a PAYMENT-RESPONSE header, `failure` otherwise
	 * (including `onPayment` declining the retry).
	 */
	readonly hooks?: ObservabilityHooks;
	/**
	 * Optional mapper from a request to a reasoning-step idempotency key (M5-1).
	 * When it returns a key, the key is (a) sent as the `Idempotency-Key` request
	 * header so the server can deduplicate, and (b) forwarded into the signer so
	 * the EIP-3009 nonce is derived deterministically (on-chain backstop). Return
	 * `undefined` to fall back to today's random-nonce behaviour. Build keys with
	 * `createIdempotencyKeyBuilder` from `kawasekit/idempotency` at the agent
	 * harness's tool-execution boundary, where the reasoning-step intent is visible.
	 */
	readonly idempotencyKeyFor?: (
		input: string | URL | Request,
		requirements: X402PaymentRequirements,
		paymentRequired: X402PaymentRequiredResponse,
	) => string | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readPaymentRequired(
	response: Response,
): Promise<X402PaymentRequiredResponse | null> {
	const headerValue = response.headers.get(X402_HEADER_PAYMENT_REQUIRED);
	if (headerValue !== null && headerValue !== "") {
		try {
			return decodePaymentRequiredHeader(headerValue);
		} catch {
			// Fall through to body parse — the header was malformed but the
			// body might still be intact (or vice versa).
		}
	}
	try {
		const body = await response.clone().text();
		if (body === "") return null;
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as X402PaymentRequiredResponse;
	} catch {
		return null;
	}
}

function defaultSelectRequirements(
	accepts: readonly X402PaymentRequirements[],
): X402PaymentRequirements | null {
	return accepts[0] ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns an x402-aware `fetch` that pays for `402` responses on the caller's
 * behalf using the provided signer.
 *
 * @example
 * ```ts
 * import { privateKeyToAccount } from "viem/accounts";
 * import { createX402PaymentSigner, wrapFetch } from "kawasekit";
 *
 * const signer = createX402PaymentSigner({
 *   account: privateKeyToAccount(process.env.PAYER_PK as `0x${string}`),
 * });
 *
 * let spent = 0n;
 * const MAX_SPEND = 100_000n; // 100 JPYC (6 decimals)
 * const fetch402 = wrapFetch({
 *   signer,
 *   onPayment: (req) => {
 *     const next = spent + BigInt(req.amount);
 *     if (next > MAX_SPEND) return false; // budget exhausted
 *     spent = next;
 *     return true;
 *   },
 * });
 *
 * const res = await fetch402("https://api.example.com/weather?city=Tokyo");
 * console.log(await res.json());
 * ```
 */
export function wrapFetch(params: WrapFetchParams): X402Fetch {
	const baseFetch: X402Fetch = params.fetch ?? ((input, init) => fetch(input, init));
	const selectRequirements = params.selectRequirements ?? defaultSelectRequirements;
	const onPayment = params.onPayment;
	const hooks = params.hooks;

	return async function x402Fetch(input, init) {
		const startedAtMs = Date.now();
		const requestUrl =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		const emitFailure = (reason: string, httpStatus: number | undefined): void => {
			const event: ClientPaymentEvent = {
				kind: "client_payment",
				result: "failure",
				startedAtMs,
				durationMs: Date.now() - startedAtMs,
				requestUrl,
				reason,
				...(httpStatus !== undefined ? { httpStatus } : {}),
			};
			invokeHookSafely(hooks?.onClientPayment, event);
		};

		const initialResponse = await baseFetch(input, init);
		if (initialResponse.status !== 402) {
			return initialResponse;
		}

		const paymentRequired = await readPaymentRequired(initialResponse);
		if (paymentRequired === null || paymentRequired.accepts.length === 0) {
			emitFailure("no_acceptable_requirement", 402);
			return initialResponse;
		}

		const chosen = selectRequirements(paymentRequired.accepts, initialResponse);
		if (chosen === null) {
			emitFailure("no_acceptable_requirement", 402);
			return initialResponse;
		}

		const proceed = await onPayment(chosen, paymentRequired);
		if (proceed === false) {
			emitFailure("onPayment_declined", 402);
			return initialResponse;
		}

		const idempotencyKey = params.idempotencyKeyFor?.(input, chosen, paymentRequired);

		const paymentPayload = await params.signer.sign({
			paymentRequirements: chosen,
			...(paymentRequired.resource ? { resource: paymentRequired.resource } : {}),
			...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
		});

		const retryHeaders = new Headers(init?.headers);
		retryHeaders.set(X402_HEADER_PAYMENT_SIGNATURE, encodePaymentSignatureHeader(paymentPayload));
		if (idempotencyKey !== undefined) {
			retryHeaders.set(X402_HEADER_IDEMPOTENCY_KEY, idempotencyKey);
		}

		const retryResponse = await baseFetch(input, { ...init, headers: retryHeaders });

		if (retryResponse.status >= 200 && retryResponse.status < 300) {
			const settlementHeader = retryResponse.headers.get(X402_HEADER_PAYMENT_RESPONSE);
			let transaction: Hex | undefined;
			if (settlementHeader !== null && settlementHeader !== "") {
				try {
					const settlement = decodePaymentResponseHeader(settlementHeader);
					if (settlement.transaction !== "") {
						transaction = settlement.transaction as Hex;
					}
				} catch {
					// PAYMENT-RESPONSE header malformed — the retry still
					// succeeded so we treat that as a (degraded) success event.
				}
			}
			const successEvent: ClientPaymentEvent = {
				kind: "client_payment",
				result: "success",
				startedAtMs,
				durationMs: Date.now() - startedAtMs,
				requestUrl,
				payer: params.signer.address,
				amount: chosen.amount,
				network: chosen.network,
				...(transaction !== undefined ? { transaction } : {}),
			};
			invokeHookSafely(hooks?.onClientPayment, successEvent);
		} else {
			emitFailure(
				retryResponse.status === 402 ? "settle_rejected" : "http_error",
				retryResponse.status,
			);
		}

		return retryResponse;
	};
}
