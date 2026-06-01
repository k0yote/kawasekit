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
import { getChain, isSupportedChainId } from "../chains";
import { assertNonBypassable } from "../signer/gate";
import type { NonBypassableEnforcement, PaymentIntent, PolicyGatedSigner } from "../signer/types";
import type { X402AssetParam, X402TokenDomain } from "../tokens/asset-domain";
import { resolveAssetParam } from "../tokens/asset-domain";
import {
	authorizationDeadlineFromNow,
	deriveAuthorizationNonce,
	generateAuthorizationNonce,
	signTransferWithAuthorization,
} from "../tokens/eip3009";
import { X402InvalidPayloadError, X402PolicyRejectedError } from "./errors";
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

// `X402TokenDomain` and `X402AssetParam` were lifted to `../tokens/asset-domain`
// (M6-0) so the PolicyGatedSigner can reuse the same pinned-domain resolution.
// Re-exported here for back-compat — consumers still import them from this module.
export type { X402AssetParam, X402TokenDomain };

/**
 * Parameters for the `account` (EOA) variant of {@link createX402PaymentSigner}.
 *
 * Kept as a named, extensible `interface` (consumers may `extends` /
 * declaration-merge it). `maxAmountPerSign` pins the per-sign ceiling; for richer
 * policy use the `signer` variant ({@link CreateX402PaymentSignerSignerParams}).
 */
export interface CreateX402PaymentSignerAccountParams {
	/**
	 * Declared production-vs-test intent. Each `sign()` call verifies that
	 * `paymentRequirements.network` resolves to a chain whose `isTestnet`
	 * agrees with this value, and throws otherwise. The point is to refuse
	 * to sign a real-funds payment when the signer was configured for testnet
	 * (e.g. the server unexpectedly demanded `polygon-mainnet` instead of
	 * `polygon-amoy`).
	 */
	readonly network: "mainnet" | "testnet";
	/**
	 * EOA / LocalAccount that signs the EIP-3009 `TransferWithAuthorization`.
	 * MUST be the same address the requirements' `from` will name.
	 */
	readonly account: Account;
	/**
	 * Asset binding (required). Pins the EIP-712 domain at construction time
	 * and cross-checks `paymentRequirements.asset` at every sign call.
	 * See {@link X402AssetParam} for the discriminated-union shape.
	 *
	 * **Threat 1.4 mitigation**: the wire-format `extra.name` and
	 * `extra.version` are NOT consulted; a malicious server cannot coerce a
	 * mismatched signature through them.
	 */
	readonly asset: X402AssetParam;
	/**
	 * Default authorization lifetime in seconds. Bounded by each
	 * requirement's `maxTimeoutSeconds` at sign time.
	 * Defaults to {@link X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS}.
	 */
	readonly defaultLifetimeSeconds?: number;
	/**
	 * Optional per-signature value ceiling, in the asset's smallest unit
	 * (`bigint`). When set, `sign()` throws {@link X402InvalidPayloadError} if a
	 * server advertises `requirements.amount` greater than this — refusing to
	 * sign an over-budget payment at the primitive.
	 *
	 * **Threat 1.14 mitigation.** {@link createX402PaymentSigner} is a public API
	 * and the direct-signer path bypasses the `wrapFetch` `onPayment` guard; the
	 * EOA-payer x402 flow is also not bounded by the Layer-4 session-key daily
	 * limit. This pins the *amount* ceiling the way {@link X402AssetParam} pins
	 * the *asset* (1.4) — production posture is to set it. Omit it for no ceiling
	 * (backward-compatible default; the payer EOA balance is the only bound).
	 */
	readonly maxAmountPerSign?: bigint;
	/** Discriminant: absent on this arm — use the `signer` variant for a PolicyGatedSigner. */
	readonly signer?: never;
}

/**
 * Parameters for the `signer` (PolicyGatedSigner) variant of
 * {@link createX402PaymentSigner}. Drives signing through a
 * {@link PolicyGatedSigner} (e.g. `createLocalPolicyGatedSigner`); the per-sign
 * ceiling and richer policy live in the signer, so `maxAmountPerSign` is not
 * accepted here.
 */
