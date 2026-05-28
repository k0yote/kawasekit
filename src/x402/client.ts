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
import {
	authorizationDeadlineFromNow,
	generateAuthorizationNonce,
	signTransferWithAuthorization,
} from "../tokens/eip3009";
import {
	getKnownAssetDomain,
	type KnownAssetDomain,
	type KnownAssetId,
	listKnownAssetIds,
} from "../tokens/known-assets";
import { X402InvalidConfigError, X402InvalidPayloadError } from "./errors";
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

/**
 * Asset binding for {@link createX402PaymentSigner}. Required, discriminated.
 *
 * **Default-on whitelist**: integrators MUST declare which asset they intend
 * to sign for. The `known` branch references a kawasekit-maintained
 * whitelist (see `src/tokens/known-assets.ts`); the `unsafeOverride` branch
 * is the deliberate escape hatch for any other asset and is named loudly so
 * it survives a code review. Either way, the signer pins the EIP-712 domain
 * at construction time and refuses to sign if `paymentRequirements.asset`
 * disagrees with the pinned `verifyingContract`.
 *
 * Closes Threat 1.4 (misadvertised EIP-712 domain): the server's advertised
 * `extra.name` / `extra.version` and `asset` are all ignored for signing
 * purposes — the signer trusts only what the integrator declared here.
 */
export type X402AssetParam =
	| {
			/** Use a kawasekit-maintained pinned EIP-712 domain. */
			readonly kind: "known";
			/** The asset id to pin. See {@link KnownAssetId} for the registry. */
			readonly id: KnownAssetId;
	  }
	| {
			/**
			 * Use a caller-supplied EIP-712 domain for an asset NOT on the
			 * kawasekit whitelist. The name is deliberately loud — pick this
			 * branch only when you have separately audited the contract and its
			 * `eip712Domain()` output.
			 */
			readonly kind: "unsafeOverride";
			readonly domain: {
				readonly name: string;
				readonly version: string;
				readonly verifyingContract: Address;
			};
	  };

/** Parameters for {@link createX402PaymentSigner}. */
export interface CreateX402PaymentSignerParams {
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

/** Construction-time resolution of an {@link X402AssetParam} to a pinned domain. */
interface ResolvedAsset {
	readonly name: string;
	readonly version: string;
	readonly verifyingContract: Address;
}

function resolveAssetParam(asset: X402AssetParam): ResolvedAsset {
	if (asset.kind === "known") {
		const entry: KnownAssetDomain | undefined = getKnownAssetDomain(asset.id);
		if (entry === undefined) {
			throw new X402InvalidConfigError(
				"asset.id",
				`unknown asset id ${JSON.stringify(asset.id)}. Supported: ${listKnownAssetIds()
					.map((id) => JSON.stringify(id))
					.join(", ")}.`,
			);
		}
		return {
			name: entry.name,
			version: entry.version,
			verifyingContract: entry.verifyingContract,
		};
	}
	if (asset.kind === "unsafeOverride") {
		const { domain } = asset;
		if (typeof domain.name !== "string" || domain.name === "") {
			throw new X402InvalidConfigError(
				"asset.domain.name",
				"`unsafeOverride.domain.name` must be a non-empty string",
			);
		}
		if (typeof domain.version !== "string" || domain.version === "") {
			throw new X402InvalidConfigError(
				"asset.domain.version",
				"`unsafeOverride.domain.version` must be a non-empty string",
			);
		}
		if (!isAddress(domain.verifyingContract, { strict: false })) {
			throw new X402InvalidConfigError(
				"asset.domain.verifyingContract",
				`\`unsafeOverride.domain.verifyingContract\` must be a valid address, got ${JSON.stringify(domain.verifyingContract)}`,
			);
		}
		return {
			name: domain.name,
			version: domain.version,
			verifyingContract: getAddress(domain.verifyingContract),
		};
	}
	// Defensive: TS exhaustiveness guarantees this is unreachable at compile
	// time, but a JS consumer could smuggle through an unknown kind.
	const exhaustive = asset as { kind: string };
	throw new X402InvalidConfigError(
		"asset.kind",
		`unsupported kind ${JSON.stringify(exhaustive.kind)}. Expected "known" or "unsafeOverride".`,
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
	const { account, network } = params;
	const defaultLifetimeSeconds =
		params.defaultLifetimeSeconds ?? X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS;
	if (defaultLifetimeSeconds <= 0) {
		throw new X402InvalidPayloadError(
			"X402PaymentSignerConfig",
			`\`defaultLifetimeSeconds\` must be positive, got ${defaultLifetimeSeconds}`,
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
