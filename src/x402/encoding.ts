/**
 * Wire-format encoding for x402 v2 headers.
 *
 * Three pairs of `encode*` / `decode*` helpers, one per x402 v2 HTTP header:
 *
 * | Direction        | Header              | Payload type                     |
 * | ---------------- | ------------------- | -------------------------------- |
 * | server → client  | `PAYMENT-REQUIRED`  | {@link X402PaymentRequiredResponse} |
 * | client → server  | `PAYMENT-SIGNATURE` | {@link X402PaymentPayload}          |
 * | server → client  | `PAYMENT-RESPONSE`  | {@link X402SettlementResponse}      |
 *
 * Encoding rules (match `@x402/core@2.13.0` byte-for-byte so kawasekit payloads
 * decode in any spec-compliant client / facilitator):
 *
 * - The payload is JSON-stringified, then UTF-8 → base64 encoded.
 * - **Standard base64** with `+` / `/` and `=` padding, **not** URL-safe base64.
 *   (Header values flow through `Authorization`-style positions where `+` is
 *   acceptable in the v2 spec.)
 * - The replacer used by `JSON.stringify` rewrites any stray `bigint` value to
 *   its decimal string form, so kawasekit callers can hand a payload whose
 *   `value` / `validAfter` / `validBefore` are bigints by mistake and the
 *   encoder still produces a spec-conformant string — silent corruption
 *   surfaces as a type error in `tsc`, not a runtime crash.
 *
 * Decoders are intentionally minimal: base64 syntax check + `JSON.parse` + a
 * "must be a plain object" sanity check. Schema-level validation lives one
 * layer up (in `server.ts` and `client.ts`) so that this module stays a small,
 * dependency-free wire codec.
 *
 * @packageDocumentation
 */

import { X402InvalidPayloadError } from "./errors";
import type {
	X402PaymentPayload,
	X402PaymentRequiredResponse,
	X402SettlementResponse,
} from "./types";

// ---------------------------------------------------------------------------
// HTTP header names (x402 v2 transport spec)
// ---------------------------------------------------------------------------

/**
 * Name of the response header that carries the base64-encoded
 * {@link X402PaymentRequiredResponse} alongside the HTTP 402 status.
 */
export const X402_HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED" as const;

/**
 * Name of the request header that carries the client's base64-encoded
 * {@link X402PaymentPayload}.
 *
 * Note: x402 v1 used `X-PAYMENT`. v2 drops the `X-` prefix. Servers may accept
 * both during transition; clients should send only this v2 name.
 */
export const X402_HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE" as const;

/**
 * Name of the response header that carries the base64-encoded
 * {@link X402SettlementResponse} after a successful settlement.
 */
export const X402_HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE" as const;

/**
 * Name of the optional request header that carries a reasoning-step idempotency
 * key (M5-1). Standard `Idempotency-Key` (IETF draft / Stripe-compatible). When
 * present, the x402 server deduplicates on this logical key; the EIP-3009 nonce
 * remains the on-chain fund backstop. See `docs/rfc/m5-1-reasoning-step-idempotency.md`.
 */
export const X402_HEADER_IDEMPOTENCY_KEY = "Idempotency-Key" as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Canonical base64 per RFC 4648 §4: encoded length is a multiple of 4 and the
// only legal trailing forms are `XX==`, `XXX=`, or `XXXX` (no padding). The
// outer prefix is zero or more 4-char groups; the optional inner alternation
// matches a single final group of 4 chars or a properly padded 2-or-3 char
// group. This shape rejects the non-canonical forms an adversary could try
// to smuggle past the decoder — overlong padding (`X===`), misplaced padding
// (`X=XX`), short tails (`XXX` with no `=`), or non-mod-4 lengths.
//
// See `docs/THREAT_MODEL.md` §6.7 for the M4 review trail and
// `src/x402/encoding.test.ts` "RFC 4648 canonical enforcement" for the
// adversarial corpus.
/**
 * Strict RFC 4648 §4 canonical base64 matcher. Exported for the
 * property-based test in `encoding.test.ts` (Threat 1.7 / §6.7
 * regex-vs-decoder agreement); not intended as part of the public API.
 *
 * @internal
 */
export const BASE64_REGEX =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$/;

function bigIntReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

function stringifyBigIntSafe(value: unknown): string {
	return JSON.stringify(value, bigIntReplacer);
}

