import { type Address, concat, type Hex, size } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	deriveAuthorizationNonce,
	type Eip3009Domain,
	signCancelAuthorization,
	signReceiveWithAuthorization,
	signTransferWithAuthorization,
} from "./eip3009";

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

// A deployed smart account signs typed data with ERC-1271 bytes, not a 65-byte ECDSA signature.
// Kernel v3.1's is 86 bytes: 0x01, the ECDSA validator's address, then a 65-byte signature.
const SMART_ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const ECDSA_VALIDATOR = "0x3333333333333333333333333333333333333333" as Address;
const KERNEL_SIGNATURE: Hex = concat(["0x01", ECDSA_VALIDATOR, `0x${"ab".repeat(64)}1b`]);

function smartAccount(signature: Hex) {
	return toAccount({
		address: SMART_ACCOUNT,
		async signMessage() {
			throw new Error("unused");
		},
		async signTransaction() {
			throw new Error("unused");
		},
		async signTypedData() {
			return signature;
		},
	});
}

const DOMAIN: Eip3009Domain = {
	name: "USD Coin",
	version: "2",
	chainId: 80002,
	verifyingContract: "0x4444444444444444444444444444444444444444",
};
const NONCE: Hex = `0x${"00".repeat(31)}01`;
const TO = "0x5555555555555555555555555555555555555555" as Address;

describe("signed authorization shape (#54)", () => {
	it("splits an EOA's 65-byte signature into (v, r, s)", async () => {
		const eoa = privateKeyToAccount(
			"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
		);
		const signed = await signTransferWithAuthorization(eoa, DOMAIN, {
			from: eoa.address,
			to: TO,
			value: 1n,
			validAfter: 0n,
			validBefore: 2_000_000_000n,
			nonce: NONCE,
		});
		expect(size(signed.signature)).toBe(65);
		if (signed.v === undefined) throw new Error("an EOA signature must come split");
		// Narrowing on `v` settles `r` and `s` too.
		expectTypeOf(signed.r).toEqualTypeOf<Hex>();
		expectTypeOf(signed.s).toEqualTypeOf<Hex>();
		expect([27, 28]).toContain(signed.v);
		expect(concat([signed.r, signed.s])).toBe(signed.signature.slice(0, 130));
	});

	it("keeps a smart account's signature whole, with no (v, r, s)", async () => {
		const signed = await signTransferWithAuthorization(smartAccount(KERNEL_SIGNATURE), DOMAIN, {
			from: SMART_ACCOUNT,
			to: TO,
			value: 1n,
			validAfter: 0n,
			validBefore: 2_000_000_000n,
			nonce: NONCE,
		});
		expect(size(KERNEL_SIGNATURE)).toBe(86);
		expect(signed.signature).toBe(KERNEL_SIGNATURE);
		expect(signed.v).toBeUndefined();
		expect(signed.r).toBeUndefined();
		expect(signed.s).toBeUndefined();
		expect(signed.message.from).toBe(SMART_ACCOUNT);
	});

	it("keeps it whole for ReceiveWithAuthorization and CancelAuthorization too", async () => {
		const account = smartAccount(KERNEL_SIGNATURE);
		const received = await signReceiveWithAuthorization(account, DOMAIN, {
			from: SMART_ACCOUNT,
			to: TO,
			value: 1n,
			validAfter: 0n,
			validBefore: 2_000_000_000n,
			nonce: NONCE,
		});
		const cancelled = await signCancelAuthorization(account, DOMAIN, {
			authorizer: SMART_ACCOUNT,
			nonce: NONCE,
		});
		for (const signed of [received, cancelled]) {
			expect(signed.signature).toBe(KERNEL_SIGNATURE);
			expect(signed.v).toBeUndefined();
		}
	});

	it("still refuses a 65-byte signature whose v is not a recovery id", async () => {
		const bad: Hex = `0x${"ab".repeat(64)}05`;
		await expect(
			signTransferWithAuthorization(smartAccount(bad), DOMAIN, {
				from: SMART_ACCOUNT,
				to: TO,
				value: 1n,
				validAfter: 0n,
				validBefore: 2_000_000_000n,
				nonce: NONCE,
			}),
		).rejects.toThrow();
	});
});
