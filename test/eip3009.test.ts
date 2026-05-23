/**
 * EIP-3009 integration tests against a locally-deployed MockJPYC on anvil.
 *
 * Validates that kawasekit's signing helpers produce signatures that the
 * production-style JPYC contract (pure ecrecover, no ERC-1271 fallback) will
 * accept.
 */

import {
	type Account,
	type Address,
	type Chain,
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	type Hex,
	http,
	type PublicClient,
	parseUnits,
	type Transport,
	type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	authorizationDeadlineFromNow,
	generateAuthorizationNonce,
	JPYC_DECIMALS,
	signCancelAuthorization,
	signReceiveWithAuthorization,
	signTransferWithAuthorization,
} from "../src";
import { startAnvil, stopAnvil } from "./helpers/anvil";
import { deployMockJpyc, mockJpycAbi } from "./helpers/deploy-mock-jpyc";

// Anvil deterministic accounts (mnemonic: "test test test test test test test test test test test junk")
const ALICE_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const BOB_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EVE_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const alice = privateKeyToAccount(ALICE_PK);
const bob = privateKeyToAccount(BOB_PK);
const eve = privateKeyToAccount(EVE_PK);

const CHAIN_ID = 31_337;
const MOCK_NAME = "MockJPYC";
const MOCK_VERSION = "1";

const chain: Chain = { ...anvil, id: CHAIN_ID };

let mockJpyc: Address;
let publicClient: PublicClient<Transport, Chain>;
let aliceWallet: WalletClient<Transport, Chain, Account>;
let bobWallet: WalletClient<Transport, Chain, Account>;
let eveWallet: WalletClient<Transport, Chain, Account>;

beforeAll(async () => {
	const handle = await startAnvil({ chainId: CHAIN_ID });
	const transport = http(handle.rpcUrl);

	publicClient = createPublicClient({ chain, transport });
	aliceWallet = createWalletClient({ chain, transport, account: alice });
	bobWallet = createWalletClient({ chain, transport, account: bob });
	eveWallet = createWalletClient({ chain, transport, account: eve });

	mockJpyc = await deployMockJpyc(aliceWallet, publicClient);

	// Sanity-check the on-chain domain matches our compile-time expectations.
	const onChainName = await publicClient.readContract({
		address: mockJpyc,
		abi: mockJpycAbi,
		functionName: "name",
	});
	const onChainVersion = await publicClient.readContract({
		address: mockJpyc,
		abi: mockJpycAbi,
		functionName: "version",
	});
	expect(onChainName).toBe(MOCK_NAME);
	expect(onChainVersion).toBe(MOCK_VERSION);
}, 30_000);

afterAll(async () => {
	await stopAnvil();
});

function jpycDomain() {
	return {
		name: MOCK_NAME,
		version: MOCK_VERSION,
		chainId: CHAIN_ID,
		verifyingContract: mockJpyc,
	};
}

async function sendTxFrom(
	wallet: WalletClient<Transport, Chain, Account>,
	to: Address,
	data: Hex,
): Promise<void> {
	const hash = await wallet.sendTransaction({ to, data, value: 0n });
	await publicClient.waitForTransactionReceipt({ hash });
}

async function expectTxToRevert(
	wallet: WalletClient<Transport, Chain, Account>,
	to: Address,
	data: Hex,
	matcher: RegExp,
): Promise<void> {
	await expect(wallet.sendTransaction({ to, data, value: 0n })).rejects.toThrow(matcher);
}

function encodeMint(to: Address, amount: bigint): Hex {
	return encodeFunctionData({
		abi: mockJpycAbi,
		functionName: "mint",
		args: [to, amount],
	});
}

function encodeTransferAuth(signed: {
	message: {
		from: Address;
		to: Address;
		value: bigint;
		validAfter: bigint;
		validBefore: bigint;
		nonce: Hex;
	};
	v: number;
	r: Hex;
	s: Hex;
}): Hex {
	return encodeFunctionData({
		abi: mockJpycAbi,
		functionName: "transferWithAuthorization",
		args: [
			signed.message.from,
			signed.message.to,
			signed.message.value,
			signed.message.validAfter,
			signed.message.validBefore,
			signed.message.nonce,
			signed.v,
			signed.r,
			signed.s,
		],
	});
}

function encodeReceiveAuth(signed: {
	message: {
		from: Address;
		to: Address;
		value: bigint;
		validAfter: bigint;
		validBefore: bigint;
		nonce: Hex;
	};
	v: number;
	r: Hex;
	s: Hex;
}): Hex {
	return encodeFunctionData({
		abi: mockJpycAbi,
		functionName: "receiveWithAuthorization",
		args: [
			signed.message.from,
			signed.message.to,
			signed.message.value,
			signed.message.validAfter,
			signed.message.validBefore,
			signed.message.nonce,
			signed.v,
			signed.r,
			signed.s,
		],
	});
}

