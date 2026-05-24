/**
 * Server-side builders for x402 v2 `PAYMENT-REQUIRED` payloads.
 *
 * `buildPaymentRequirements()` produces one accepted-payment entry; servers
 * call it once per (chain × asset) they want to advertise. `buildPaymentRequiredResponse()`
 * wraps a list of those entries into the full body the server returns alongside
 * an HTTP 402 status (typically also encoded into the `PAYMENT-REQUIRED`
 * header — see `src/x402/encoding.ts`).
 *
 * These factories live on the **server** side. The mirror-image client-side
 * factory is `createX402PaymentSigner()` in `client.ts`.
 *
 * @packageDocumentation
 */

import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import type { SupportedChainId } from "../chains";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { X402InvalidPayloadError } from "./errors";
import type {
	X402PaymentRequiredResponse,
	X402PaymentRequirements,
	X402ResourceInfo,
} from "./types";
import { chainIdToX402Network, X402_VERSION } from "./types";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default value for `maxTimeoutSeconds` when {@link BuildPaymentRequirementsParams.maxTimeoutSeconds}
 * is not supplied. Matches the x402 spec example for short-lived authorizations.
 *
 * Increase to 300 (the client-side default) when targeting Polygon Amoy in the
 * M3 demo — bundler inclusion latency can spike above 60 s on testnet.
 */
export const X402_DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/** Default `extra` payload kawasekit injects when the asset is JPYC. */
const JPYC_EXACT_EVM_EXTRA = {
	assetTransferMethod: "eip3009",
	name: "JPY Coin",
	version: "1",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for {@link buildPaymentRequirements}. */
export interface BuildPaymentRequirementsParams {
	/** Numeric chain ID; converted to the CAIP-2 `eip155:{chainId}` form. */
	readonly chainId: SupportedChainId;
	/** ERC-20 contract address of the token to be transferred. */
	readonly asset: Address;
	/** Recipient wallet address. */
	readonly payTo: Address;
	/** Atomic-unit amount. Accepts `bigint` (preferred) or a decimal `string`. */
	readonly amount: bigint | string;
	/**
	 * Optional. Defaults to {@link X402_DEFAULT_MAX_TIMEOUT_SECONDS}.
	 *
	 * The maximum wall-clock time the client may take to produce a signed
	 * payload after receiving this 402 response.
	 */
	readonly maxTimeoutSeconds?: number;
	/**
	 * Optional explicit `extra` payload. When omitted and `asset` is JPYC,
	 * kawasekit injects a default `{ assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" }`.
	 * For non-JPYC assets `extra` is required (the client needs at least
	 * `name` / `version` to reconstruct the EIP-712 domain).
	 */
	readonly extra?: Record<string, unknown>;
}

/** Parameters for {@link buildPaymentRequiredResponse}. */
export interface BuildPaymentRequiredResponseParams {
	/** The protected resource the client is being asked to pay for. */
	readonly resource: X402ResourceInfo;
	/** One or more acceptable payment methods. */
	readonly accepts: readonly X402PaymentRequirements[];
	/** Optional human-readable reason for the 402, echoed in the response body. */
	readonly error?: string;
	/** Optional protocol extensions (advanced; rarely set). */
	readonly extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const UINT256_MAX = (1n << 256n) - 1n;
const UINT256_DECIMAL = /^(0|[1-9][0-9]*)$/;

function coerceAmount(amount: bigint | string): string {
	if (typeof amount === "bigint") {
		if (amount <= 0n) {
			throw new X402InvalidPayloadError(
				"PaymentRequirements",
				`\`amount\` must be positive, got ${amount}`,
			);
		}
		if (amount > UINT256_MAX) {
			throw new X402InvalidPayloadError(
				"PaymentRequirements",
				`\`amount\` exceeds uint256, got ${amount}`,
			);
		}
		return amount.toString();
	}
	if (!UINT256_DECIMAL.test(amount)) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`amount\` must be a non-negative decimal string, got ${JSON.stringify(amount)}`,
		);
	}
	const parsed = BigInt(amount);
	if (parsed === 0n) {
		throw new X402InvalidPayloadError("PaymentRequirements", "`amount` must be positive");
	}
	if (parsed > UINT256_MAX) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`amount\` exceeds uint256, got ${amount}`,
		);
	}
	return amount;
}

