import { getAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createSpendingPolicy } from "../policy/spending-policy";
import { PolicyGatedSignerConfigError } from "../signer/errors";
import { createLocalPolicyGatedSigner } from "../signer/local";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { createX402PaymentSigner } from "./client";
import { X402PolicyRejectedError } from "./errors";
import type { X402PaymentRequirements } from "./types";

const account = privateKeyToAccount(
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const TOKEN = getAddress(JPYC_V2_ADDRESS);
const PAY_TO = getAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
const ASSET = { kind: "known", id: "jpyc-v2" } as const;

const JPYC_REQ: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000000000000000000", // 10 JPYC (18 decimals)
	asset: JPYC_V2_ADDRESS,
	payTo: PAY_TO,
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
};

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

function localSigner(maxPerSign: bigint) {
	return createLocalPolicyGatedSigner({
		account,
		policy: createSpendingPolicy({
			session: { id: "conv-1", notAfter: 2_000_000_000n },
			perToken: [{ token: TOKEN, maxPerSign }],
		}),
		asset: ASSET,
		acknowledgeAdvisory: true,
	});
}

describe("createX402PaymentSigner — signer (PolicyGatedSigner) variant", () => {
	it("binds the signer's address", () => {
		const x402 = createX402PaymentSigner({
			network: "testnet",
			signer: localSigner(10n ** 20n),
			asset: ASSET,
		});
		expect(getAddress(x402.address)).toBe(getAddress(account.address));
	});

	it("signs an in-policy payment with the same payload shape as the account path", async () => {
		const x402 = createX402PaymentSigner({
			network: "testnet",
			signer: localSigner(10n ** 20n),
			asset: ASSET,
		});
		const payload = await x402.sign({ paymentRequirements: JPYC_REQ });

		expect(payload.x402Version).toBe(2);
		expect(payload.accepted).toBe(JPYC_REQ);

		// wire-format payload shape, identical to the account path
		const exact = payload.payload as {
			signature: `0x${string}`;
			authorization: {
				from: string;
				to: string;
				value: string;
				validAfter: string;
				validBefore: string;
				nonce: `0x${string}`;
			};
		};
		expect(exact.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
		expect(getAddress(exact.authorization.from)).toBe(getAddress(account.address));
		expect(getAddress(exact.authorization.to)).toBe(getAddress(PAY_TO));
		expect(exact.authorization.value).toBe("10000000000000000000");
		expect(exact.authorization.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);

		const recovered = await recoverTypedDataAddress({
			domain: DOMAIN,
			types: EIP712_TYPES,
			primaryType: "TransferWithAuthorization",
			message: {
				from: getAddress(exact.authorization.from),
				to: getAddress(exact.authorization.to),
				value: BigInt(exact.authorization.value),
				validAfter: BigInt(exact.authorization.validAfter),
				validBefore: BigInt(exact.authorization.validBefore),
				nonce: exact.authorization.nonce,
			},
			signature: exact.signature,
		});
		expect(getAddress(recovered)).toBe(getAddress(account.address));
	});

	it("throws X402PolicyRejectedError when the policy denies", async () => {
		const x402 = createX402PaymentSigner({
			network: "testnet",
			signer: localSigner(1n), // ceiling far below the 10 JPYC request
			asset: ASSET,
		});
		await expect(x402.sign({ paymentRequirements: JPYC_REQ })).rejects.toBeInstanceOf(
			X402PolicyRejectedError,
		);
		await expect(x402.sign({ paymentRequirements: JPYC_REQ })).rejects.toMatchObject({
			reason: "amount_exceeds_per_sign",
		});
	});

	it("requireEnforcement on an advisory signer throws at construction", () => {
		expect(() =>
			createX402PaymentSigner({
				network: "testnet",
				signer: localSigner(10n ** 20n),
				asset: ASSET,
				requireEnforcement: "cryptographic",
			}),
		).toThrow(PolicyGatedSignerConfigError);
	});
});