function encodeCancelAuth(signed: {
	message: { authorizer: Address; nonce: Hex };
	v: number;
	r: Hex;
	s: Hex;
}): Hex {
	return encodeFunctionData({
		abi: mockJpycAbi,
		functionName: "cancelAuthorization",
		args: [signed.message.authorizer, signed.message.nonce, signed.v, signed.r, signed.s],
	});
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

describe("signTransferWithAuthorization", () => {
	it("produces a signature that MockJPYC accepts when relayed by a third party", async () => {
		const amount = parseUnits("100", JPYC_DECIMALS);
		await sendTxFrom(
			aliceWallet,
			mockJpyc,
			encodeMint(alice.address, parseUnits("1000", JPYC_DECIMALS)),
		);
		const bobBefore = await readBalance(bob.address);

		const signed = await signTransferWithAuthorization(alice, jpycDomain(), {
			from: alice.address,
			to: bob.address,
			value: amount,
			validAfter: 0n,
			validBefore: authorizationDeadlineFromNow(300),
			nonce: generateAuthorizationNonce(),
		});

		await sendTxFrom(eveWallet, mockJpyc, encodeTransferAuth(signed));
		expect(await readBalance(bob.address)).toBe(bobBefore + amount);
	});

	it("throws when signer address does not match `from`", async () => {
		await expect(
			signTransferWithAuthorization(eve, jpycDomain(), {
				from: alice.address, // mismatch
				to: bob.address,
				value: 1n,
				validAfter: 0n,
				validBefore: authorizationDeadlineFromNow(60),
				nonce: generateAuthorizationNonce(),
			}),
		).rejects.toThrow(/must come from/);
	});

	it("the contract rejects nonce reuse", async () => {
		const amount = parseUnits("1", JPYC_DECIMALS);
		await sendTxFrom(aliceWallet, mockJpyc, encodeMint(alice.address, amount * 2n));

		const signed = await signTransferWithAuthorization(alice, jpycDomain(), {
			from: alice.address,
			to: bob.address,
			value: amount,
			validAfter: 0n,
			validBefore: authorizationDeadlineFromNow(300),
			nonce: generateAuthorizationNonce(),
		});

		await sendTxFrom(eveWallet, mockJpyc, encodeTransferAuth(signed));
		await expectTxToRevert(eveWallet, mockJpyc, encodeTransferAuth(signed), /used or canceled/);
	});
});

describe("signReceiveWithAuthorization", () => {
	it("requires the caller to be `to`", async () => {
		await sendTxFrom(
			aliceWallet,
			mockJpyc,
			encodeMint(alice.address, parseUnits("10", JPYC_DECIMALS)),
		);

		const signed = await signReceiveWithAuthorization(alice, jpycDomain(), {
			from: alice.address,
			to: bob.address,
			value: parseUnits("5", JPYC_DECIMALS),
			validAfter: 0n,
			validBefore: authorizationDeadlineFromNow(300),
			nonce: generateAuthorizationNonce(),
		});

		// Eve cannot submit (frontrun protection).
		await expectTxToRevert(
			eveWallet,
			mockJpyc,
			encodeReceiveAuth(signed),
			/caller must be the payee/,
		);

		// Bob (the payee) can submit.
		await sendTxFrom(bobWallet, mockJpyc, encodeReceiveAuth(signed));
	});
});

describe("signCancelAuthorization", () => {
	it("prevents the matching transferWithAuthorization from landing later", async () => {
		await sendTxFrom(
			aliceWallet,
			mockJpyc,
			encodeMint(alice.address, parseUnits("10", JPYC_DECIMALS)),
		);

		const nonce = generateAuthorizationNonce();

		const signedCancel = await signCancelAuthorization(alice, jpycDomain(), {
			authorizer: alice.address,
			nonce,
		});
		await sendTxFrom(eveWallet, mockJpyc, encodeCancelAuth(signedCancel));

		const signedTransfer = await signTransferWithAuthorization(alice, jpycDomain(), {
			from: alice.address,
			to: bob.address,
			value: parseUnits("3", JPYC_DECIMALS),
			validAfter: 0n,
			validBefore: authorizationDeadlineFromNow(300),
			nonce,
		});
		await expectTxToRevert(
			eveWallet,
			mockJpyc,
			encodeTransferAuth(signedTransfer),
			/used or canceled/,
		);
	});
});

describe("returned signature shape", () => {
	it("splits the signature into canonical (v, r, s)", async () => {
		const signed = await signTransferWithAuthorization(alice, jpycDomain(), {
			from: alice.address,
			to: bob.address,
			value: 1n,
			validAfter: 0n,
			validBefore: authorizationDeadlineFromNow(60),
			nonce: generateAuthorizationNonce(),
		});
		expect([27, 28]).toContain(signed.v);
		expect(signed.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
		expect(signed.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
		expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
	});
});
