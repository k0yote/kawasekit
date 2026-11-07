import type { Address, Hex } from "viem";
import { concat, getAddress, recoverTypedDataAddress, serializeErc6492Signature } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { createX402PaymentSigner, X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS } from "./client";
import { X402InvalidConfigError, X402InvalidPayloadError } from "./errors";
import type { X402PaymentRequirements } from "./types";

const ACCOUNT_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(ACCOUNT_PK);

const PAY_TO: Address = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const JPYC_REQ: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "10000000000000000000", // 10 JPYC (18 decimals)
	asset: JPYC_V2_ADDRESS,
	payTo: PAY_TO,
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
};

describe("createX402PaymentSigner — happy path", () => {
	it("returns a payment payload with all wire-format fields populated", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ });

		expect(payload.x402Version).toBe(2);
		expect(payload.accepted).toBe(JPYC_REQ);
		expect(payload.resource).toBeUndefined();

		const exact = payload.payload as {
			signature: string;
			authorization: {
				from: string;
				to: string;
				value: string;
				validAfter: string;
				validBefore: string;
				nonce: string;
			};
		};
		expect(exact.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
		expect(getAddress(exact.authorization.from)).toBe(getAddress(account.address));
		expect(getAddress(exact.authorization.to)).toBe(getAddress(PAY_TO));
		expect(exact.authorization.value).toBe("10000000000000000000");
		expect(exact.authorization.validAfter).toBe("0");
		expect(exact.authorization.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
	});

	it("produces an EIP-3009 signature that recovers to the signer account", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ });
		const exact = payload.payload as {
			signature: `0x${string}`;
			authorization: {
				from: Address;
				to: Address;
				value: string;
				validAfter: string;
				validBefore: string;
				nonce: `0x${string}`;
			};
		};

		const recovered = await recoverTypedDataAddress({
			domain: {
				name: "JPY Coin",
				version: "1",
				chainId: 80002,
				verifyingContract: JPYC_V2_ADDRESS,
			},
			types: {
				TransferWithAuthorization: [
					{ name: "from", type: "address" },
					{ name: "to", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "validAfter", type: "uint256" },
					{ name: "validBefore", type: "uint256" },
					{ name: "nonce", type: "bytes32" },
				],
			},
			primaryType: "TransferWithAuthorization",
			message: {
				from: exact.authorization.from,
				to: exact.authorization.to,
				value: BigInt(exact.authorization.value),
				validAfter: BigInt(exact.authorization.validAfter),
				validBefore: BigInt(exact.authorization.validBefore),
				nonce: exact.authorization.nonce,
			},
			signature: exact.signature,
		});
		expect(getAddress(recovered)).toBe(getAddress(account.address));
	});

	it("generates a unique nonce per sign() call", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const a = await signer.sign({ paymentRequirements: JPYC_REQ });
		const b = await signer.sign({ paymentRequirements: JPYC_REQ });
		const nonceA = (a.payload as { authorization: { nonce: string } }).authorization.nonce;
		const nonceB = (b.payload as { authorization: { nonce: string } }).authorization.nonce;
		expect(nonceA).not.toBe(nonceB);
	});

	it("exposes the signing address", () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		expect(getAddress(signer.address)).toBe(getAddress(account.address));
	});
});

describe("createX402PaymentSigner — validity window", () => {
	it("defaults validBefore to now + min(default, maxTimeoutSeconds)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const before = Math.floor(Date.now() / 1000);
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ });
		const after = Math.floor(Date.now() / 1000);

		const auth = (payload.payload as { authorization: { validBefore: string } }).authorization;
		const validBefore = Number(auth.validBefore);
		const lifetime = Math.min(
			X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS,
			JPYC_REQ.maxTimeoutSeconds,
		);
		expect(validBefore).toBeGreaterThanOrEqual(before + lifetime);
		expect(validBefore).toBeLessThanOrEqual(after + lifetime);
	});

	it("respects signer-level defaultLifetimeSeconds when smaller than maxTimeoutSeconds", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
			defaultLifetimeSeconds: 10,
		});
		const longerReq: X402PaymentRequirements = { ...JPYC_REQ, maxTimeoutSeconds: 3600 };
		const before = Math.floor(Date.now() / 1000);
		const payload = await signer.sign({ paymentRequirements: longerReq });
		const validBefore = Number(
			(payload.payload as { authorization: { validBefore: string } }).authorization.validBefore,
		);
		expect(validBefore - before).toBeLessThanOrEqual(11);
	});

	it("respects per-call validAfter / validBefore overrides", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const payload = await signer.sign({
			paymentRequirements: JPYC_REQ,
			validAfter: 100n,
			validBefore: 200n,
		});
		const auth = (payload.payload as { authorization: { validAfter: string; validBefore: string } })
			.authorization;
		expect(auth.validAfter).toBe("100");
		expect(auth.validBefore).toBe("200");
	});

	it("rejects validBefore <= validAfter", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		await expect(
			signer.sign({
				paymentRequirements: JPYC_REQ,
				validAfter: 500n,
				validBefore: 500n,
			}),
		).rejects.toBeInstanceOf(X402InvalidPayloadError);
	});
});

