/**
 * Known-asset registry for {@link createX402PaymentSigner}'s
 * `asset: { kind: "known", id }` discriminated-union branch.
 *
 * kawasekit only ships pinned EIP-712 domain definitions for assets it has
 * verified empirically against the deployed contracts. Adding a new entry
 * here requires citing the source-file + line reference for the contract
 * that owns the `name` / `version` (so the next reviewer can spot-check the
 * claim, the same discipline `docs/THREAT_MODEL.md` §0 demands of any ✅
 * verdict that delegates to an out-of-scope component).
 *
 * @packageDocumentation
 */

import type { Address } from "viem";
import { getAddress } from "viem";
import { JPYC_EIP712_DOMAIN_HINT, JPYC_V2_ADDRESS } from "./jpyc";

/** Known asset identifiers. New entries must update this union AND the table. */
export type KnownAssetId = "jpyc-v2";

/** Fully-pinned EIP-712 domain for a known asset. */
export interface KnownAssetDomain {
	readonly id: KnownAssetId;
	readonly name: string;
	readonly version: string;
	readonly verifyingContract: Address;
}

/**
 * Canonical table. Lookups go through {@link getKnownAssetDomain}, which
 * returns a frozen copy so callers cannot mutate the registry.
 *
 * `verifyingContract` is the multi-chain canonical address — JPYC v2 is the
 * same address on Ethereum / Polygon (mainnet + Amoy) / Avalanche. The
 * signer cross-checks `requirements.asset` against this value at sign time,
 * so a server advertising a different `asset` is rejected before any
 * signature is produced.
 *
 * JPYC v2 domain: `name = "JPY Coin"`, `version = "1"`. Source of truth is
 * the deployed contract's `eip712Domain()` view — verified empirically and
 * also cached in `src/tokens/jpyc.ts:JPYC_EIP712_DOMAIN_HINT`.
 */
const KNOWN_ASSETS: ReadonlyArray<KnownAssetDomain> = [
	{
		id: "jpyc-v2",
		name: JPYC_EIP712_DOMAIN_HINT.name,
		version: JPYC_EIP712_DOMAIN_HINT.version,
		verifyingContract: getAddress(JPYC_V2_ADDRESS),
	},
];

/**
 * Look up a known asset's pinned EIP-712 domain by id.
 *
 * @returns The domain, or `undefined` if the id is not in the registry.
 *
 * @example
 * ```ts
 * import { getKnownAssetDomain } from "kawasekit";
 *
 * const jpyc = getKnownAssetDomain("jpyc-v2");
 * if (jpyc === undefined) throw new Error("unreachable");
 * console.log(jpyc.verifyingContract); // 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
 * ```
 */
export function getKnownAssetDomain(id: KnownAssetId): KnownAssetDomain | undefined {
	return KNOWN_ASSETS.find((entry) => entry.id === id);
}

/** List every known asset id (for diagnostics / error messages). */
export function listKnownAssetIds(): readonly KnownAssetId[] {
	return KNOWN_ASSETS.map((entry) => entry.id);
}

/**
 * Known assets whose `transferWithAuthorization` checks the signature with `ecrecover` alone — no
 * ERC-1271 — so `from` must be an EOA: a smart account's signature can never settle there.
 *
 * JPYC v2: its EIP-3009 implementation recovers with `ecrecover` and compares to `from` (see the
 * JPYC facts in the repository's CLAUDE.md). USDC v2.2 is the counter-example: it checks ERC-1271
 * when `from` has code.
 */
const ECRECOVER_ONLY_ASSETS: ReadonlySet<Address> = new Set([getAddress(JPYC_V2_ADDRESS)]);

/**
 * Whether a token at `verifyingContract` is known to check EIP-3009 signatures with `ecrecover`
 * only. `false` means "not known to be", not "checks ERC-1271": an asset kawasekit does not know
 * is left to the facilitator. Decided by address, so JPYC pinned through `unsafeOverride` counts.
 *
 * @internal Not exported from the package root.
 */
export function isEcrecoverOnlyAsset(verifyingContract: Address): boolean {
	return ECRECOVER_ONLY_ASSETS.has(getAddress(verifyingContract));
}
