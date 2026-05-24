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

import type { X402PaymentSigner } from "./client";
import {
	decodePaymentRequiredHeader,
	encodePaymentSignatureHeader,
	X402_HEADER_PAYMENT_REQUIRED,
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
	 * Optional hook invoked just before the retry request goes out. Receives
	 * the chosen requirements and the parsed 402 body so the caller can log
	 * spending, prompt the user, or enforce a budget.
	 *
	 * Returning `false` aborts the retry — the original 402 is returned.
	 */
	readonly onPayment?: (
		requirements: X402PaymentRequirements,
		paymentRequired: X402PaymentRequiredResponse,
	) => boolean | undefined | Promise<boolean | undefined>;
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
 * const fetch402 = wrapFetch({ signer });
 *
 * const res = await fetch402("https://api.example.com/weather?city=Tokyo");
 * console.log(await res.json());
 * ```
 */
export function wrapFetch(params: WrapFetchParams): X402Fetch {
	const baseFetch: X402Fetch = params.fetch ?? ((input, init) => fetch(input, init));
	const selectRequirements = params.selectRequirements ?? defaultSelectRequirements;
	const onPayment = params.onPayment;

	return async function x402Fetch(input, init) {
		const initialResponse = await baseFetch(input, init);
		if (initialResponse.status !== 402) {
			return initialResponse;
		}

		const paymentRequired = await readPaymentRequired(initialResponse);
		if (paymentRequired === null || paymentRequired.accepts.length === 0) {
			return initialResponse;
		}

		const chosen = selectRequirements(paymentRequired.accepts, initialResponse);
		if (chosen === null) {
			return initialResponse;
		}

		if (onPayment) {
			const proceed = await onPayment(chosen, paymentRequired);
			if (proceed === false) {
				return initialResponse;
			}
		}

		const paymentPayload = await params.signer.sign({
			paymentRequirements: chosen,
			...(paymentRequired.resource ? { resource: paymentRequired.resource } : {}),
		});

		const retryHeaders = new Headers(init?.headers);
		retryHeaders.set(X402_HEADER_PAYMENT_SIGNATURE, encodePaymentSignatureHeader(paymentPayload));

		return baseFetch(input, { ...init, headers: retryHeaders });
	};
}