describe("createX402PaymentSigner — asset whitelist (Threat 1.4)", () => {
	it("ignores adversarial extra.name / extra.version when asset is known JPYC v2", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const adversarial: X402PaymentRequirements = {
			...JPYC_REQ,
			extra: { name: "Evil", version: "0" },
		};
		const payload = await signer.sign({ paymentRequirements: adversarial });
		const exact = payload.payload as {
			signature: `0x${string}`;
			authorization: {
				from: Address;
				to: Address;
				value: string;
				validAfter: string;
				validBefore: string;
				nonce: `0x${string}`;
			};
		};
		// The signer must have used the pinned JPYC v2 domain — recovering
		// against the adversarial "Evil"/"0" name/version must fail to match
		// the signer address.
		const recovered = await recoverTypedDataAddress({
			domain: {
				name: "JPY Coin",
				version: "1",
				chainId: 80002,
				verifyingContract: JPYC_REQ.asset,
			},
			types: {
				TransferWithAuthorization: [
					{ name: "from", type: "address" },
					{ name: "to", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "validAfter", type: "uint256" },
					{ name: "validBefore", type: "uint256" },
					{ name: "nonce", type: "bytes32" },
				],
			},
			primaryType: "TransferWithAuthorization",
			message: {
				from: exact.authorization.from,
				to: exact.authorization.to,
				value: BigInt(exact.authorization.value),
				validAfter: BigInt(exact.authorization.validAfter),
				validBefore: BigInt(exact.authorization.validBefore),
				nonce: exact.authorization.nonce,
			},
			signature: exact.signature,
		});
		expect(getAddress(recovered)).toBe(getAddress(account.address));
	});

	it("refuses to sign when requirements.asset does not match the pinned verifyingContract", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const otherToken: X402PaymentRequirements = {
			...JPYC_REQ,
			asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
		};
		await expect(signer.sign({ paymentRequirements: otherToken })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("accepts an unsafeOverride and pins its domain for signing", async () => {
		const customAsset: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: {
				kind: "unsafeOverride",
				domain: { name: "USDC", version: "2", verifyingContract: customAsset },
			},
		});
		const reqUsdc: X402PaymentRequirements = {
			...JPYC_REQ,
			asset: customAsset,
			extra: { name: "Evil", version: "999" },
		};
		const payload = await signer.sign({ paymentRequirements: reqUsdc });
		const exact = payload.payload as {
			signature: `0x${string}`;
			authorization: {
				from: Address;
				to: Address;
				value: string;
				validAfter: string;
				validBefore: string;
				nonce: `0x${string}`;
			};
		};
		// The unsafeOverride domain — not the wire-format extra — must be what
		// recovers the signer.
		const recovered = await recoverTypedDataAddress({
			domain: {
				name: "USDC",
				version: "2",
				chainId: 80002,
				verifyingContract: customAsset,
			},
			types: {
				TransferWithAuthorization: [
					{ name: "from", type: "address" },
					{ name: "to", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "validAfter", type: "uint256" },
					{ name: "validBefore", type: "uint256" },
					{ name: "nonce", type: "bytes32" },
				],
			},
			primaryType: "TransferWithAuthorization",
			message: {
				from: exact.authorization.from,
				to: exact.authorization.to,
				value: BigInt(exact.authorization.value),
				validAfter: BigInt(exact.authorization.validAfter),
				validBefore: BigInt(exact.authorization.validBefore),
				nonce: exact.authorization.nonce,
			},
			signature: exact.signature,
		});
		expect(getAddress(recovered)).toBe(getAddress(account.address));
	});

	it("throws X402InvalidConfigError on an unknown asset.id", () => {
		expect(() =>
			createX402PaymentSigner({
				network: "testnet",
				account,
				// @ts-expect-error — testing a JS consumer smuggling an unknown id past the union
				asset: { kind: "known", id: "fake-asset" },
			}),
		).toThrow(X402InvalidConfigError);
	});

	it("throws X402InvalidConfigError on an unknown asset.kind", () => {
		expect(() =>
			createX402PaymentSigner({
				network: "testnet",
				account,
				// @ts-expect-error — testing a JS consumer smuggling an unknown kind past the union
				asset: { kind: "bogus" },
			}),
		).toThrow(X402InvalidConfigError);
	});

	it("throws X402InvalidConfigError on unsafeOverride with invalid verifyingContract", () => {
		expect(() =>
			createX402PaymentSigner({
				network: "testnet",
				account,
				asset: {
					kind: "unsafeOverride",
					domain: {
						name: "Foo",
						version: "1",
						verifyingContract: "not-an-address" as Address,
					},
				},
			}),
		).toThrow(X402InvalidConfigError);
	});
});

