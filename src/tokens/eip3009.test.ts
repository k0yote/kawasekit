import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { deriveAuthorizationNonce } from "./eip3009";

const NONCE_RE = /^0x[0-9a-f]{64}$/;
const FROM = "0x1111111111111111111111111111111111111111" as Address;
const JPYC = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29" as Address;
const SCOPE = { from: FROM, verifyingContract: JPYC, chainId: 80002 } as const;

describe("deriveAuthorizationNonce", () => {
	it("is a deterministic 32-byte value", () => {
		const n = deriveAuthorizationNonce({ idempotencyKey: "key-1" }, SCOPE);
		expect(n).toMatch(NONCE_RE);
		expect(deriveAuthorizationNonce({ idempotencyKey: "key-1" }, SCOPE)).toBe(n);
	});

	it("differs for a different idempotency key", () => {
		expect(deriveAuthorizationNonce({ idempotencyKey: "key-1" }, SCOPE)).not.toBe(
			deriveAuthorizationNonce({ idempotencyKey: "key-2" }, SCOPE),
		);
	});

	it("is scoped: different from / contract / chainId yield different nonces", () => {
		const base = deriveAuthorizationNonce({ idempotencyKey: "k" }, SCOPE);
		expect(
			deriveAuthorizationNonce(
				{ idempotencyKey: "k" },
				{ ...SCOPE, from: "0x2222222222222222222222222222222222222222" as Address },
			),
		).not.toBe(base);
		expect(
			deriveAuthorizationNonce(
				{ idempotencyKey: "k" },
				{ ...SCOPE, verifyingContract: "0x3333333333333333333333333333333333333333" as Address },
			),
		).not.toBe(base);
		// Cross-chain replay safety (threat 1.1 / Kaia): chainId is in the preimage.
		expect(deriveAuthorizationNonce({ idempotencyKey: "k" }, { ...SCOPE, chainId: 137 })).not.toBe(
			base,
		);
	});

	it("normalizes address case via getAddress (checksum-insensitive)", () => {
		const lower = deriveAuthorizationNonce(
			{ idempotencyKey: "k" },
			{ ...SCOPE, from: FROM.toLowerCase() as Address },
		);
		expect(lower).toBe(deriveAuthorizationNonce({ idempotencyKey: "k" }, SCOPE));
	});

	it("rejects an empty idempotency key", () => {
		expect(() => deriveAuthorizationNonce({ idempotencyKey: "" }, SCOPE)).toThrow();
	});
});