function assertAddress(value: string, field: string): Address {
	if (!isAddress(value, { strict: false })) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`${field}\` is not a valid address: ${value}`,
		);
	}
	return value as Address;
}

function resolveExtra(
	asset: Address,
	explicit: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (explicit) {
		return explicit;
	}
	if (getAddress(asset) === getAddress(JPYC_V2_ADDRESS)) {
		return { ...JPYC_EXACT_EVM_EXTRA };
	}
	throw new X402InvalidPayloadError(
		"PaymentRequirements",
		"`extra` is required for non-JPYC assets (clients need at least `name` and `version` for EIP-712 domain reconstruction)",
	);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds one {@link X402PaymentRequirements} entry suitable for the `accepts`
 * array of a `PAYMENT-REQUIRED` response.
 *
 * @example Single-chain JPYC (defaults extra automatically)
 * ```ts
 * import { parseUnits } from "viem";
 * import {
 *   buildPaymentRequirements,
 *   JPYC_DECIMALS,
 *   JPYC_V2_ADDRESS,
 *   polygonAmoy,
 * } from "kawasekit";
 *
 * const requirements = buildPaymentRequirements({
 *   chainId: polygonAmoy.id,
 *   asset: JPYC_V2_ADDRESS,
 *   payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
 *   amount: parseUnits("0.001", JPYC_DECIMALS),
 * });
 * ```
 */
export function buildPaymentRequirements(
	params: BuildPaymentRequirementsParams,
): X402PaymentRequirements {
	const asset = assertAddress(params.asset, "asset");
	const payTo = assertAddress(params.payTo, "payTo");
	const amount = coerceAmount(params.amount);
	const maxTimeoutSeconds = params.maxTimeoutSeconds ?? X402_DEFAULT_MAX_TIMEOUT_SECONDS;
	if (maxTimeoutSeconds <= 0) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`maxTimeoutSeconds\` must be positive, got ${maxTimeoutSeconds}`,
		);
	}
	const extra = resolveExtra(asset, params.extra);

	return {
		scheme: "exact",
		network: chainIdToX402Network(params.chainId),
		amount,
		asset,
		payTo,
		maxTimeoutSeconds,
		extra,
	};
}

/**
 * Builds the full {@link X402PaymentRequiredResponse} body the server returns
 * alongside HTTP 402.
 *
 * @example
 * ```ts
 * import {
 *   buildPaymentRequiredResponse,
 *   buildPaymentRequirements,
 *   encodePaymentRequiredHeader,
 *   polygonAmoy,
 * } from "kawasekit";
 *
 * const response = buildPaymentRequiredResponse({
 *   resource: { url: "https://api.example.com/weather", description: "Real-time weather" },
 *   accepts: [
 *     buildPaymentRequirements({ chainId: polygonAmoy.id, ... }),
 *   ],
 *   error: "PAYMENT-SIGNATURE header is required",
 * });
 *
 * res.statusCode = 402;
 * res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(response));
 * res.setHeader("content-type", "application/json");
 * res.end(JSON.stringify(response));
 * ```
 */
export function buildPaymentRequiredResponse(
	params: BuildPaymentRequiredResponseParams,
): X402PaymentRequiredResponse {
	if (params.accepts.length === 0) {
		throw new X402InvalidPayloadError(
			"PaymentRequired",
			"`accepts` must contain at least one PaymentRequirements entry",
		);
	}
	// Object literal is built conditionally so optional fields are *absent* (not
	// `undefined`) when not provided — required by `exactOptionalPropertyTypes`.
	const base: Pick<X402PaymentRequiredResponse, "x402Version" | "resource" | "accepts"> = {
		x402Version: X402_VERSION,
		resource: params.resource,
		accepts: params.accepts,
	};
	if (params.error !== undefined && params.extensions !== undefined) {
		return { ...base, error: params.error, extensions: params.extensions };
	}
	if (params.error !== undefined) {
		return { ...base, error: params.error };
	}
	if (params.extensions !== undefined) {
		return { ...base, extensions: params.extensions };
	}
	return base;
}