describe("createX402PaymentSigner — requirements validation", () => {
	it("throws on unsupported scheme", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const bad = { ...JPYC_REQ, scheme: "permit2" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on amount that is not a decimal string", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const cases = ["", "0x10", "1.5", "-100", " 100 ", "01"];
		for (const amount of cases) {
			const bad: X402PaymentRequirements = { ...JPYC_REQ, amount };
			await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
				X402InvalidPayloadError,
			);
		}
	});

	it("throws on amount === 0", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const bad: X402PaymentRequirements = { ...JPYC_REQ, amount: "0" };
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on amount > uint256 max", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const overflow = `1${"0".repeat(78)}`; // 10^78 > 2^256-1
		const bad: X402PaymentRequirements = { ...JPYC_REQ, amount: overflow };
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on maxTimeoutSeconds <= 0", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const bad: X402PaymentRequirements = { ...JPYC_REQ, maxTimeoutSeconds: 0 };
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on bad asset address", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const bad = { ...JPYC_REQ, asset: "0xdeadbeef" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on bad payTo address", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const bad = { ...JPYC_REQ, payTo: "not-an-address" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("rejects unsupported network (eip155:8453 — Base, not in supportedChains)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const bad = { ...JPYC_REQ, network: "eip155:8453" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on signer with defaultLifetimeSeconds <= 0", () => {
		expect(() =>
			createX402PaymentSigner({
				network: "testnet",
				account,
				asset: { kind: "known", id: "jpyc-v2" },
				defaultLifetimeSeconds: 0,
			}),
		).toThrow(X402InvalidPayloadError);
	});
});

describe("createX402PaymentSigner — network mismatch fail-fast", () => {
	const POLYGON_MAINNET_REQ: X402PaymentRequirements = {
		...JPYC_REQ,
		network: "eip155:137",
	};

	it("throws when signer=testnet receives mainnet requirements", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		await expect(signer.sign({ paymentRequirements: POLYGON_MAINNET_REQ })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
		await expect(signer.sign({ paymentRequirements: POLYGON_MAINNET_REQ })).rejects.toThrow(
			/refusing to sign payment for real funds/,
		);
	});

	it("throws when signer=mainnet receives testnet requirements", async () => {
		const signer = createX402PaymentSigner({
			network: "mainnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toThrow(/is a testnet/);
	});

	it("accepts matching signer=mainnet + mainnet requirements", async () => {
		const signer = createX402PaymentSigner({
			network: "mainnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const payload = await signer.sign({ paymentRequirements: POLYGON_MAINNET_REQ });
		expect(payload.accepted.network).toBe("eip155:137");
	});
});

describe("createX402PaymentSigner — resource echo", () => {
	it("includes resource in payload when provided", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const resource = { url: "https://api.example.com/weather", description: "weather" };
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ, resource });
		expect(payload.resource).toEqual(resource);
	});

	it("omits resource entirely when not provided (matches exactOptionalPropertyTypes)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ });
		expect("resource" in payload).toBe(false);
	});
});

describe("createX402PaymentSigner — maxAmountPerSign (threat 1.14)", () => {
	// JPYC_REQ.amount is 10 JPYC (18 decimals) = 10 * 10^18.
	const TEN_JPYC = 10_000_000_000_000_000_000n;

	it("signs when the amount is exactly at the ceiling (equal is allowed)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
			maxAmountPerSign: TEN_JPYC,
		});
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).resolves.toBeDefined();
	});

	it("signs when the amount is under the ceiling", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
			maxAmountPerSign: TEN_JPYC * 2n,
		});
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).resolves.toBeDefined();
	});

	it("throws X402InvalidPayloadError when the amount exceeds the ceiling", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
			maxAmountPerSign: TEN_JPYC - 1n,
		});
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("applies no ceiling when maxAmountPerSign is unset (backward-compatible default)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const huge: X402PaymentRequirements = {
			...JPYC_REQ,
			amount: (TEN_JPYC * 1_000_000n).toString(),
		};
		await expect(signer.sign({ paymentRequirements: huge })).resolves.toBeDefined();
	});

	it("rejects a non-positive ceiling at construction", () => {
		for (const bad of [0n, -1n]) {
			expect(() =>
				createX402PaymentSigner({
					network: "testnet",
					account,
					asset: { kind: "known", id: "jpyc-v2" },
					maxAmountPerSign: bad,
				}),
			).toThrow(X402InvalidPayloadError);
		}
	});
});

