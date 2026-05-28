/**
 * Integration tests for `createSelfFacilitator` against a locally-deployed
 * MockJPYC on anvil. Anvil is started with chain ID 80002 (Polygon Amoy) so
 * the `eip155:80002` x402 network identifier is valid end-to-end.
 */

import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import {
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	getAddress,
	http,
	parseUnits,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startAnvil, stopAnvil } from "../../test/helpers/anvil";
import { deployMockJpyc, mockJpycAbi } from "../../test/helpers/deploy-mock-jpyc";
import {
	authorizationDeadlineFromNow,
	generateAuthorizationNonce,
	JPYC_DECIMALS,
	signTransferWithAuthorization,
} from "../index";
import { createSelfFacilitator } from "./facilitator";
import type { X402PaymentPayload, X402PaymentRequirements } from "./types";

const ALICE_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const BOB_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PAY_TO_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const alice = privateKeyToAccount(ALICE_PK);
// `bob` is the facilitator EOA in every test below. M4-6.5 added a
// construction-time check on `createSelfFacilitator` that requires its
// walletClient.account to carry viem's nonceManager — attach it here so
// every test passes the guard without each spelling out the requirement.
const bob = privateKeyToAccount(BOB_PK, { nonceManager });
const payToAccount = privateKeyToAccount(PAY_TO_PK);

const POLYGON_AMOY_CHAIN_ID = 80_002;
const MOCK_NAME = "MockJPYC";
const MOCK_VERSION = "1";
const chain: Chain = { ...anvil, id: POLYGON_AMOY_CHAIN_ID };

let mockJpyc: Address;
let publicClient: PublicClient<Transport, Chain>;
let aliceWallet: WalletClient<Transport, Chain, Account>;
let bobWallet: WalletClient<Transport, Chain, Account>;

beforeAll(async () => {
	// Distinct port from eip3009.test.ts (8556) so vitest's parallel runner
	// can spin up both anvil instances without colliding.
	const handle = await startAnvil({ chainId: POLYGON_AMOY_CHAIN_ID, port: 8557 });
	const transport = http(handle.rpcUrl);
	publicClient = createPublicClient({ chain, transport });
	aliceWallet = createWalletClient({ chain, transport, account: alice });
	bobWallet = createWalletClient({ chain, transport, account: bob });
	mockJpyc = await deployMockJpyc(aliceWallet, publicClient);
}, 30_000);

afterAll(async () => {
	await stopAnvil();
});

beforeEach(async () => {
	// Fund Alice with a fresh batch of JPYC for each test.
	const hash = await aliceWallet.sendTransaction({
		to: mockJpyc,
		value: 0n,
		data: encodeFunctionData({
			abi: mockJpycAbi,
			functionName: "mint",
			args: [alice.address, parseUnits("1000", JPYC_DECIMALS)],
		}),
	});
	await publicClient.waitForTransactionReceipt({ hash });
});

function buildJpycRequirements(amount: bigint): X402PaymentRequirements {
	return {
		scheme: "exact",
		network: "eip155:80002",
		amount: amount.toString(),
		asset: mockJpyc,
		payTo: payToAccount.address,
		maxTimeoutSeconds: 60,
		extra: { assetTransferMethod: "eip3009", name: MOCK_NAME, version: MOCK_VERSION },
	};
}

async function signPayload(requirements: X402PaymentRequirements): Promise<X402PaymentPayload> {
	const value = BigInt(requirements.amount);
	const validAfter = 0n;
	const validBefore = authorizationDeadlineFromNow(300);
	const nonce = generateAuthorizationNonce();

	const signed = await signTransferWithAuthorization(
		alice,
		{
			name: MOCK_NAME,
			version: MOCK_VERSION,
			chainId: POLYGON_AMOY_CHAIN_ID,
			verifyingContract: requirements.asset,
		},
		{
			from: alice.address,
			to: requirements.payTo,
			value,
			validAfter,
			validBefore,
			nonce,
		},
	);

	return {
		x402Version: 2,
		accepted: requirements,
		payload: {
			signature: signed.signature,
			authorization: {
				from: alice.address,
				to: requirements.payTo,
				value: value.toString(),
				validAfter: validAfter.toString(),
				validBefore: validBefore.toString(),
				nonce,
			},
		},
	};
}

async function readBalance(account: Address): Promise<bigint> {
	const balance = await publicClient.readContract({
		address: mockJpyc,
		abi: mockJpycAbi,
		functionName: "balanceOf",
		args: [account],
	});
	return balance as bigint;
}

describe("createSelfFacilitator — verify happy path", () => {
	it("returns isValid=true for a well-formed authorization with sufficient balance", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(result.isValid).toBe(true);
		expect(getAddress(result.payer!)).toBe(getAddress(alice.address));
	});
});

