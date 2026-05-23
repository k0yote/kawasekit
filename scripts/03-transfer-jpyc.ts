/**
 * M2-2 — scripts/03-transfer-jpyc.ts
 *
 * Sends `JPYC.transfer()` from a Kernel smart account on Polygon Amoy via a
 * sponsored UserOp. This is the agent payment path that M2-2 unlocks.
 *
 * Prerequisites:
 *   1. M1 done — the smart account address is known (run `pnpm m1:create-account`).
 *   2. The smart account holds JPYC on Amoy. JPYC on Amoy is mint-controlled,
 *      so you must obtain it from JPYC Inc. via Discord / direct contact —
 *      there is no public faucet today.
 *   3. .env populated with OWNER_PRIVATE_KEY + ZERODEV_PROJECT_ID.
 *
 * Optional env:
 *   - JPYC_RECIPIENT     Defaults to the smart account itself (loop-back).
 *   - JPYC_AMOUNT_HUMAN  Decimal JPYC to send (default "1").
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
import { type Address, createPublicClient, getAddress, type Hex, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	getJpycAddress,
	JPYC_DECIMALS,
	jpycAbi,
	polygonAmoy,
	transferJpyc,
	zerodevRpcUrl,
} from "../src";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new Error(
			`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
		);
	}
	return value;
}

function optionalEnv(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value.trim() === "" ? undefined : value;
}

async function main(): Promise<void> {
	const rawKey = requireEnv("OWNER_PRIVATE_KEY");
	if (!/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
		throw new Error("OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
	}
	const ownerPrivateKey = rawKey as Hex;
	const projectId = requireEnv("ZERODEV_PROJECT_ID");

	const rpcUrl = zerodevRpcUrl(polygonAmoy, projectId);
	const publicClient = createPublicClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});

	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;
	const signer = privateKeyToAccount(ownerPrivateKey);
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

	console.log("Owner (EOA):       ", signer.address);
	console.log("Smart account:     ", account.address);

	const jpycAddress = getJpycAddress(polygonAmoy.id);
	const balance = (await publicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [account.address],
	})) as bigint;
	console.log("JPYC contract:     ", jpycAddress);
	console.log("Smart-account JPYC:", balance.toString(), "wei");

	if (balance === 0n) {
		console.error(
			"\n❌ Smart account has 0 JPYC on Polygon Amoy. JPYC on Amoy is mint-controlled — request a small testnet allocation from JPYC Inc. (Discord) or fund this address before retrying:",
		);
		console.error(`   ${account.address}`);
		process.exitCode = 1;
		return;
	}

	const recipientRaw = optionalEnv("JPYC_RECIPIENT") ?? account.address;
	const recipient: Address = getAddress(recipientRaw);
	const amountHuman = optionalEnv("JPYC_AMOUNT_HUMAN") ?? "1";
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);
	if (amount > balance) {
		console.error(
			`\n❌ Requested ${amountHuman} JPYC exceeds smart-account balance (${balance} wei).`,
		);
		process.exitCode = 1;
		return;
	}

	console.log(`\nSending ${amountHuman} JPYC to ${recipient} via sponsored UserOp...`);
	const result = await transferJpyc(kernelClient, { to: recipient, amount });
	console.log("userOp hash:       ", result.userOpHash);
	console.log("Bundle txn hash:   ", result.transactionHash);
	console.log(
		`Polygonscan (Amoy): https://amoy.polygonscan.com/tx/${result.transactionHash ?? ""}`,
	);
	console.log(
		result.success ? "Sponsored JPYC transfer completed ✅" : "UserOp reported failure ❌",
	);
}

main().catch((error: unknown) => {
	console.error("M2 transfer-jpyc script failed:");
	console.error(error);
	process.exitCode = 1;
});
