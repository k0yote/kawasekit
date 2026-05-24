/**
 * `createX402Handler()` — framework-agnostic x402 v2 resource-server adapter.
 *
 * The returned function maps any WHATWG `Request` to a `Response`, gating the
 * caller-supplied inner handler behind an x402 payment flow:
 *
 * 1. Compute requirements for the request (via `requirementsFor`).
 *    `null` / empty array → no payment, pass through to inner handler.
 * 2. Look for the `PAYMENT-SIGNATURE` header. If missing or malformed →
 *    `402 Payment Required` with a `PAYMENT-REQUIRED` header carrying the
 *    encoded {@link X402PaymentRequiredResponse}.
 * 3. The client's `paymentPayload.accepted` must match one entry in our
 *    requirements list (scheme / network / amount / asset / payTo).
 * 4. Call `facilitator.verify`. On failure → 402 with a reason.
 * 5. Call `facilitator.settle`. On failure → 402 with a reason. On success →
 *    invoke the inner handler, attach the `PAYMENT-RESPONSE` header, return.
 *
 * Because the contract is `Request → Response`, the handler runs unchanged on
 * Node (via `@hono/node-server` or a hand-rolled adapter), Bun, Deno, Cloudflare
 * Workers, and Vercel Edge.
 *
 * @packageDocumentation
 */

import { getAddress } from "viem";
import {
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
	X402_HEADER_PAYMENT_REQUIRED,
	X402_HEADER_PAYMENT_RESPONSE,
	X402_HEADER_PAYMENT_SIGNATURE,
} from "./encoding";
import { X402InvalidPayloadError } from "./errors";
import { buildPaymentRequiredResponse } from "./payment-requirements";
import type {
	Facilitator,
	X402PaymentPayload,
	X402PaymentRequirements,
	X402ResourceInfo,
	X402SettlementResponse,
} from "./types";
import { X402_VERSION } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to the inner handler **after** a payment has been verified
 * and settled. `null` when the request bypassed the payment flow because
 * `requirementsFor` returned `null` / `[]`.
 */
export interface X402HandlerContext {
	/** The client's signed payment payload. */
	readonly paymentPayload: X402PaymentPayload;
	/** The matching requirements entry the client targeted. */
	readonly matchedRequirements: X402PaymentRequirements;
	/** Facilitator's settlement response (broadcast already happened). */
	readonly settlement: X402SettlementResponse;
}

/**
 * The inner business-logic handler. Receives the same `Request` plus a context
 * that is present when a payment was made for this request, and `null`
 * otherwise (pass-through case).
 */
export type X402InnerHandler = (
	request: Request,
	context: X402HandlerContext | null,
) => Promise<Response> | Response;

/** Parameters for {@link createX402Handler}. */
export interface CreateX402HandlerParams {
	/** Facilitator that performs verify and settle (self or HTTP-proxied). */
	readonly facilitator: Facilitator;
	/**
	 * Returns the {@link X402PaymentRequirements} that apply to this request.
	 *
	 * - Return one or more entries to require payment (client picks one).
	 * - Return `null` or `[]` to skip the payment flow entirely for this
	 *   request — the inner handler is invoked with `context = null`.
	 */
	readonly requirementsFor: (
		request: Request,
	) =>
		| Promise<readonly X402PaymentRequirements[] | null>
		| readonly X402PaymentRequirements[]
		| null;
	/** The protected business-logic handler. Invoked after settlement. */
	readonly handler: X402InnerHandler;
	/**
	 * Optional builder for the {@link X402ResourceInfo} echoed in the 402
	 * response. Defaults to `{ url: request.url }`.
	 */
	readonly resourceFor?: (request: Request) => Promise<X402ResourceInfo> | X402ResourceInfo;
}

/** The function returned by {@link createX402Handler}. */
export type X402RequestHandler = (request: Request) => Promise<Response>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultResource(request: Request): X402ResourceInfo {
	return { url: request.url };
}

function isSameRequirements(
	offered: X402PaymentRequirements,
	chosen: X402PaymentRequirements,
): boolean {
	return (
		offered.scheme === chosen.scheme &&
		offered.network === chosen.network &&
		offered.amount === chosen.amount &&
		getAddress(offered.asset) === getAddress(chosen.asset) &&
		getAddress(offered.payTo) === getAddress(chosen.payTo)
	);
}

async function paymentRequired(
	request: Request,
	requirements: readonly X402PaymentRequirements[],
	resourceFor: ((r: Request) => Promise<X402ResourceInfo> | X402ResourceInfo) | undefined,
	error: string,
): Promise<Response> {
	const resource = resourceFor ? await resourceFor(request) : defaultResource(request);
	const body = buildPaymentRequiredResponse({ resource, accepts: requirements, error });
	const headers = new Headers({ "content-type": "application/json" });
	headers.set(X402_HEADER_PAYMENT_REQUIRED, encodePaymentRequiredHeader(body));
	return new Response(JSON.stringify(body), { status: 402, headers });
}

