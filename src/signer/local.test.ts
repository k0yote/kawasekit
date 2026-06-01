import type { Hex } from "viem";
import { getAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createSpendingPolicy, type SpendingPolicy } from "../policy/spending-policy";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { PolicyGatedSignerConfigError } from "./errors";
import { createLocalPolicyGatedSigner } from "./local";
import type { PaymentIntent } from "./types";

const account = privateKeyToAccount(
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const FROM = getAddress(account.address);
const TOKEN = getAddress(JPYC_V2_ADDRESS);
const TO = getAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
const OTHER_TOKEN = getAddress("0x0000000000000000000000000000000000000ABc");
const NONCE = `0x${"1".repeat(64)}` as Hex;
const ASSET = { kind: "known", id: "jpyc-v2" } as const;

const EIP712_TYPES = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;
const DOMAIN = {
	name: "JPY Coin",
	version: "1",
	chainId: 80002,
	verifyingContract: TOKEN,
} as const;

function policy(
	over: Partial<{ maxPerSign: bigint; revoked: boolean; notAfter: bigint }> = {},
): SpendingPolicy {
	return createSpendingPolicy({
		session: { id: "s", notAfter: over.notAfter ?? 2_000_000_000n },
		perToken: [{ token: TOKEN, maxPerSign: over.maxPerSign ?? 1000n }],
		recipientAllowlist: "any",
		revoked: over.revoked ?? false,
	});
}

function signerWith(p: SpendingPolicy) {
	return createLocalPolicyGatedSigner({
		account,
		policy: p,
		asset: ASSET,
		acknowledgeAdvisory: true,
	});
}

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
	return {
		token: TOKEN,
		chainId: 80002,
		from: FROM,
		to: TO,
		value: 1000n,
		validAfter: 0n,
		validBefore: 1_900_000_000n,
		nonce: NONCE,
		...over,
	};
}

describe("createLocalPolicyGatedSigner — construction", () => {
	it("throws when acknowledgeAdvisory is not true", () => {
		expect(() =>
			createLocalPolicyGatedSigner({
				account,
				policy: policy(),
				asset: ASSET,
				// @ts-expect-error — acknowledgeAdvisory must be the literal `true`
				acknowledgeAdvisory: false,
			}),
		).toThrow(PolicyGatedSignerConfigError);
	});

	it("exposes enforcement=advisory, from, and describe()", () => {
		const s = signerWith(policy());
		expect(s.enforcement).toBe("advisory");
		expect(s.from).toBe(FROM);
		expect(s.describe()).toEqual({
			enforcement: "advisory",
			from: FROM,
			policyId: "s",
			notAfter: 2_000_000_000n,
			revoked: false,
		});
	});
});

describe("createLocalPolicyGatedSigner — sign (allow)", () => {
	it("produces a valid EIP-3009 signature that recovers to the account", async () => {
		const s = signerWith(policy({ maxPerSign: 1000n }));
		const i = intent({ value: 1000n });
		const result = await s.sign(i);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
			const recovered = await recoverTypedDataAddress({
				domain: DOMAIN,
				types: EIP712_TYPES,
				primaryType: "TransferWithAuthorization",
				message: {
					from: FROM,
					to: i.to,
					value: i.value,
					validAfter: i.validAfter,
					validBefore: i.validBefore,
					nonce: i.nonce,
				},
				signature: result.signature,
			});
			expect(getAddress(recovered)).toBe(FROM);
		}
	});
});

describe("createLocalPolicyGatedSigner — sign (deny, no signature)", () => {
	it("from_mismatch when intent.from is not the signer", async () => {
		const result = await signerWith(policy()).sign(intent({ from: TO }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.rejection.reason).toBe("from_mismatch");
			expect(result).not.toHaveProperty("signature");
		}
	});

	it("token_not_allowed when intent.token is not the pinned domain", async () => {
		const result = await signerWith(policy()).sign(intent({ token: OTHER_TOKEN }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.rejection.reason).toBe("token_not_allowed");
	});

	it("revoked policy → revoked, no signature", async () => {
		const result = await signerWith(policy({ revoked: true })).sign(intent());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.rejection.reason).toBe("revoked");
	});

	it("amount over maxPerSign → amount_exceeds_per_sign", async () => {
		const result = await signerWith(policy({ maxPerSign: 500n })).sign(intent({ value: 1000n }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.rejection.reason).toBe("amount_exceeds_per_sign");
	});
});