export interface CreateX402PaymentSignerSignerParams {
	/** Declared production-vs-test intent (same semantics as the `account` variant). */
	readonly network: "mainnet" | "testnet";
	/** The policy-gated signer that produces the EIP-3009 authorization. */
	readonly signer: PolicyGatedSigner;
	/** Asset binding — pins the EIP-712 domain and cross-checks `paymentRequirements.asset`. */
	readonly asset: X402AssetParam;
	/**
	 * Default authorization lifetime in seconds. Bounded per-sign by
	 * `paymentRequirements.maxTimeoutSeconds`. Defaults to
	 * {@link X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS}.
	 */
	readonly defaultLifetimeSeconds?: number;
	/**
	 * When set, asserts at construction that `signer` is non-bypassable
	 * (`cryptographic` | `hardware`) — the runtime mirror of the
	 * `requireNonBypassable` type-gate. Throws for an advisory signer.
	 */
	readonly requireEnforcement?: NonBypassableEnforcement;
	/** Discriminant: absent on this arm. */
	readonly account?: never;
	/** Subsumed by the signer's policy; not accepted on this arm. */
	readonly maxAmountPerSign?: never;
}

/**
 * Parameters for {@link createX402PaymentSigner} — a discriminated union of the
 * `account` (EOA) and `signer` (PolicyGatedSigner) variants.
 *
 * NOTE: type-level breaking change from the original `interface` (a union cannot
 * be `extends`-ed). Existing `{ account, asset, network }` callers are
 * value-assignable to the `account` arm and unaffected; consumers who `extends`
 * / declaration-merge should use {@link CreateX402PaymentSignerAccountParams}.
 */
