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

import type { Hex } from "viem";
import { getAddress } from "viem";
import {
	createInMemoryIdempotencyStore,
	type IdempotencyLease,
	type IdempotencyLookupResult,
	type IdempotencyRecord,
	type IdempotencyResponseSnapshot,
	type IdempotencyStore,
	KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
} from "../idempotency";
import {
	extractAcceptedNetworks,
	invokeHookSafely,
	type ObservabilityHooks,
	type PaymentAcceptedEvent,
	type PaymentRequiredEvent,
} from "../observability/hooks";
import {
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
	X402_HEADER_IDEMPOTENCY_KEY,
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
	/**
	 * Optional observability callbacks. The handler emits `onPaymentRequired`
	 * each time it returns a 402, and `onPaymentAccepted` after a settled
	 * payment unlocks the inner handler. Hooks are fire-and-forget — see
	 * {@link ObservabilityHooks}.
	 */
	readonly hooks?: ObservabilityHooks;
	/**
	 * Reasoning-step idempotency (M5-1, Half A). **Default-on**: when omitted, an
	 * in-memory store deduplicates re-sent / concurrent paid requests — replaying
	 * the cached response and closing the verify→settle TOCTOU. Pass
	 * `{ store: "none" }` to disable, or a shared store (Redis/SQL adapter) for
	 * multi-replica deployments (the in-memory default is single-process).
	 * Fund-correctness never depends on this store — the on-chain EIP-3009 nonce
	 * is the backstop.
	 */
	readonly idempotency?: IdempotencyServerConfig;
}

/** Server-side idempotency configuration (M5-1). See {@link CreateX402HandlerParams.idempotency}. */
export interface IdempotencyServerConfig {
	/** The store, or `"none"` to disable. Default: a fresh in-memory bounded LRU. */
	readonly store?: IdempotencyStore | "none";
	/**
	 * What to do when a concurrent request holds the in-flight lease for the same
	 * key. `"reject"` (default) returns a `payment_in_progress` 402 (the client
	 * retries and gets the cached result); `"await"` polls briefly for the twin
	 * to complete, then replays its response.
	 */
	readonly inFlight?: "await" | "reject";
	/** Max captured response body size for replay, in bytes. Default 65536 (64 KiB). */
	readonly maxSnapshotBytes?: number;
	/** Fallback record TTL in seconds when the authorization `validBefore` is unreadable. Default 86400. */
	readonly fallbackTtlSeconds?: number;
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
// Idempotency (M5-1) helpers
// ---------------------------------------------------------------------------

/** Credential-safe header allowlist preserved in a replayed response. */
const SNAPSHOT_HEADER_ALLOWLIST = ["content-type", X402_HEADER_PAYMENT_RESPONSE];
const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024;
const DEFAULT_FALLBACK_TTL_SECONDS = 86_400;

interface ResolvedIdempotency {
	readonly store: IdempotencyStore;
	readonly inFlight: "await" | "reject";
	readonly maxSnapshotBytes: number;
	readonly fallbackTtlSeconds: number;
}

/** Resolve the (default-on) idempotency config once per handler construction. */
function resolveIdempotency(
	config: IdempotencyServerConfig | undefined,
): ResolvedIdempotency | null {
	if (config?.store === "none") {
		return null;
	}
	return {
		store: config?.store ?? createInMemoryIdempotencyStore(),
		inFlight: config?.inFlight ?? "reject",
		maxSnapshotBytes: config?.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
		fallbackTtlSeconds: config?.fallbackTtlSeconds ?? DEFAULT_FALLBACK_TTL_SECONDS,
	};
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** Defensively read the EIP-3009 nonce + validBefore from an opaque payload. */
function readAuthorization(
	payload: X402PaymentPayload,
): { readonly nonce: string; readonly validBefore: bigint } | null {
	const inner = payload.payload;
	if (typeof inner !== "object" || inner === null) {
		return null;
	}
	const auth = (inner as { authorization?: unknown }).authorization;
	if (typeof auth !== "object" || auth === null) {
		return null;
	}
	const a = auth as { nonce?: unknown; validBefore?: unknown };
	if (typeof a.nonce !== "string" || a.nonce === "") {
		return null;
	}
	const validBefore =
		typeof a.validBefore === "string" && /^[0-9]+$/.test(a.validBefore)
			? BigInt(a.validBefore)
			: 0n;
	return { nonce: a.nonce, validBefore };
}

/**
 * The server dedup key: the client `Idempotency-Key` header when present (the
 * logical reasoning-step key, working even for signers that cannot derive a
 * nonce), else the EIP-3009 nonce — both namespaced by (network, payTo, asset)
 * for cross-tenant isolation. `null` ⇒ no key can be formed; dedup is skipped
 * (the on-chain nonce still backstops fund-correctness).
 */
function computeServerKey(
	request: Request,
	requirements: X402PaymentRequirements,
	auth: { readonly nonce: string } | null,
): string | null {
	const header = request.headers.get(X402_HEADER_IDEMPOTENCY_KEY);
	let material: string;
	if (header !== null && header !== "") {
		material = `hdr:${header}`;
	} else if (auth !== null) {
		material = `nonce:${auth.nonce}`;
	} else {
		return null;
	}
	return JSON.stringify([
		requirements.network,
		getAddress(requirements.payTo),
		getAddress(requirements.asset),
		material,
	]);
}

/**
 * Snapshot a response for replay, reading from a clone so the original body
 * stays intact. `undefined` if the body exceeds `maxBytes` (the record then
 * stores only the settlement for a minimal replay).
 */
async function snapshotResponse(
	response: Response,
	maxBytes: number,
): Promise<IdempotencyResponseSnapshot | undefined> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null && Number(contentLength) > maxBytes) {
		return undefined;
	}
	const buffer = await response.clone().arrayBuffer();
	if (buffer.byteLength > maxBytes) {
		return undefined;
	}
	const headers: Array<readonly [string, string]> = [];
	for (const name of SNAPSHOT_HEADER_ALLOWLIST) {
		const value = response.headers.get(name);
		if (value !== null) {
			headers.push([name, value]);
		}
	}
	return { status: response.status, headers, bodyBase64: bytesToBase64(new Uint8Array(buffer)) };
}

