import type { Address } from "viem";
import { getAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { createX402PaymentSigner, X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS } from "./client";
import { X402InvalidPayloadError } from "./errors";
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
		const signer = createX402PaymentSigner({ network: "testnet", account });
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
		const signer = createX402PaymentSigner({ network: "testnet", account });
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
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const a = await signer.sign({ paymentRequirements: JPYC_REQ });
		const b = await signer.sign({ paymentRequirements: JPYC_REQ });
		const nonceA = (a.payload as { authorization: { nonce: string } }).authorization.nonce;
		const nonceB = (b.payload as { authorization: { nonce: string } }).authorization.nonce;
		expect(nonceA).not.toBe(nonceB);
	});

	it("exposes the signing address", () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		expect(getAddress(signer.address)).toBe(getAddress(account.address));
	});
});

describe("createX402PaymentSigner — validity window", () => {
	it("defaults validBefore to now + min(default, maxTimeoutSeconds)", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
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
		const signer = createX402PaymentSigner({ network: "testnet", account });
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
		const signer = createX402PaymentSigner({ network: "testnet", account });
		await expect(
			signer.sign({
				paymentRequirements: JPYC_REQ,
				validAfter: 500n,
				validBefore: 500n,
			}),
		).rejects.toBeInstanceOf(X402InvalidPayloadError);
	});
});

describe("createX402PaymentSigner — EIP-712 domain resolution", () => {
	it("prefers paymentRequirements.extra.name / .version", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const reqWithCustomDomain: X402PaymentRequirements = {
			...JPYC_REQ,
			extra: { name: "Acme USD", version: "42" },
		};
		const payload = await signer.sign({ paymentRequirements: reqWithCustomDomain });
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
				name: "Acme USD",
				version: "42",
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

	it("uses domainOverride when provided, ignoring extra", async () => {
		const signer = createX402PaymentSigner({
			network: "testnet",
			account,
			domainOverride: { name: "JPY Coin", version: "1" },
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
		// Should recover only against the overridden domain — not the malicious one.
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

	it("falls back to JPYC_EIP712_DOMAIN_HINT when asset is JPYC and extra has no name/version", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bareJpyc: X402PaymentRequirements = { ...JPYC_REQ, extra: {} };
		// Should not throw — fall back path is exercised.
		await expect(signer.sign({ paymentRequirements: bareJpyc })).resolves.toBeDefined();
	});

	it("throws when extra lacks name/version and asset is not JPYC", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const otherToken: X402PaymentRequirements = {
			...JPYC_REQ,
			asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
			extra: {},
		};
		await expect(signer.sign({ paymentRequirements: otherToken })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});
});

describe("createX402PaymentSigner — requirements validation", () => {
	it("throws on unsupported scheme", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bad = { ...JPYC_REQ, scheme: "permit2" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on amount that is not a decimal string", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const cases = ["", "0x10", "1.5", "-100", " 100 ", "01"];
		for (const amount of cases) {
			const bad: X402PaymentRequirements = { ...JPYC_REQ, amount };
			await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
				X402InvalidPayloadError,
			);
		}
	});

	it("throws on amount === 0", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bad: X402PaymentRequirements = { ...JPYC_REQ, amount: "0" };
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on amount > uint256 max", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const overflow = `1${"0".repeat(78)}`; // 10^78 > 2^256-1
		const bad: X402PaymentRequirements = { ...JPYC_REQ, amount: overflow };
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on maxTimeoutSeconds <= 0", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bad: X402PaymentRequirements = { ...JPYC_REQ, maxTimeoutSeconds: 0 };
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on bad asset address", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bad = { ...JPYC_REQ, asset: "0xdeadbeef" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on bad payTo address", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bad = { ...JPYC_REQ, payTo: "not-an-address" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("rejects unsupported network (eip155:1 — Ethereum mainnet, not in supportedChains)", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const bad = { ...JPYC_REQ, network: "eip155:1" } as unknown as X402PaymentRequirements;
		await expect(signer.sign({ paymentRequirements: bad })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
	});

	it("throws on signer with defaultLifetimeSeconds <= 0", () => {
		expect(() =>
			createX402PaymentSigner({ network: "testnet", account, defaultLifetimeSeconds: 0 }),
		).toThrow(X402InvalidPayloadError);
	});
});

describe("createX402PaymentSigner — network mismatch fail-fast", () => {
	const POLYGON_MAINNET_REQ: X402PaymentRequirements = {
		...JPYC_REQ,
		network: "eip155:137",
	};

	it("throws when signer=testnet receives mainnet requirements", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		await expect(signer.sign({ paymentRequirements: POLYGON_MAINNET_REQ })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
		await expect(signer.sign({ paymentRequirements: POLYGON_MAINNET_REQ })).rejects.toThrow(
			/refusing to sign payment for real funds/,
		);
	});

	it("throws when signer=mainnet receives testnet requirements", async () => {
		const signer = createX402PaymentSigner({ network: "mainnet", account });
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toBeInstanceOf(
			X402InvalidPayloadError,
		);
		await expect(signer.sign({ paymentRequirements: JPYC_REQ })).rejects.toThrow(/is a testnet/);
	});

	it("accepts matching signer=mainnet + mainnet requirements", async () => {
		const signer = createX402PaymentSigner({ network: "mainnet", account });
		const payload = await signer.sign({ paymentRequirements: POLYGON_MAINNET_REQ });
		expect(payload.accepted.network).toBe("eip155:137");
	});
});

describe("createX402PaymentSigner — resource echo", () => {
	it("includes resource in payload when provided", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const resource = { url: "https://api.example.com/weather", description: "weather" };
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ, resource });
		expect(payload.resource).toEqual(resource);
	});

	it("omits resource entirely when not provided (matches exactOptionalPropertyTypes)", async () => {
		const signer = createX402PaymentSigner({ network: "testnet", account });
		const payload = await signer.sign({ paymentRequirements: JPYC_REQ });
		expect("resource" in payload).toBe(false);
	});
});
