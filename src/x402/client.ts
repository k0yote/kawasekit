/**
 * x402 v2 client-side signer.
 *
 * Given a server-issued {@link X402PaymentRequirements}, produce a
 * {@link X402PaymentPayload} the client can send back in the next request. This
 * is the first runtime consumer of the M2 EIP-3009 helpers
 * ({@link signTransferWithAuthorization}, {@link authorizationDeadlineFromNow},
 * {@link generateAuthorizationNonce}).
 *
 * Scope:
 * - **exact-EVM scheme only.** Permit2 / ERC-7710 are M4+.
 * - **EOA payer only.** EIP-3009 uses pure `ecrecover` (no ERC-1271 fallback)
 *   so smart accounts cannot be `from`. The agent-account flow is
 *   {@link transferJpyc} (UserOp), not x402.
 *
 * @packageDocumentation
 */

import type { Account, Address } from "viem";
import { getAddress, isAddress } from "viem";
import { isSupportedChainId } from "../chains";
import {
	authorizationDeadlineFromNow,
	generateAuthorizationNonce,
	signTransferWithAuthorization,
} from "../tokens/eip3009";
import { JPYC_EIP712_DOMAIN_HINT, JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { X402InvalidPayloadError } from "./errors";
import type {
	X402ExactEvmPayload,
	X402PaymentPayload,
	X402PaymentRequirements,
	X402ResourceInfo,
} from "./types";
import { X402_VERSION, x402NetworkToChainId } from "./types";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default authorization lifetime (`validBefore = now + this`) when the caller
 * does not pass an override. Capped per-sign by `paymentRequirements.maxTimeoutSeconds`.
 *
 * 300 s matches the M3 example app's tolerance for Polygon Amoy bundler
 * inclusion latency (see plan risk #6).
 */
export const X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** EIP-712 token domain `name` / `version` pair. */
export interface X402TokenDomain {
	readonly name: string;
	readonly version: string;
}

/** Parameters for {@link createX402PaymentSigner}. */
export interface CreateX402PaymentSignerParams {
	/**
	 * EOA / LocalAccount that signs the EIP-3009 `TransferWithAuthorization`.
	 * MUST be the same address the requirements' `from` will name.
	 */
	readonly account: Account;
	/**
	 * Default authorization lifetime in seconds. Bounded by each
	 * requirement's `maxTimeoutSeconds` at sign time.
	 * Defaults to {@link X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS}.
	 */
	readonly defaultLifetimeSeconds?: number;
	/**
	 * Optional override of the EIP-712 domain `name` / `version`. Skips the
	 * lookup of `paymentRequirements.extra.name` / `.version`. Useful when
	 * the caller wants to pin to a known-good domain regardless of what the
	 * server advertised.
	 */
	readonly domainOverride?: X402TokenDomain;
}

/** Parameters for {@link X402PaymentSigner.sign}. */
export interface SignX402PaymentParams {
	/** The chosen entry from the server's `accepts` array. */
	readonly paymentRequirements: X402PaymentRequirements;
	/** Optional {@link X402ResourceInfo} to echo back in the payload. */
	readonly resource?: X402ResourceInfo;
	/** Unix-seconds override of `validAfter`. Defaults to `0n`. */
	readonly validAfter?: bigint;
	/**
	 * Unix-seconds override of `validBefore`. Defaults to `now + lifetime`
	 * where lifetime = `min(signer default, requirements.maxTimeoutSeconds)`.
	 */
	readonly validBefore?: bigint;
}

/** Signer returned by {@link createX402PaymentSigner}. */
export interface X402PaymentSigner {
	/** Address of the EOA bound to this signer. */
	readonly address: Address;
	/** Sign a payment for one {@link X402PaymentRequirements}. */
	sign(params: SignX402PaymentParams): Promise<X402PaymentPayload>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const UINT256_MAX = (1n << 256n) - 1n;
const UINT256_DECIMAL = /^(0|[1-9][0-9]*)$/;

function parseUintString(value: string, field: string): bigint {
	if (!UINT256_DECIMAL.test(value)) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`${field}\` must be a non-negative decimal string, got ${JSON.stringify(value)}`,
		);
	}
	const parsed = BigInt(value);
	if (parsed > UINT256_MAX) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`${field}\` exceeds uint256, got ${value}`,
		);
	}
	return parsed;
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

