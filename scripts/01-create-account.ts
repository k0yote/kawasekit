/**
 * M1 — scripts/01-create-account.ts
 *
 * Creates a ZeroDev Kernel v3.1 smart account on Polygon Amoy (EntryPoint
 * v0.7, ECDSA validator) and sends a sponsored (gasless) self-transaction.
 *
 * Usage:
 *   1. cp .env.example .env   # fill in OWNER_PRIVATE_KEY + ZERODEV_PROJECT_ID
 *   2. pnpm m1:create-account
 *
 * This script lives in scripts/ (not src/), so console output is intentional.
 */

import "dotenv/config";

import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
	createKernelAccount,
	createKernelAccountClient,
	createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy, zerodevRpcUrl } from "../src";

/** Reads a required environment variable, throwing a clear error if absent. */
function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new Error(
			`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
		);
	}
	return value;
}

async function main(): Promise<void> {
	const rawKey = requireEnv("OWNER_PRIVATE_KEY");
	if (!/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
		throw new Error("OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
	}
	// Safe cast: validated above against the `0x` + 64-hex-char shape of `Hex`.
	const ownerPrivateKey = rawKey as Hex;
	const projectId = requireEnv("ZERODEV_PROJECT_ID");

	// ZeroDev v3 RPC serves as bundler, paymaster, and public-read endpoint.
	const rpcUrl = zerodevRpcUrl(polygonAmoy, projectId);

	const publicClient = createPublicClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});

	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;

	const signer = privateKeyToAccount(ownerPrivateKey);
	console.log("Owner (EOA) address:  ", signer.address);

	const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
		signer,
		entryPoint,
		kernelVersion,
	});

	const account = await createKernelAccount(publicClient, {
		plugins: { sudo: ecdsaValidator },
		entryPoint,
		kernelVersion,
	});
	console.log("Smart account address:", account.address);

	const paymasterClient = createZeroDevPaymasterClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});

	const kernelClient = createKernelAccountClient({
		account,
		chain: polygonAmoy,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	console.log("Sending sponsored user operation (self-transfer, 0 value)...");
	const userOpHash = await kernelClient.sendUserOperation({
		callData: await account.encodeCalls([{ to: account.address, value: 0n, data: "0x" }]),
	});
	console.log("userOp hash:          ", userOpHash);

	const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
	const txHash = receipt.receipt.transactionHash;
	console.log("Bundle txn hash:      ", txHash);
	console.log(`Polygonscan (Amoy):    https://amoy.polygonscan.com/tx/${txHash}`);
	console.log("Sponsored user operation completed ✅");
}

main().catch((error: unknown) => {
	console.error("M1 create-account script failed:");
	console.error(error);
	process.exitCode = 1;
});
