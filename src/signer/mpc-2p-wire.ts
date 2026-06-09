/**
 * The `mpc-2p` cross-process **wire** (v2) — the versioned `CoSignFrame` control
 * envelope + the A3 canonical-request encoding, as TypeScript source-of-truth.
 *
 * This is the public, TS-interpreted half of the two-layer wire (RFC m6-3a §4.2):
 * a small, versioned envelope carries the decoded {@link PaymentIntent} (never a
 * digest — A4) + a per-ceremony id + ssid + a freshness element, plus the opaque
 * DKLs round payloads (hex, produced/consumed only by the WASM crypto agent). The
 * shapes here mirror the deployed `kawasekit-mpc-2p` Rust serde **byte-for-byte**
 * (snake_case `wire_version`, `session_id`, `ceremony_id`, `ssid`, `freshness_ts`,
 * `freshness_nonce`, `auth_tag`; the string-encoded {@link WireIntent}), so a frame
 * the SDK builds round-trips through the backend's `serde_json`.
 *
 * `canonicalRequestBytes` is the A3 analog of the EIP-712 digest corpus: it
 * reproduces the backend's `auth::canonical_request_bytes` exactly, so the injected
 * authenticator's HMAC equals what the co-signer verifies (RFC §4.6:
 * `HMAC_k(wireVersion ‖ ceremonyId ‖ ssid ‖ canonical(intent) ‖ freshness)`).
 *
 * @packageDocumentation
 */

import type { Hex } from "viem";
import type { PaymentIntent } from "./types";

/** The wire protocol version. A frame whose `wire_version` differs is rejected. */
export const WIRE_VERSION = 2 as const;

/**
 * The string-encoded EIP-3009 intent as it crosses the wire — lowercase `0x`
 * addresses, **decimal** integer strings, `0x` hex nonce. Decoupled from any
 * library's native serde so a stdlib client reproduces it trivially; matches the
 * Rust `WireIntent` field names + encoding exactly.
 */
export interface WireIntent {
	readonly token: string;
	readonly chain_id: number;
	readonly from: string;
	readonly to: string;
	readonly value: string;
	readonly valid_after: string;
	readonly valid_before: string;
	readonly nonce: string;
}

/** Encode a decoded {@link PaymentIntent} for the wire. */
export function toWireIntent(intent: PaymentIntent): WireIntent {
	return {
		token: intent.token.toLowerCase(),
		chain_id: intent.chainId,
		from: intent.from.toLowerCase(),
		to: intent.to.toLowerCase(),
		value: intent.value.toString(),
		valid_after: intent.validAfter.toString(),
		valid_before: intent.validBefore.toString(),
		nonce: intent.nonce.toLowerCase(),
	};
}

/**
 * The A3 request envelope the adapter generates per `sign()` and authenticates: a
 * per-ceremony id + ssid (bound into the A3 tag) + the intent + a freshness element
 * (a timestamp + a per-request nonce distinct from the EIP-3009 nonce).
 */
export interface CoSignRequestEnvelope {
	readonly ceremonyId: string;
	readonly ssid: string;
	readonly intent: PaymentIntent;
	/** Unix seconds; the backend checks it against a clock-skew window. */
	readonly freshnessTs: number;
	/** `0x` hex, distinct from the EIP-3009 nonce — the anti-replay key. */
	readonly freshnessNonce: Hex;
}

/**
 * A versioned control frame: the only cross-language content of the wire. The
 * DKLs round bytes ride opaque inside `payload`; everything else is the small,
 * pinned envelope. Internally tagged by `kind` (matches the Rust serde).
 */
export type CoSignFrame = { readonly wire_version: typeof WIRE_VERSION } & (
	| {
			readonly kind: "request";
			readonly session_id: string;
			readonly ceremony_id: string;
			readonly ssid: string;
			readonly intent: WireIntent;
			readonly freshness_ts: number;
			readonly freshness_nonce: Hex;
			/** A3 authenticator over {@link canonicalRequestBytes}, `0x`-hex. */
			readonly auth_tag: Hex;
	  }
	| { readonly kind: "round"; readonly payload: Hex }
	| { readonly kind: "result"; readonly r: Hex; readonly s: Hex; readonly v: number }
	| { readonly kind: "rejection"; readonly reason: string; readonly detail: string }
	| { readonly kind: "error"; readonly message: string }
);

/**
 * The A3 canonical encoding of a request — a byte-exact mirror of the backend's
 * `auth::canonical_request_bytes` (domain-tag `kawasekit-mpc-2p/cosign-request/v3`,
 * one `key=value\n` line per field: `wireVersion ‖ ceremonyId ‖ ssid ‖
 * canonical(intent) ‖ freshness`; lowercase `0x` addresses + freshness nonce,
 * decimal integers, trailing newline). The injected authenticator HMACs these
 * bytes; because the encoding is shared, the tag equals the co-signer's.
 */
export function canonicalRequestBytes(env: CoSignRequestEnvelope): Uint8Array {
	const i = env.intent;
	const lines = [
		"kawasekit-mpc-2p/cosign-request/v3",
		"wireVersion=2",
		`ceremonyId=${env.ceremonyId}`,
		`ssid=${env.ssid}`,
		`token=${i.token.toLowerCase()}`,
		`chainId=${i.chainId}`,
		`from=${i.from.toLowerCase()}`,
		`to=${i.to.toLowerCase()}`,
		`value=${i.value}`,
		`validAfter=${i.validAfter}`,
		`validBefore=${i.validBefore}`,
		`nonce=${i.nonce.toLowerCase()}`,
		`freshnessTs=${env.freshnessTs}`,
		`freshnessNonce=${env.freshnessNonce.toLowerCase()}`,
	];
	return new TextEncoder().encode(lines.map((l) => `${l}\n`).join(""));
}