describe("createSelfFacilitator — verify rejection paths", () => {
	it("rejects scheme mismatch", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);
		const bad = { ...requirements, scheme: "permit2" } as unknown as X402PaymentRequirements;

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: bad,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_scheme");
	});

	it("rejects network not matching facilitator chain", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);
		const onMainnet = { ...requirements, network: "eip155:137" } as X402PaymentRequirements;

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: onMainnet,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_network");
	});

	it("rejects value mismatch between requirements and authorization", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);
		const requirementsAskingMore: X402PaymentRequirements = {
			...requirements,
			amount: parseUnits("20", JPYC_DECIMALS).toString(),
		};

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirementsAskingMore,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
	});

	it("rejects recipient mismatch", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);
		const swapped: X402PaymentRequirements = { ...requirements, payTo: bob.address };

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: swapped,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_exact_evm_payload_recipient_mismatch");
	});

	it("rejects an expired authorization (validBefore < now)", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const nonce = generateAuthorizationNonce();
		const value = parseUnits("10", JPYC_DECIMALS);
		const signed = await signTransferWithAuthorization(
			alice,
			{
				name: MOCK_NAME,
				version: MOCK_VERSION,
				chainId: POLYGON_AMOY_CHAIN_ID,
				verifyingContract: requirements.asset,
			},
			{
				from: alice.address,
				to: requirements.payTo,
				value,
				validAfter: 0n,
				validBefore: 1n, // expired in 1970
				nonce,
			},
		);
		const paymentPayload: X402PaymentPayload = {
			x402Version: 2,
			accepted: requirements,
			payload: {
				signature: signed.signature,
				authorization: {
					from: alice.address,
					to: requirements.payTo,
					value: value.toString(),
					validAfter: "0",
					validBefore: "1",
					nonce,
				},
			},
		};

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
	});

	it("rejects a not-yet-valid authorization (validAfter > now)", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const nonce = generateAuthorizationNonce();
		const value = parseUnits("10", JPYC_DECIMALS);
		const farFuture = BigInt(Math.floor(Date.now() / 1000) + 86_400);
		const signed = await signTransferWithAuthorization(
			alice,
			{
				name: MOCK_NAME,
				version: MOCK_VERSION,
				chainId: POLYGON_AMOY_CHAIN_ID,
				verifyingContract: requirements.asset,
			},
			{
				from: alice.address,
				to: requirements.payTo,
				value,
				validAfter: farFuture,
				validBefore: farFuture + 1000n,
				nonce,
			},
		);
		const paymentPayload: X402PaymentPayload = {
			x402Version: 2,
			accepted: requirements,
			payload: {
				signature: signed.signature,
				authorization: {
					from: alice.address,
					to: requirements.payTo,
					value: value.toString(),
					validAfter: farFuture.toString(),
					validBefore: (farFuture + 1000n).toString(),
					nonce,
				},
			},
		};

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_after");
	});

	it("rejects an authorization whose signature does not recover to `from`", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		// Sign the same authorization with Bob (the facilitator), then claim
		// `from = alice`. Recovery yields Bob, which differs from `from`.
		const value = parseUnits("10", JPYC_DECIMALS);
		const validBefore = authorizationDeadlineFromNow(300);
		const nonce = generateAuthorizationNonce();
		const signed = await signTransferWithAuthorization(
			bob,
			{
				name: MOCK_NAME,
				version: MOCK_VERSION,
				chainId: POLYGON_AMOY_CHAIN_ID,
				verifyingContract: requirements.asset,
			},
			{
				from: bob.address,
				to: requirements.payTo,
				value,
				validAfter: 0n,
				validBefore,
				nonce,
			},
		);
		const tampered: X402PaymentPayload = {
			x402Version: 2,
			accepted: requirements,
			payload: {
				signature: signed.signature,
				authorization: {
					// Bob signed, but the payload claims Alice is `from`.
					from: alice.address,
					to: requirements.payTo,
					value: value.toString(),
					validAfter: "0",
					validBefore: validBefore.toString(),
					nonce,
				},
			},
		};

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload: tampered,
			paymentRequirements: requirements,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_exact_evm_payload_signature");
	});

	it("rejects when balance is insufficient", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		// Alice has 1000 JPYC from beforeEach; ask for 100_000 JPYC.
		const requirements = buildJpycRequirements(parseUnits("100000", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("insufficient_funds");
	});

	it("rejects a malformed payload (missing signature)", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const bad: X402PaymentPayload = {
			x402Version: 2,
			accepted: requirements,
			payload: { signature: "not-hex", authorization: {} },
		};

		const result = await facilitator.verify({
			x402Version: 2,
			paymentPayload: bad,
			paymentRequirements: requirements,
		});
		expect(result.isValid).toBe(false);
		expect(result.invalidReason).toBe("invalid_payload");
	});
});