// ---------------------------------------------------------------------------
// A deployed smart account as the payer (ERC-1271, #54)
// ---------------------------------------------------------------------------

// Kernel v3.1's typed-data signature: 0x01, the ECDSA validator's address, a 65-byte signature.
const SMART_ACCOUNT = getAddress("0x2222222222222222222222222222222222222222");
const KERNEL_SIGNATURE: Hex = concat([
	"0x01",
	"0x3333333333333333333333333333333333333333",
	`0x${"ab".repeat(64)}1b`,
]);
// An undeployed account's signature, which viem / ZeroDev wrap as ERC-6492.
const UNDEPLOYED_SIGNATURE: Hex = serializeErc6492Signature({
	address: "0x6666666666666666666666666666666666666666",
	data: "0xdeadbeef",
	signature: KERNEL_SIGNATURE,
});

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

// A token that checks ERC-1271 in transferWithAuthorization (USDC v2.2-like), pinned by the caller.
const USDC_LIKE = getAddress("0x4444444444444444444444444444444444444444");
const USDC_ASSET = {
	kind: "unsafeOverride",
	domain: { name: "USDC", version: "2", verifyingContract: USDC_LIKE },
} as const;
const USDC_REQ: X402PaymentRequirements = {
	scheme: "exact",
	network: "eip155:80002",
	amount: "1000000",
	asset: USDC_LIKE,
	payTo: PAY_TO,
	maxTimeoutSeconds: 60,
	extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
};

describe("createX402PaymentSigner — a deployed smart account pays (ERC-1271, #54)", () => {
	it("carries the smart account's signature whole on a token that checks ERC-1271", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account: smartAccount(KERNEL_SIGNATURE),
			asset: USDC_ASSET,
		});
		const payload = await signer.sign({ paymentRequirements: USDC_REQ });
		const exact = payload.payload as { signature: Hex; authorization: { from: Address } };
		expect(exact.signature).toBe(KERNEL_SIGNATURE);
		expect(getAddress(exact.authorization.from)).toBe(SMART_ACCOUNT);
	});

	it("refuses before sending when the asset is JPYC (ecrecover only)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account: smartAccount(KERNEL_SIGNATURE),
			asset: { kind: "known", id: "jpyc-v2" },
		});
		const attempt = signer.sign({ paymentRequirements: JPYC_REQ });
		await expect(attempt).rejects.toBeInstanceOf(X402InvalidPayloadError);
		await expect(attempt).rejects.toThrow(/ecrecover/);
		await expect(attempt).rejects.toThrow(/transferJpyc/);
	});

	it("refuses JPYC pinned through unsafeOverride too (decided by address)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account: smartAccount(KERNEL_SIGNATURE),
			asset: {
				kind: "unsafeOverride",
				domain: { name: "JPY Coin", version: "1", verifyingContract: JPYC_V2_ADDRESS },
			},
		});
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toThrow(/ecrecover/);
	});

	it("sends an undeployed account's ERC-6492 signature as it is: the facilitator may deploy it", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account: smartAccount(UNDEPLOYED_SIGNATURE),
			asset: USDC_ASSET,
		});
		const payload = await signer.sign({ paymentRequirements: USDC_REQ });
		expect((payload.payload as { signature: Hex }).signature).toBe(UNDEPLOYED_SIGNATURE);
	});

	it("refuses an undeployed account's ERC-6492 signature on JPYC (ecrecover only)", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account: smartAccount(UNDEPLOYED_SIGNATURE),
			asset: { kind: "known", id: "jpyc-v2" },
		});
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toThrow(/ecrecover/);
	});

	it("leaves an EOA on the same token as it was", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account, asset: USDC_ASSET });
		const payload = await signer.sign({ paymentRequirements: USDC_REQ });
		const exact = payload.payload as { signature: Hex };
		expect(exact.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
	});
});