function resolveDomain(
	requirements: X402PaymentRequirements,
	override: X402TokenDomain | undefined,
): X402TokenDomain {
	if (override) {
		return override;
	}
	const extra = requirements.extra as { name?: unknown; version?: unknown };
	if (typeof extra.name === "string" && typeof extra.version === "string") {
		return { name: extra.name, version: extra.version };
	}
	if (getAddress(requirements.asset) === getAddress(JPYC_V2_ADDRESS)) {
		return JPYC_EIP712_DOMAIN_HINT;
	}
	throw new X402InvalidPayloadError(
		"PaymentRequirements",
		"`extra.name` and `extra.version` are required for exact-EVM signing on a non-JPYC asset",
	);
}

function validateRequirements(requirements: X402PaymentRequirements): {
	readonly chainId: number;
	readonly value: bigint;
	readonly asset: Address;
	readonly payTo: Address;
} {
	if (requirements.scheme !== "exact") {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`unsupported scheme: ${requirements.scheme}`,
		);
	}
	const chainId = x402NetworkToChainId(requirements.network);
	if (!isSupportedChainId(chainId)) {
		// Defensive: an inbound payload typed as X402PaymentRequirements that
		// nonetheless smuggled an unsupported chainId via type-cast.
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`unsupported network: ${requirements.network}`,
		);
	}
	const value = parseUintString(requirements.amount, "amount");
	if (value === 0n) {
		throw new X402InvalidPayloadError("PaymentRequirements", "`amount` must be positive");
	}
	if (requirements.maxTimeoutSeconds <= 0) {
		throw new X402InvalidPayloadError(
			"PaymentRequirements",
			`\`maxTimeoutSeconds\` must be positive, got ${requirements.maxTimeoutSeconds}`,
		);
	}
	const asset = assertAddress(requirements.asset, "asset");
	const payTo = assertAddress(requirements.payTo, "payTo");
	return { chainId, value, asset, payTo };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an {@link X402PaymentSigner} bound to a single signing account.
 *
 * The returned signer can produce many {@link X402PaymentPayload}s in
 * succession — one per accepted requirement. Each call generates a fresh
 * EIP-3009 nonce.
 *
 * @example
 * ```ts
 * import { privateKeyToAccount } from "viem/accounts";
 * import { createX402PaymentSigner } from "kawasekit";
 *
 * const account = privateKeyToAccount("0x...");
 * const signer = createX402PaymentSigner({ account });
 *
 * // ...after receiving a 402 with PAYMENT-REQUIRED header...
 * const paymentPayload = await signer.sign({ paymentRequirements });
 * ```
 */
export function createX402PaymentSigner(params: CreateX402PaymentSignerParams): X402PaymentSigner {
	const { account } = params;
	const defaultLifetimeSeconds =
		params.defaultLifetimeSeconds ?? X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS;
	if (defaultLifetimeSeconds <= 0) {
		throw new X402InvalidPayloadError(
			"X402PaymentSignerConfig",
			`\`defaultLifetimeSeconds\` must be positive, got ${defaultLifetimeSeconds}`,
		);
	}
	const domainOverride = params.domainOverride;

	return {
		address: account.address,
		async sign(signParams) {
			const { paymentRequirements } = signParams;
			const { chainId, value, asset, payTo } = validateRequirements(paymentRequirements);
			const domain = resolveDomain(paymentRequirements, domainOverride);

			const lifetime = Math.min(defaultLifetimeSeconds, paymentRequirements.maxTimeoutSeconds);
			const validAfter = signParams.validAfter ?? 0n;
			const validBefore = signParams.validBefore ?? authorizationDeadlineFromNow(lifetime);
			if (validBefore <= validAfter) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`\`validBefore\` (${validBefore}) must be greater than \`validAfter\` (${validAfter})`,
				);
			}

			const nonce = generateAuthorizationNonce();
			const signed = await signTransferWithAuthorization(
				account,
				{ name: domain.name, version: domain.version, chainId, verifyingContract: asset },
				{
					from: account.address,
					to: payTo,
					value,
					validAfter,
					validBefore,
					nonce,
				},
			);

			const payload: X402ExactEvmPayload = {
				signature: signed.signature,
				authorization: {
					from: signed.message.from,
					to: signed.message.to,
					value: signed.message.value.toString(),
					validAfter: signed.message.validAfter.toString(),
					validBefore: signed.message.validBefore.toString(),
					nonce: signed.message.nonce,
				},
			};

			const result: X402PaymentPayload = signParams.resource
				? {
						x402Version: X402_VERSION,
						resource: signParams.resource,
						accepted: paymentRequirements,
						payload: { ...payload },
					}
				: {
						x402Version: X402_VERSION,
						accepted: paymentRequirements,
						payload: { ...payload },
					};
			return result;
		},
	};
}