describe("createSelfFacilitator — settle end-to-end", () => {
	it("broadcasts transferWithAuthorization and transfers tokens on success", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const value = parseUnits("5", JPYC_DECIMALS);
		const requirements = buildJpycRequirements(value);
		const paymentPayload = await signPayload(requirements);

		const aliceBalanceBefore = await readBalance(alice.address);
		const payToBalanceBefore = await readBalance(payToAccount.address);

		const result = await facilitator.settle({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});

		expect(result.success).toBe(true);
		expect(result.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
		expect(result.network).toBe("eip155:80002");
		expect(getAddress(result.payer!)).toBe(getAddress(alice.address));
		expect(result.amount).toBe(value.toString());

		expect(await readBalance(alice.address)).toBe(aliceBalanceBefore - value);
		expect(await readBalance(payToAccount.address)).toBe(payToBalanceBefore + value);
	}, 30_000);

	it("rejects nonce replay after a successful settlement", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("1", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);

		const first = await facilitator.settle({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(first.success).toBe(true);

		// Replaying the same payload should now fail verify (nonce used).
		const second = await facilitator.verify({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(second.isValid).toBe(false);
		expect(second.invalidReason).toBe("invalid_payload");
	}, 30_000);

	it("returns a failure response without broadcasting when verify rejects", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const requirements = buildJpycRequirements(parseUnits("10", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);
		const requirementsAskingMore: X402PaymentRequirements = {
			...requirements,
			amount: parseUnits("20", JPYC_DECIMALS).toString(),
		};

		const result = await facilitator.settle({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirementsAskingMore,
		});
		expect(result.success).toBe(false);
		expect(result.errorReason).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
		expect(result.transaction).toBe("");
	});
});

describe("createSelfFacilitator — supported", () => {
	it("advertises a single (exact, eip155:80002) kind matching the walletClient's chain", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
		});
		const result = await facilitator.supported();
		expect(result.kinds).toHaveLength(1);
		expect(result.kinds[0]?.x402Version).toBe(2);
		expect(result.kinds[0]?.scheme).toBe("exact");
		expect(result.kinds[0]?.network).toBe("eip155:80002");
		expect(result.signers["eip155:*"]).toEqual([bob.address]);
	});
});

describe("createSelfFacilitator — network mismatch fail-fast", () => {
	it("throws when network=mainnet but walletClient.chain is Polygon Amoy (testnet)", () => {
		expect(() =>
			createSelfFacilitator({ network: "mainnet", walletClient: bobWallet, publicClient }),
		).toThrow(/is a testnet/);
	});

	it("throws when network=testnet but walletClient.chain is Polygon mainnet", () => {
		// Synthesize a mainnet (137) wallet client. createSelfFacilitator's
		// network check is purely on chain.id, so we never actually broadcast —
		// any transport satisfies the type.
		const mainnetChain: Chain = { ...chain, id: 137 };
		const mainnetWallet = createWalletClient({
			chain: mainnetChain,
			transport: http("http://127.0.0.1:0"),
			account: bob,
		});
		expect(() =>
			createSelfFacilitator({
				network: "testnet",
				walletClient: mainnetWallet,
				publicClient,
			}),
		).toThrow(/refusing to broadcast with real funds/);
	});
});

describe("createSelfFacilitator — nonceManager enforcement (threat 2.2)", () => {
	it("throws at construction when walletClient.account lacks nonceManager", () => {
		// Bob WITHOUT nonceManager — the failure mode the M4-6.5 guard catches.
		const bobWithoutNonceManager = privateKeyToAccount(BOB_PK);
		const danglingWallet = createWalletClient({
			chain,
			transport: http("http://127.0.0.1:0"),
			account: bobWithoutNonceManager,
		});
		expect(() =>
			createSelfFacilitator({
				network: "testnet",
				walletClient: danglingWallet,
				publicClient,
			}),
		).toThrow(/nonceManager/);
	});

	it("constructs successfully when nonceManager is attached", () => {
		// `bob` at module scope already carries nonceManager — this is the
		// happy-path proof that the guard is not over-restrictive.
		expect(() =>
			createSelfFacilitator({
				network: "testnet",
				walletClient: bobWallet,
				publicClient,
			}),
		).not.toThrow();
	});
});

describe("createSelfFacilitator — confirmation depth (threat 2.8)", () => {
	// Behavioural confirmation testing is impractical inside anvil's
	// on-demand mining model (we would have to mine N blocks manually
	// after every settle). What we CAN verify is the construction-time
	// contract: the option accepts integers >= 1, and the synthesised
	// settle on Amoy still succeeds with the testnet default (=1) and an
	// operator-provided override.
	it("accepts a custom confirmation depth and still completes settle on testnet anvil", async () => {
		const facilitator = createSelfFacilitator({
			network: "testnet",
			walletClient: bobWallet,
			publicClient,
			confirmations: 1, // explicit testnet default
		});
		const requirements = buildJpycRequirements(parseUnits("1", JPYC_DECIMALS));
		const paymentPayload = await signPayload(requirements);
		const result = await facilitator.settle({
			x402Version: 2,
			paymentPayload,
			paymentRequirements: requirements,
		});
		expect(result.success).toBe(true);
	});

	it("constructs without specifying confirmations (testnet default = 1)", () => {
		expect(() =>
			createSelfFacilitator({
				network: "testnet",
				walletClient: bobWallet,
				publicClient,
			}),
		).not.toThrow();
	});
});
