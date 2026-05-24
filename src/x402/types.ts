/**
 * x402 v2 wire-format types — the canonical shapes that travel over HTTP between
 * client, resource server, and facilitator.
 *
 * These types are deliberately **spec-faithful**: field names, optionality, and
 * value encoding (e.g. `uint256` as decimal string) match the x402 v2
 * specification verbatim so that payloads kawasekit produces are byte-equivalent
 * to those from `@x402/core` and other reference implementations. Where the
 * spec allows a string union (e.g. `network`, `scheme`), kawasekit narrows the
 * type to the values it actually supports — but every kawasekit type is
 * structurally assignable to its `@x402/core` counterpart.
 *
 * For the EVM `exact` scheme (the only scheme kawasekit implements in M3) the
 * settlement mechanism is EIP-3009 `transferWithAuthorization`. Permit2 and
 * ERC-7710 are deferred.
 *
 * See:
 * - x402 v2 spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 * - exact-EVM scheme: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 *
 * @packageDocumentation
 */

import type { Address, Hex } from "viem";
import type { SupportedChainId } from "../chains";
import { isSupportedChainId } from "../chains";

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/**
 * Current x402 protocol version implemented by kawasekit.
 *
 * v2 is the wire format that uses CAIP-2 network identifiers (`eip155:N`) and
 * separates {@link X402ResourceInfo} from {@link X402PaymentRequirements}. v1 is
 * deprecated and not supported.
 */
export const X402_VERSION = 2 as const;

/** Literal type of {@link X402_VERSION}. */
export type X402Version = typeof X402_VERSION;

// ---------------------------------------------------------------------------
// Scheme & network
// ---------------------------------------------------------------------------

/**
 * Payment scheme identifier.
 *
 * Only `"exact"` is implemented in M3. The spec is extensible (`"upto"`,
 * `"batch-settlement"`, …); future kawasekit milestones may widen this union.
 */
export type X402Scheme = "exact";

/**
 * CAIP-2 network identifier in `eip155:{chainId}` form, narrowed to chains
 * kawasekit supports.
 *
 * Adding a chain to {@link SupportedChainId} automatically extends this union.
 *
 * @example
 * ```ts
 * const net: X402Network = "eip155:80002"; // Polygon Amoy
 * ```
 */
export type X402Network = `eip155:${SupportedChainId}`;

/**
 * Asset transfer method advertised inside `PaymentRequirements.extra` for the
 * EVM `exact` scheme.
 *
 * kawasekit M3 only implements `"eip3009"`. The other values exist so that
 * inbound payloads from interoperable servers can be parsed without losing
 * information, even though kawasekit will reject them at validation time.
 */
export type X402AssetTransferMethod = "eip3009" | "permit2" | "erc7710";

/**
 * Conventional shape of `PaymentRequirements.extra` for the exact-EVM scheme.
 *
 * `name` and `version` MUST match the EIP-712 domain values used by the token
 * (for JPYC: `name = "JPY Coin"`, `version = "1"` — see
 * `JPYC_EIP712_DOMAIN_HINT`). Servers may include additional fields; this
 * interface is intentionally open via the index signature.
 */