/** Rebuild a response from a completed record (replay path), tagged for clients. */
function replayResponse(record: IdempotencyRecord): Response {
	const snapshot = record.responseSnapshot;
	if (snapshot !== undefined) {
		const headers = new Headers();
		for (const [name, value] of snapshot.headers) {
			headers.set(name, value);
		}
		headers.set(IDEMPOTENCY_REPLAYED_HEADER, "true");
		return new Response(base64ToBytes(snapshot.bodyBase64), { status: snapshot.status, headers });
	}
	const headers = new Headers({ [IDEMPOTENCY_REPLAYED_HEADER]: "true" });
	headers.set(
		X402_HEADER_PAYMENT_RESPONSE,
		encodePaymentResponseHeader({
			success: true,
			transaction: record.txHash,
			network: record.network,
			payer: record.payer,
			amount: record.amount,
		}),
	);
	return new Response(null, { status: 200, headers });
}

function buildRecord(
	key: string,
	settlement: X402SettlementResponse,
	requirements: X402PaymentRequirements,
	validBefore: bigint,
	fallbackTtlSeconds: number,
	snapshot: IdempotencyResponseSnapshot | undefined,
): IdempotencyRecord | null {
	if (settlement.transaction === "" || settlement.payer === undefined) {
		return null;
	}
	const nowSec = BigInt(Math.floor(Date.now() / 1000));
	const expiresAt = validBefore > nowSec ? validBefore : nowSec + BigInt(fallbackTtlSeconds);
	return {
		kawasekitVersion: KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
		key,
		// settlement.transaction is the on-chain tx hash (0x-hex) the facilitator broadcast.
		txHash: settlement.transaction as Hex,
		payer: settlement.payer,
		amount: settlement.amount ?? requirements.amount,
		network: requirements.network,
		...(snapshot !== undefined ? { responseSnapshot: snapshot } : {}),
		expiresAt,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

const IN_FLIGHT_POLL_MS = 100;
const IN_FLIGHT_MAX_POLLS = 50; // ~5s bounded wait for the "await" policy

/** Release an owned in-flight lease so the step can be retried (best-effort). */
async function releaseLease(
	idem: ResolvedIdempotency | null,
	key: string | null,
	lease: IdempotencyLease | null,
): Promise<void> {
	if (idem !== null && key !== null && lease !== null) {
		try {
			await idem.store.abandon(key, lease);
		} catch {
			// best-effort: the lease will also expire on its own (crash-recovery TTL).
		}
	}
}

/**
 * For the `"await"` in-flight policy, poll briefly for a concurrent twin to
 * complete. Returns its record to replay, or `null` to fall back to the reject
 * path (twin still running past the budget, or it died and freed the slot).
 */
async function resolveInFlight(
	idem: ResolvedIdempotency,
	key: string,
): Promise<IdempotencyRecord | null> {
	if (idem.inFlight !== "await") {
		return null;
	}
	for (let i = 0; i < IN_FLIGHT_MAX_POLLS; i += 1) {
		await sleep(IN_FLIGHT_POLL_MS);
		let lookup: IdempotencyLookupResult;
		try {
			lookup = await idem.store.begin(key);
		} catch {
			return null;
		}
		if (lookup.status === "completed") {
			return lookup.record;
		}
		if (lookup.status === "fresh") {
			// The twin died and we now hold the lease; release it and let the
			// caller reject (the client retries and settles cleanly).
			await releaseLease(idem, key, lookup.lease);
			return null;
		}
		// still in_flight → keep polling
	}
	return null;
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
	const { facilitator, requirementsFor, handler, resourceFor, hooks } = params;
	// Resolved ONCE so the in-memory store persists across requests (the Hono
	// adapter rebuilds the handler per request, so this must live in the closure).
	const idempotency = resolveIdempotency(params.idempotency);

	return async function x402Handler(request: Request): Promise<Response> {
		const startedAtMs = Date.now();

		const emitPaymentRequired = (
			reqs: readonly X402PaymentRequirements[],
			error: string,
		): Promise<Response> => {
			const event: PaymentRequiredEvent = {
				kind: "payment_required",
				startedAtMs,
				durationMs: Date.now() - startedAtMs,
				requestUrl: request.url,
				acceptedNetworks: extractAcceptedNetworks(reqs),
			};
			invokeHookSafely(hooks?.onPaymentRequired, event);
			return paymentRequired(request, reqs, resourceFor, error);
		};

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
			return emitPaymentRequired(requirements, "PAYMENT-SIGNATURE header is required");
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
			return emitPaymentRequired(requirements, reason);
		}

		// 4. Match chosen requirements to an offered entry
		const matchedRequirements = requirements.find((offered) =>
			isSameRequirements(offered, paymentPayload.accepted),
		);
		if (!matchedRequirements) {
			return emitPaymentRequired(
				requirements,
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
			return emitPaymentRequired(requirements, verifyResult.invalidReason ?? "verify failed");
		}

		// 5b. Reasoning-step idempotency gate (M5-1, Half A). Runs AFTER verify so a
		// cached response is only released against a re-verified authorization.
		const auth = readAuthorization(paymentPayload);
		const idemKey =
			idempotency !== null ? computeServerKey(request, matchedRequirements, auth) : null;
		let lease: IdempotencyLease | null = null;
		if (idempotency !== null && idemKey !== null) {
			let lookup: IdempotencyLookupResult;
			try {
				lookup = await idempotency.store.begin(idemKey);
			} catch (cause) {
				return internalError("idempotency_store_failed", cause);
			}
			if (lookup.status === "completed") {
				return replayResponse(lookup.record);
			}
			if (lookup.status === "in_flight") {
				const awaited = await resolveInFlight(idempotency, idemKey);
				if (awaited !== null) {
					return replayResponse(awaited);
				}
				return emitPaymentRequired(requirements, "payment_in_progress");
			}
			lease = lookup.lease;
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
			await releaseLease(idempotency, idemKey, lease);
			return internalError("facilitator_settle_failed", cause);
		}
		if (!settleResult.success) {
			await releaseLease(idempotency, idemKey, lease);
			return emitPaymentRequired(requirements, settleResult.errorReason ?? "settle failed");
		}

		// 7. Settled — emit onPaymentAccepted then invoke inner handler.
		if (settleResult.payer !== undefined) {
			const acceptedEvent: PaymentAcceptedEvent = {
				kind: "payment_accepted",
				startedAtMs,
				durationMs: Date.now() - startedAtMs,
				requestUrl: request.url,
				payer: settleResult.payer,
				amount: settleResult.amount ?? matchedRequirements.amount,
				network: matchedRequirements.network,
				transaction: settleResult.transaction as Hex,
			};
			invokeHookSafely(hooks?.onPaymentAccepted, acceptedEvent);
		}

		// Inner handler errors propagate — settlement has already happened.
		const context: X402HandlerContext = {
			paymentPayload,
			matchedRequirements,
			settlement: settleResult,
		};
		const innerResponse = await handler(request, context);
		const finalResponse = withPaymentResponseHeader(innerResponse, settleResult);

		// 7b. Record the settled response for replay-on-duplicate (best-effort —
		// fund-correctness is guaranteed on-chain regardless of the store).
		if (idempotency !== null && idemKey !== null && lease !== null) {
			const snapshot = await snapshotResponse(finalResponse, idempotency.maxSnapshotBytes);
			const record = buildRecord(
				idemKey,
				settleResult,
				matchedRequirements,
				auth?.validBefore ?? 0n,
				idempotency.fallbackTtlSeconds,
				snapshot,
			);
			if (record !== null) {
				try {
					await idempotency.store.complete(idemKey, record, lease);
				} catch {
					// Completing the cache is best-effort; on-chain nonce is the backstop.
				}
			} else {
				await releaseLease(idempotency, idemKey, lease);
			}
		}
		return finalResponse;
	};
}
