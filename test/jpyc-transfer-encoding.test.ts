import { encodeFunctionData, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ConfiguredKernelClient } from "../src";
import { jpycAbi, TransferJpycInputError, transferJpyc } from "../src";

// Checksummed burn-style address so viem's strict ABI encoder accepts it.
const TO = getAddress("0x000000000000000000000000000000000000dEaD");

describe("JPYC ABI", () => {
	it("encodes `transfer(address,uint256)` with the canonical ERC-20 selector", () => {
		const data = encodeFunctionData({
			abi: jpycAbi,
			functionName: "transfer",
			args: [TO, 123n * 10n ** 18n],
		});
		// 0xa9059cbb = keccak256("transfer(address,uint256)")[:4]
		expect(data.slice(0, 10)).toBe("0xa9059cbb");
	});

	it("encodes `transferWithAuthorization` with the EIP-3009 selector", () => {
		const data = encodeFunctionData({
			abi: jpycAbi,
			functionName: "transferWithAuthorization",
			args: [
				TO,
				TO,
				1n,
				0n,
				2n,
				`0x${"00".repeat(32)}` as Hex,
				27,
				`0x${"11".repeat(32)}` as Hex,
				`0x${"22".repeat(32)}` as Hex,
			],
		});
		// 0xe3ee160e = keccak256("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")[:4]
		expect(data.slice(0, 10)).toBe("0xe3ee160e");
	});
});

describe("transferJpyc input validation", () => {
	const baseFakeClient = {
		chain: { id: 80_002 },
		account: { encodeCalls: () => Promise.resolve("0x" as const) },
		sendUserOperation: () => Promise.resolve("0x" as const),
		waitForUserOperationReceipt: () =>
			Promise.resolve({ receipt: { transactionHash: "0x" }, success: true }),
	} as unknown as ConfiguredKernelClient;

	it("rejects a malformed `to`", async () => {
		await expect(
			transferJpyc(baseFakeClient, {
				to: "0xnotanaddress" as `0x${string}`,
				amount: 1n,
			}),
		).rejects.toThrow(TransferJpycInputError);
	});

	it("rejects a non-positive amount", async () => {
		await expect(transferJpyc(baseFakeClient, { to: TO, amount: 0n })).rejects.toThrow(/positive/);
		await expect(transferJpyc(baseFakeClient, { to: TO, amount: -1n })).rejects.toThrow(/positive/);
	});

	it("rejects an unsupported chain", async () => {
		const wrongChainClient = {
			...baseFakeClient,
			chain: { id: 1 },
		} as unknown as ConfiguredKernelClient;
		await expect(transferJpyc(wrongChainClient, { to: TO, amount: 1n })).rejects.toThrow(
			/not a kawasekit-supported chain/,
		);
	});
});