function internalError(reason: string, cause: unknown): Response {
	const message = cause instanceof Error ? cause.message : String(cause);
	return new Response(JSON.stringify({ error: reason, message }), {
		status: 500,
		headers: { "content-type": "application/json" },
	});
}

function withPaymentResponseHeader(
	innerResponse: Response,
	settlement: X402SettlementResponse,
): Response {
	const headers = new Headers(innerResponse.headers);
	headers.set(X402_HEADER_PAYMENT_RESPONSE, encodePaymentResponseHeader(settlement));
	return new Response(innerResponse.body, {
		status: innerResponse.status,
		statusText: innerResponse.statusText,
		headers,
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds an {@link X402RequestHandler} that wraps `params.handler` with the
 * x402 payment flow.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { parseUnits } from "viem";
 * import {
 *   buildPaymentRequirements,
 *   createSelfFacilitator,
 *   createX402Handler,
 *   JPYC_DECIMALS,
 *   JPYC_V2_ADDRESS,
 *   polygonAmoy,
 * } from "kawasekit";
 *
 * const handler = createX402Handler({
 *   facilitator: createSelfFacilitator({ walletClient, publicClient }),
 *   requirementsFor: (req) =>
 *     new URL(req.url).pathname.startsWith("/weather")
 *       ? [buildPaymentRequirements({
 *           chainId: polygonAmoy.id,
 *           asset: JPYC_V2_ADDRESS,
 *           payTo: "0x...",
 *           amount: parseUnits("0.001", JPYC_DECIMALS),
 *         })]
 *       : null,
 *   handler: async (req) => new Response(JSON.stringify({ weather: "sunny" }), {
 *     headers: { "content-type": "application/json" },
 *   }),
 * });
 *
 * // Mount on any framework that exposes WHATWG Request → Response.
 * ```
 */
export function createX402Handler(params: CreateX402HandlerParams): X402RequestHandler {
	const { facilitator, requirementsFor, handler, resourceFor } = params;

	return async function x402Handler(request: Request): Promise<Response> {
		// 1. Resolve requirements (or pass through)
		let requirements: readonly X402PaymentRequirements[] | null;
		try {
			requirements = await requirementsFor(request);
		} catch (cause) {
			return internalError("requirements_resolution_failed", cause);
		}
		if (requirements === null || requirements.length === 0) {
			return handler(request, null);
		}

		// 2. Read the PAYMENT-SIGNATURE header
		const headerValue = request.headers.get(X402_HEADER_PAYMENT_SIGNATURE);
		if (headerValue === null || headerValue === "") {
			return paymentRequired(
				request,
				requirements,
				resourceFor,
				"PAYMENT-SIGNATURE header is required",
			);
		}

		// 3. Decode the payment payload
		let paymentPayload: X402PaymentPayload;
		try {
			paymentPayload = decodePaymentSignatureHeader(headerValue);
		} catch (cause) {
			const reason =
				cause instanceof X402InvalidPayloadError
					? cause.reason
					: "invalid PAYMENT-SIGNATURE header";
			return paymentRequired(request, requirements, resourceFor, reason);
		}

		// 4. Match chosen requirements to an offered entry
		const matchedRequirements = requirements.find((offered) =>
			isSameRequirements(offered, paymentPayload.accepted),
		);
		if (!matchedRequirements) {
			return paymentRequired(
				request,
				requirements,
				resourceFor,
				"paymentPayload.accepted does not match any offered requirements",
			);
		}

		// 5. Verify
		let verifyResult: Awaited<ReturnType<Facilitator["verify"]>>;
		try {
			verifyResult = await facilitator.verify({
				x402Version: X402_VERSION,
				paymentPayload,
				paymentRequirements: matchedRequirements,
			});
		} catch (cause) {
			return internalError("facilitator_verify_failed", cause);
		}
		if (!verifyResult.isValid) {
			return paymentRequired(
				request,
				requirements,
				resourceFor,
				verifyResult.invalidReason ?? "verify failed",
			);
		}

		// 6. Settle
		let settleResult: Awaited<ReturnType<Facilitator["settle"]>>;
		try {
			settleResult = await facilitator.settle({
				x402Version: X402_VERSION,
				paymentPayload,
				paymentRequirements: matchedRequirements,
			});
		} catch (cause) {
			return internalError("facilitator_settle_failed", cause);
		}
		if (!settleResult.success) {
			return paymentRequired(
				request,
				requirements,
				resourceFor,
				settleResult.errorReason ?? "settle failed",
			);
		}

		// 7. Invoke inner handler, attach PAYMENT-RESPONSE header.
		// Inner handler errors propagate — settlement has already happened.
		const context: X402HandlerContext = {
			paymentPayload,
			matchedRequirements,
			settlement: settleResult,
		};
		const innerResponse = await handler(request, context);
		return withPaymentResponseHeader(innerResponse, settleResult);
	};
}
