import type { Hex } from "viem";
import { getAddress, hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/eip3009-digest.vectors.json";
import {
	type Eip3009Domain,
	receiveWithAuthorizationTypes,
	transferWithAuthorizationTypes,
} from "./eip3009";

/**
 * The B8 EIP-712 digest-conformance corpus (SDK half). The same
 * `eip3009-digest.vectors.json` is consumed by the `mpc-2p` Rust backend
 * (M6-1 RFC §4.5, H1): both must derive each `digest` byte-for-byte from the
 * same `(domain, types, message)`. Each golden `digest` is frozen, so any drift
 * in the EXPORTED `transfer/receiveWithAuthorizationTypes` (field order, type
 * strings, domain shape) breaks this test — making "the bytes the policy gates
 * on == the bytes `ecrecover` verifies" enforced, not true-by-inspection.
 * Encoding is pinned: decimal-string `uint256`, EIP-55 addresses, `0x` hex.
 */
interface VectorJson {
	readonly name: string;
	readonly primaryType: "TransferWithAuthorization" | "ReceiveWithAuthorization";
	readonly domain: {
		readonly name: string;
		readonly version: string;
		readonly chainId: number;
		readonly verifyingContract: string;
	};
	readonly message: {
		readonly from: string;
		readonly to: string;
		readonly value: string;
		readonly validAfter: string;
		readonly validBefore: string;
		readonly nonce: string;
	};
	readonly digest: string;
}

function parseDomain(d: VectorJson["domain"]): Eip3009Domain {
	return {
		name: d.name,
		version: d.version,
		chainId: d.chainId,
		verifyingContract: getAddress(d.verifyingContract),
	};
}

function parseMessage(m: VectorJson["message"]) {
	return {
		from: getAddress(m.from),
		to: getAddress(m.to),
		value: BigInt(m.value),
		validAfter: BigInt(m.validAfter),
		validBefore: BigInt(m.validBefore),
		// fixture-controlled 32-byte hex nonce
		nonce: m.nonce as Hex,
	};
}

function digestOf(v: VectorJson): Hex {
	const domain = parseDomain(v.domain);
	const message = parseMessage(v.message);
	if (v.primaryType === "ReceiveWithAuthorization") {
		return hashTypedData({
			domain,
			types: receiveWithAuthorizationTypes,
			primaryType: "ReceiveWithAuthorization",
			message,
		});
	}
	return hashTypedData({
		domain,
		types: transferWithAuthorizationTypes,
		primaryType: "TransferWithAuthorization",
		message,
	});
}

describe("eip3009 digest conformance corpus (B8 — SDK half)", () => {
	// trusted in-repo fixture; shape asserted by the VectorJson interface
	const vectors = corpus.vectors as unknown as readonly VectorJson[];

	it("covers both primary types", () => {
		const kinds = new Set(vectors.map((v) => v.primaryType));
		expect(kinds).toEqual(
			new Set<VectorJson["primaryType"]>(["TransferWithAuthorization", "ReceiveWithAuthorization"]),
		);
	});

	it("every digest is a 32-byte hex string", () => {
		for (const v of vectors) {
			expect(v.digest).toMatch(/^0x[0-9a-f]{64}$/);
		}
	});

	for (const v of vectors) {
		it(`${v.primaryType} ${v.name} — exported types reproduce the pinned digest`, () => {
			expect(digestOf(v)).toBe(v.digest as Hex);
		});
	}
});