export type CreateX402PaymentSignerParams =
	| CreateX402PaymentSignerAccountParams
	| CreateX402PaymentSignerSignerParams;

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
	/**
	 * Optional reasoning-step idempotency key (M5-1, Half B). When supplied, the
	 * EIP-3009 nonce is **derived deterministically** from it (instead of random)
	 * so a re-signed same-intent payment produces the same on-chain nonce — the
	 * token contract's `authorizationState` then rejects the duplicate
	 * settlement. For a byte-identical re-sign, also pin `validBefore`. Build the
	 * key with `createIdempotencyKeyBuilder` from `kawasekit/idempotency`.
	 */
	readonly idempotencyKey?: string;
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
 * const signer = createX402PaymentSigner({
 *   network: "testnet",
 *   account,
 *   asset: { kind: "known", id: "jpyc-v2" },
 * });
 *
 * // ...after receiving a 402 with PAYMENT-REQUIRED header...
 * const paymentPayload = await signer.sign({ paymentRequirements });
 * ```
 */
export function createX402PaymentSigner(params: CreateX402PaymentSignerParams): X402PaymentSigner {
	if (params.signer !== undefined) {
		return createSignerBackedX402PaymentSigner(params);
	}
	const { account, network } = params;
	const defaultLifetimeSeconds =
		params.defaultLifetimeSeconds ?? X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS;
	if (defaultLifetimeSeconds <= 0) {
		throw new X402InvalidPayloadError(
			"X402PaymentSignerConfig",
			`\`defaultLifetimeSeconds\` must be positive, got ${defaultLifetimeSeconds}`,
		);
	}
	const maxAmountPerSign = params.maxAmountPerSign;
	if (maxAmountPerSign !== undefined && maxAmountPerSign <= 0n) {
		throw new X402InvalidPayloadError(
			"X402PaymentSignerConfig",
			`\`maxAmountPerSign\` must be a positive bigint, got ${maxAmountPerSign}`,
		);
	}
	const pinnedDomain = resolveAssetParam(params.asset);

	return {
		address: account.address,
		async sign(signParams) {
			const { paymentRequirements } = signParams;
			const { chainId, value, asset, payTo } = validateRequirements(paymentRequirements);
			const chain = getChain(chainId);
			if (network === "mainnet" && chain.isTestnet) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`signer was configured for network="mainnet" but requirements.network="${paymentRequirements.network}" (chainId ${chainId}) is a testnet`,
				);
			}
			if (network === "testnet" && !chain.isTestnet) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`signer was configured for network="testnet" but requirements.network="${paymentRequirements.network}" (chainId ${chainId}) is a mainnet — refusing to sign payment for real funds`,
				);
			}
			if (getAddress(asset) !== pinnedDomain.verifyingContract) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`requirements.asset (${getAddress(asset)}) does not match the signer's pinned verifyingContract (${pinnedDomain.verifyingContract}) — refusing to sign for an asset the signer was not configured to handle`,
				);
			}
			if (maxAmountPerSign !== undefined && value > maxAmountPerSign) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`requirements.amount (${value}) exceeds the signer's \`maxAmountPerSign\` ceiling (${maxAmountPerSign}) — refusing to sign a payment above the configured per-signature limit (threat 1.14)`,
				);
			}

			const lifetime = Math.min(defaultLifetimeSeconds, paymentRequirements.maxTimeoutSeconds);
			const validAfter = signParams.validAfter ?? 0n;
			const validBefore = signParams.validBefore ?? authorizationDeadlineFromNow(lifetime);
			if (validBefore <= validAfter) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`\`validBefore\` (${validBefore}) must be greater than \`validAfter\` (${validAfter})`,
				);
			}

			const nonce =
				signParams.idempotencyKey !== undefined
					? deriveAuthorizationNonce(
							{ idempotencyKey: signParams.idempotencyKey },
							{
								from: account.address,
								verifyingContract: pinnedDomain.verifyingContract,
								chainId,
							},
						)
					: generateAuthorizationNonce();
			const signed = await signTransferWithAuthorization(
				account,
				{
					name: pinnedDomain.name,
					version: pinnedDomain.version,
					chainId,
					verifyingContract: pinnedDomain.verifyingContract,
				},
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

/**
 * The `signer` (PolicyGatedSigner) variant of {@link createX402PaymentSigner}.
 *
 * Shares the `account` path's validate / network / asset-pin / window / nonce
 * prologue (kept in sync deliberately — the two security checks must not drift),
 * then routes the EIP-3009 signing through the {@link PolicyGatedSigner}. A
 * policy denial (`sign()` → `{ ok: false }`) surfaces as a thrown
 * {@link X402PolicyRejectedError}, so the `X402PaymentSigner.sign()` contract is
 * unchanged (returns a payload or throws). The per-sign ceiling is the signer's
 * policy, so there is no `maxAmountPerSign` check here.
 */
function createSignerBackedX402PaymentSigner(
	params: CreateX402PaymentSignerSignerParams,
): X402PaymentSigner {
	const { signer, network } = params;
	const defaultLifetimeSeconds =
		params.defaultLifetimeSeconds ?? X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS;
	if (defaultLifetimeSeconds <= 0) {
		throw new X402InvalidPayloadError(
			"X402PaymentSignerConfig",
			`\`defaultLifetimeSeconds\` must be positive, got ${defaultLifetimeSeconds}`,
		);
	}
	if (params.requireEnforcement !== undefined) {
		assertNonBypassable(signer);
	}
	const pinnedDomain = resolveAssetParam(params.asset);
	const from = signer.from;

	return {
		address: from,
		async sign(signParams) {
			const { paymentRequirements } = signParams;
			const { chainId, value, asset, payTo } = validateRequirements(paymentRequirements);
			const chain = getChain(chainId);
			if (network === "mainnet" && chain.isTestnet) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`signer was configured for network="mainnet" but requirements.network="${paymentRequirements.network}" (chainId ${chainId}) is a testnet`,
				);
			}
			if (network === "testnet" && !chain.isTestnet) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`signer was configured for network="testnet" but requirements.network="${paymentRequirements.network}" (chainId ${chainId}) is a mainnet — refusing to sign payment for real funds`,
				);
			}
			if (getAddress(asset) !== pinnedDomain.verifyingContract) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`requirements.asset (${getAddress(asset)}) does not match the signer's pinned verifyingContract (${pinnedDomain.verifyingContract}) — refusing to sign for an asset the signer was not configured to handle`,
				);
			}

			const lifetime = Math.min(defaultLifetimeSeconds, paymentRequirements.maxTimeoutSeconds);
			const validAfter = signParams.validAfter ?? 0n;
			const validBefore = signParams.validBefore ?? authorizationDeadlineFromNow(lifetime);
			if (validBefore <= validAfter) {
				throw new X402InvalidPayloadError(
					"PaymentRequirements",
					`\`validBefore\` (${validBefore}) must be greater than \`validAfter\` (${validAfter})`,
				);
			}

			const nonce =
				signParams.idempotencyKey !== undefined
					? deriveAuthorizationNonce(
							{ idempotencyKey: signParams.idempotencyKey },
							{ from, verifyingContract: pinnedDomain.verifyingContract, chainId },
						)
					: generateAuthorizationNonce();

			const intent: PaymentIntent = {
				token: pinnedDomain.verifyingContract,
				chainId,
				from,
				to: payTo,
				value,
				validAfter,
				validBefore,
				nonce,
			};

			const signResult = await signer.sign(intent);
			if (!signResult.ok) {
				throw new X402PolicyRejectedError(signResult.rejection);
			}

			const payload: X402ExactEvmPayload = {
				signature: signResult.signature,
				authorization: {
					from,
					to: payTo,
					value: value.toString(),
					validAfter: validAfter.toString(),
					validBefore: validBefore.toString(),
					nonce,
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