function utf8ToBase64(input: string): string {
	// Cross-env: prefer `btoa` (browsers, Workers, Bun, modern Node 18+) and
	// fall back to `Buffer` for older Node where `btoa` was Latin-1-only.
	if (typeof globalThis.btoa === "function") {
		const bytes = new TextEncoder().encode(input);
		let binary = "";
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return globalThis.btoa(binary);
	}
	return Buffer.from(input, "utf8").toString("base64");
}

/**
 * Internal helper exported for the regex-vs-decoder property-based test.
 * Not part of the public API.
 *
 * @internal
 */
export function base64ToUtf8(input: string): string {
	if (typeof globalThis.atob === "function") {
		const binary = globalThis.atob(input);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new TextDecoder("utf-8").decode(bytes);
	}
	return Buffer.from(input, "base64").toString("utf8");
}

function decodeHeader<T>(headerName: string, headerValue: string): T {
	if (!BASE64_REGEX.test(headerValue)) {
		throw new X402InvalidPayloadError(headerName, "header is not valid base64");
	}
	let json: string;
	try {
		json = base64ToUtf8(headerValue);
	} catch (cause) {
		throw new X402InvalidPayloadError(headerName, "base64 decode failed", { cause });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (cause) {
		throw new X402InvalidPayloadError(headerName, "decoded value is not valid JSON", { cause });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new X402InvalidPayloadError(headerName, "decoded value is not a JSON object");
	}
	return parsed as T;
}

// ---------------------------------------------------------------------------
// PAYMENT-REQUIRED
// ---------------------------------------------------------------------------

/**
 * Encodes an {@link X402PaymentRequiredResponse} as a base64 string suitable
 * for the `PAYMENT-REQUIRED` response header.
 *
 * @example
 * ```ts
 * import { encodePaymentRequiredHeader } from "kawasekit";
 *
 * const headerValue = encodePaymentRequiredHeader({
 *   x402Version: 2,
 *   resource: { url: "https://api.example.com/data" },
 *   accepts: [],
 * });
 * res.setHeader("PAYMENT-REQUIRED", headerValue);
 * ```
 */
export function encodePaymentRequiredHeader(payload: X402PaymentRequiredResponse): string {
	return utf8ToBase64(stringifyBigIntSafe(payload));
}

/**
 * Decodes a `PAYMENT-REQUIRED` header value.
 *
 * @throws {X402InvalidPayloadError} If the header is not valid base64 / JSON /
 *   object.
 */
export function decodePaymentRequiredHeader(headerValue: string): X402PaymentRequiredResponse {
	return decodeHeader<X402PaymentRequiredResponse>(X402_HEADER_PAYMENT_REQUIRED, headerValue);
}

// ---------------------------------------------------------------------------
// PAYMENT-SIGNATURE
// ---------------------------------------------------------------------------

/**
 * Encodes an {@link X402PaymentPayload} as a base64 string suitable for the
 * `PAYMENT-SIGNATURE` request header.
 *
 * @example
 * ```ts
 * import { encodePaymentSignatureHeader } from "kawasekit";
 *
 * const headerValue = encodePaymentSignatureHeader(paymentPayload);
 * await fetch(url, { headers: { "PAYMENT-SIGNATURE": headerValue } });
 * ```
 */
export function encodePaymentSignatureHeader(payload: X402PaymentPayload): string {
	return utf8ToBase64(stringifyBigIntSafe(payload));
}

/**
 * Decodes a `PAYMENT-SIGNATURE` header value.
 *
 * @throws {X402InvalidPayloadError} If the header is not valid base64 / JSON /
 *   object.
 */
export function decodePaymentSignatureHeader(headerValue: string): X402PaymentPayload {
	return decodeHeader<X402PaymentPayload>(X402_HEADER_PAYMENT_SIGNATURE, headerValue);
}

// ---------------------------------------------------------------------------
// PAYMENT-RESPONSE
// ---------------------------------------------------------------------------

/**
 * Encodes an {@link X402SettlementResponse} as a base64 string suitable for
 * the `PAYMENT-RESPONSE` response header.
 */
export function encodePaymentResponseHeader(payload: X402SettlementResponse): string {
	return utf8ToBase64(stringifyBigIntSafe(payload));
}

/**
 * Decodes a `PAYMENT-RESPONSE` header value.
 *
 * @throws {X402InvalidPayloadError} If the header is not valid base64 / JSON /
 *   object.
 */
export function decodePaymentResponseHeader(headerValue: string): X402SettlementResponse {
	return decodeHeader<X402SettlementResponse>(X402_HEADER_PAYMENT_RESPONSE, headerValue);
}
