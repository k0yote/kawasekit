import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/order-ref.vectors.json";
import { hashOrderDetails, hashOrderRef } from "./order-hash";

/**
 * The Settlement cross-language conformance corpus (SDK half).
 *
 * `order-ref.vectors.json` is a copy of `test/settlement/vectors/order-ref-vectors.json` from the
 * `kawasekit-contracts` repository at commit `3618d7c`, re-indented by Biome (the parsed content is
 * identical). There, one Foundry test generates the file, reads it back and recomputes every hash,
 * and CI fails on drift. NOTHING guards this copy against the source: when the contract's hashing
 * rule changes, this file is re-copied by hand and the commit above is updated.
 *
 * Two hashes are pinned, because two parties compute them:
 * - `details` — computed OFF CHAIN ONLY (the Hub issuing an order, an agent about to pay, a merchant
 *   checking a receipt). The contract receives it as an opaque `bytes32`, so the Solidity side of
 *   these vectors is a test-only reference implementation — without it this function would be
 *   checked only against itself.
 * - `ref` — computed BY THE CONTRACT (`Settlement.orderRef`, and `pay` with `payer = msg.sender`).
 *
 * Every golden value is frozen, so any drift in the exported type definitions (field order, type
 * strings, the domain's name or version) breaks this test. Encoding is pinned: every value is a
 * string — `0x` hex for addresses and `bytes32`, decimal for every integer — so `type(uint256).max`
 * survives `JSON.parse`.
 */
interface DetailsCaseJson {
	readonly name: string;
	readonly orderId: string;
	readonly lines: readonly {
		readonly itemId: string;
		readonly unitPrice: string;
		readonly quantity: string;
	}[];
	readonly salt: string;
	readonly details: string;
}

interface RefCaseJson {
	readonly name: string;
	readonly chainId: string;
	readonly settlement: string;
	readonly token: string;
	readonly payer: string;
	readonly merchant: string;
	readonly amount: string;
	readonly validUntil: string;
	readonly details: string;
	readonly ref: string;
}

function detailsOf(c: DetailsCaseJson): Hex {
	return hashOrderDetails({
		orderId: c.orderId,
		lines: c.lines.map((l) => ({
			itemId: l.itemId,
			unitPrice: BigInt(l.unitPrice),
			quantity: Number(l.quantity),
		})),
		salt: c.salt as Hex, // fixture-controlled 32-byte hex
	});
}

function addressOf(value: string): Address {
	return getAddress(value);
}

function refOf(c: RefCaseJson): Hex {
	return hashOrderRef({
		chainId: Number(c.chainId),
		settlement: addressOf(c.settlement),
		order: {
			token: addressOf(c.token),
			payer: addressOf(c.payer),
			merchant: addressOf(c.merchant),
			amount: BigInt(c.amount),
			validUntil: BigInt(c.validUntil),
			details: c.details as Hex, // fixture-controlled 32-byte hex
		},
	});
}

describe("settlement order-hash conformance corpus (SDK half)", () => {
	// trusted in-repo fixture; shape asserted by the two interfaces above
	const detailsCases = corpus.detailsCases as unknown as readonly DetailsCaseJson[];
	// trusted in-repo fixture; shape asserted by the two interfaces above
	const refCases = corpus.refCases as unknown as readonly RefCaseJson[];

	it("covers the cases that are easy to get wrong", () => {
		expect(new Set(detailsCases.map((c) => c.name))).toEqual(
			new Set(["single-line", "three-lines", "no-lines", "unicode-ids", "max-values"]),
		);
		expect(new Set(refCases.map((c) => c.name))).toEqual(
			new Set(["amoy-opaque-details", "amoy-single-line", "polygon-mainnet", "max-values"]),
		);
	});

	it("every pinned hash is a 32-byte hex string", () => {
		for (const c of detailsCases) expect(c.details).toMatch(/^0x[0-9a-f]{64}$/);
		for (const c of refCases) expect(c.ref).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it("the same order under another chain id has another ref — the domain is part of it", () => {
		const amoy = refCases.find((c) => c.name === "amoy-single-line");
		const mainnet = refCases.find((c) => c.name === "polygon-mainnet");
		expect(amoy?.details).toBe(mainnet?.details);
		expect(amoy?.ref).not.toBe(mainnet?.ref);
	});

	for (const c of detailsCases) {
		it(`details ${c.name} — reproduces the pinned hash`, () => {
			expect(detailsOf(c)).toBe(c.details as Hex);
		});
	}

	for (const c of refCases) {
		it(`ref ${c.name} — reproduces the pinned hash`, () => {
			expect(refOf(c)).toBe(c.ref as Hex);
		});
	}
});