export interface X402ExactEvmExtra {
	readonly assetTransferMethod?: X402AssetTransferMethod;
	readonly name: string;
	readonly version: string;
	readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Resource & requirements
// ---------------------------------------------------------------------------

/**
 * Describes the resource being paid for.
 *
 * In v2 this object lives at the top level of {@link X402PaymentRequiredResponse}
 * (and is echoed back optionally inside {@link X402PaymentPayload}), so that a
 * single payment offer can describe one resource served at one URL.
 */
export interface X402ResourceInfo {
	readonly url: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly serviceName?: string;
	readonly tags?: readonly string[];
	readonly iconUrl?: string;
}

/**
 * One acceptable payment method, as advertised by the resource server.
 *
 * Field encoding follows the wire format exactly:
 * - `amount` is a **decimal string** of atomic token units (`uint256`-safe).
 * - `asset` and `payTo` are 0x-prefixed addresses; case is not normalised at
 *   this layer (the verifier MUST checksum-compare).
 * - `maxTimeoutSeconds` is the max wall-clock time the client may take to
 *   produce a signed payload after receiving the 402 response.
 *
 * `extra` is required (matching `@x402/core`) so that producers always provide
 * the EIP-712 domain hint needed for signature verification. The most common
 * shape is {@link X402ExactEvmExtra}.
 */
export interface X402PaymentRequirements {
	readonly scheme: X402Scheme;
	readonly network: X402Network;
	readonly amount: string;
	readonly asset: Address;
	readonly payTo: Address;
	readonly maxTimeoutSeconds: number;
	readonly extra: Record<string, unknown>;
}

/**
 * The JSON body returned by a resource server alongside the "Payment Required"
 * response (HTTP 402, or the transport equivalent).
 *
 * `accepts` is an OR-list: the client picks **one** entry and produces a
 * matching {@link X402PaymentPayload}.
 */
export interface X402PaymentRequiredResponse {
	readonly x402Version: X402Version;
	readonly error?: string;
	readonly resource: X402ResourceInfo;
	readonly accepts: readonly X402PaymentRequirements[];
	readonly extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Payment payload (client → server)
// ---------------------------------------------------------------------------

/**
 * EIP-3009 `TransferWithAuthorization` parameters in **wire format**.
 *
 * Note that `value`, `validAfter`, and `validBefore` are decimal strings here
 * (uint256-safe over JSON), whereas the in-process EIP-712 signing helpers in
 * `src/tokens/eip3009.ts` use `bigint`. Converters between the two
 * representations live in `src/x402/encoding.ts`.
 *
 * `nonce` is a 0x-prefixed 32-byte hex string — generate one with
 * {@link generateAuthorizationNonce} from `src/tokens/eip3009.ts`.
 */
export interface X402ExactEvmAuthorization {
	readonly from: Address;
	readonly to: Address;
	readonly value: string;
	readonly validAfter: string;
	readonly validBefore: string;
	readonly nonce: Hex;
}

/**
 * Scheme-specific `payload` body for the exact-EVM scheme using EIP-3009.
 *
 * `signature` is the 65-byte EIP-712 signature over a
 * `TransferWithAuthorization` message, produced by
 * {@link signTransferWithAuthorization}.
 */
export interface X402ExactEvmPayload {
	readonly signature: Hex;
	readonly authorization: X402ExactEvmAuthorization;
}

/**
 * The JSON body the client sends to a paywalled resource (typically base64-
 * encoded inside an `X-PAYMENT` header — see `src/x402/encoding.ts`).
 *
 * `accepted` is the single {@link X402PaymentRequirements} entry the client
 * chose from the server's `accepts` list. `payload` is scheme-specific; for
 * the exact-EVM scheme it has the shape of {@link X402ExactEvmPayload}.
 *
 * `payload` is typed as the open `Record<string, unknown>` so that this
 * interface stays structurally compatible with `@x402/core`'s `PaymentPayload`.
 * Use a scheme-aware parser to narrow it.
 */
export interface X402PaymentPayload {
	readonly x402Version: X402Version;
	readonly resource?: X402ResourceInfo;
	readonly accepted: X402PaymentRequirements;
	readonly payload: Record<string, unknown>;
	readonly extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Settlement response (server → client, after settlement)
// ---------------------------------------------------------------------------

/**
 * The JSON body the resource server returns once the facilitator has settled
 * the payment (typically base64-encoded inside an `X-PAYMENT-RESPONSE`
 * header).
 *
 * On failure, `transaction` is an empty string and `errorReason` is set.
 */
export interface X402SettlementResponse {
	readonly success: boolean;
	readonly errorReason?: string;
	readonly errorMessage?: string;
	readonly payer?: Address;
	readonly transaction: string;
	readonly network: X402Network;
	readonly amount?: string;
	readonly extensions?: Record<string, unknown>;
	readonly extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Facilitator HTTP API (server ↔ facilitator)
// ---------------------------------------------------------------------------

/**
 * Body of `POST /verify` — asks the facilitator whether a payment payload
 * would settle, without broadcasting anything.
 */
export interface X402VerifyRequest {
	readonly x402Version: X402Version;
	readonly paymentPayload: X402PaymentPayload;
	readonly paymentRequirements: X402PaymentRequirements;
}

/** Response from `POST /verify`. */
export interface X402VerifyResponse {
	readonly isValid: boolean;
	readonly invalidReason?: string;
	readonly invalidMessage?: string;
	readonly payer?: Address;
	readonly extensions?: Record<string, unknown>;
	readonly extra?: Record<string, unknown>;
}

/**
 * Body of `POST /settle` — same shape as {@link X402VerifyRequest}. The
 * facilitator broadcasts the transaction and returns an
 * {@link X402SettlementResponse}.
 */
export type X402SettleRequest = X402VerifyRequest;

/** Response from `POST /settle`. Same shape as {@link X402SettlementResponse}. */
export type X402SettleResponse = X402SettlementResponse;

/**
 * One supported (scheme, network) pair returned by `GET /supported`.
 *
 * `network` is intentionally typed as `string` (not {@link X402Network}) here:
 * the facilitator may advertise networks kawasekit has not yet whitelisted, and
 * `kawasekit/x402` must be able to read that response to gate features (e.g.
 * skip the Coinbase facilitator demo when Polygon Amoy is not listed).
 */
export interface X402SupportedKind {
	readonly x402Version: X402Version;
	readonly scheme: string;
	readonly network: string;
	readonly extra?: Record<string, unknown>;
}

/** Response from `GET /supported`. */
export interface X402SupportedResponse {
	readonly kinds: readonly X402SupportedKind[];
	readonly extensions: readonly string[];
	readonly signers: Readonly<Record<string, readonly Address[]>>;
}

/**
 * A facilitator endpoint kawasekit can talk to.
 *
 * Two implementations live in `src/x402/facilitator.ts`:
 * - `createCoinbaseFacilitator()` — proxies to Coinbase CDP `/verify` & `/settle`
 * - `createSelfFacilitator()` — runs `transferWithAuthorization` from a
 *   private key kawasekit holds locally (testnet / self-host case)
 *
 * `createX402Handler()` accepts any object satisfying this interface and is
 * agnostic to the underlying transport (HTTPS, in-process, mocked).
 */
export interface Facilitator {
	/** Verify a payment payload without broadcasting. */
	verify(request: X402VerifyRequest): Promise<X402VerifyResponse>;
	/** Settle a verified payment — broadcasts to the chain. */
	settle(request: X402SettleRequest): Promise<X402SettleResponse>;
	/** List supported (scheme, network) pairs. */
	supported(): Promise<X402SupportedResponse>;
}

// ---------------------------------------------------------------------------
// SupportedChainId ↔ X402Network conversions
// ---------------------------------------------------------------------------

const EIP155_PREFIX = "eip155:" as const;

/**
 * Builds the CAIP-2 {@link X402Network} string for a kawasekit-supported chain.
 *
 * @example
 * ```ts
 * import { chainIdToX402Network, polygonAmoy } from "kawasekit";
 *
 * const network = chainIdToX402Network(polygonAmoy.id); // "eip155:80002"
 * ```
 */
export function chainIdToX402Network<TChainId extends SupportedChainId>(
	chainId: TChainId,
): `eip155:${TChainId}` {
	return `${EIP155_PREFIX}${chainId}` as `eip155:${TChainId}`;
}

/**
 * Type guard for {@link X402Network}.
 *
 * Accepts only `eip155:N` strings where `N` is a kawasekit-supported chain ID.
 * A facilitator response advertising e.g. `"eip155:8453"` (Base) returns
 * `false` and should be treated as out-of-scope by the caller.
 */
export function isX402Network(value: string): value is X402Network {
	if (!value.startsWith(EIP155_PREFIX)) {
		return false;
	}
	const rest = value.slice(EIP155_PREFIX.length);
	if (rest.length === 0 || /^0\d/.test(rest)) {
		return false;
	}
	const parsed = Number(rest);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return false;
	}
	return isSupportedChainId(parsed);
}

/**
 * Extracts the {@link SupportedChainId} from an {@link X402Network}.
 *
 * Total over the {@link X402Network} type: if the input is `eip155:80002` the
 * result is `80002`. Use {@link isX402Network} first to narrow an arbitrary
 * `string`.
 *
 * @example
 * ```ts
 * import { x402NetworkToChainId } from "kawasekit";
 *
 * const chainId = x402NetworkToChainId("eip155:80002"); // 80002
 * ```
 */
export function x402NetworkToChainId(network: X402Network): SupportedChainId {
	const rest = network.slice(EIP155_PREFIX.length);
	return Number(rest) as SupportedChainId;
}
