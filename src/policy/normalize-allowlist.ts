/**
 * Shared recipient-allowlist normalization for the two policy paths — the
 * off-chain {@link createSpendingPolicy} (`./spending-policy`) and the on-chain
 * {@link createJpycDailyLimitPolicies} (`./daily-limit`). Keeping one normalizer
 * means both agree on what "the same allowlist" is: a future change (e.g.
 * rejecting the zero address) lands in one place, not two that can drift.
 *
 * @packageDocumentation
 */

import type { Address } from "viem";
import { getAddress } from "viem";

/**
 * Checksum-normalize ({@link getAddress}) and de-duplicate an address allowlist,
 * preserving first-seen order. `getAddress` rejects a malformed address.
 *
 * This does **not** decide what an empty list means — `[]` returns `[]`. Each
 * caller owns that policy: the off-chain `SpendingPolicy` treats `[]` as
 * deny-all, while the on-chain `createJpycDailyLimitPolicies` rejects it (an
 * on-chain allowlist cannot encode "match nothing").
 */
export function normalizeRecipientAllowlist(allowlist: readonly Address[]): Address[] {
	const seen = new Set<Address>();
	const normalized: Address[] = [];
	for (const entry of allowlist) {
		const checksummed = getAddress(entry);
		if (!seen.has(checksummed)) {
			seen.add(checksummed);
			normalized.push(checksummed);
		}
	}
	return normalized;
}
