/**
 * EIP-712 asset-domain resolution for x402 / EIP-3009 signing.
 *
 * Construction-time pinning of the EIP-712 domain (`name` / `version` /
 * `verifyingContract`) a signer will use. The integrator declares an
 * {@link X402AssetParam} — either a kawasekit-maintained `known` asset or a
 * loud `unsafeOverride` — and {@link resolveAssetParam} resolves it to a pinned
 * {@link ResolvedAsset}. The signer then trusts only this pinned domain and
 * refuses to sign for a mismatched advertised asset (Threat 1.4: misadvertised
 * EIP-712 domain).
 *
 * Token-domain concern, reused by both the x402 signer (`src/x402/client.ts`)
 * and the M6 PolicyGatedSigner (`src/signer/`).
 *
 * @packageDocumentation
 */

import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import { X402InvalidConfigError } from "../x402/errors";
import type { Eip3009Domain } from "./eip3009";
import {
	getKnownAssetDomain,
	type KnownAssetDomain,
	type KnownAssetId,
	listKnownAssetIds,
} from "./known-assets";

/** EIP-712 token domain `name` / `version` pair. */
export interface X402TokenDomain {
	readonly name: string;
	readonly version: string;
}

/**
 * Asset binding for {@link createX402PaymentSigner} and the M6 PolicyGatedSigner.
 * Required, discriminated.
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

/** Construction-time resolution of an {@link X402AssetParam} to a pinned domain. */
export interface ResolvedAsset {
	readonly name: string;
	readonly version: string;
	readonly verifyingContract: Address;
}

/**
 * Resolve an {@link X402AssetParam} to a pinned {@link ResolvedAsset}.
 *
 * Throws {@link X402InvalidConfigError} for an unknown `known` id or a malformed
 * `unsafeOverride` domain. Pure / construction-time — no chain RPC.
 */
export function resolveAssetParam(asset: X402AssetParam): ResolvedAsset {
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

/**
 * Assemble the EIP-712 {@link Eip3009Domain} from a construction-time pinned
 * {@link ResolvedAsset} and the runtime `chainId`.
 *
 * The single place that maps `(pinned asset, chainId) -> domain`, so every
 * signing path (`src/x402/client.ts`, `src/signer/`) builds the domain
 * identically — the domain half of the EIP-712 single-source-of-truth the
 * `mpc-2p` backend relies on (RFC M6-1 §4.5, H1). `name` / `version` /
 * `verifyingContract` come from the pinned asset; only `chainId` is per-request.
 */
export function resolvedAssetToEip3009Domain(asset: ResolvedAsset, chainId: number): Eip3009Domain {
	return {
		name: asset.name,
		version: asset.version,
		chainId,
		verifyingContract: asset.verifyingContract,
	};
}
