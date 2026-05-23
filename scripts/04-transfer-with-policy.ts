/**
 * M2-3 — scripts/04-transfer-with-policy.ts
 *
 * Builds a Kernel smart account with sudo (owner EOA) + a session-key
 * permission validator that enforces a JPYC daily limit, then attempts a
 * sponsored JPYC.transfer via the session key.
 *
 * Prerequisites (in addition to scripts/03):
 *   - SESSION_KEY_PRIVATE_KEY env var (separate EOA from OWNER_PRIVATE_KEY).
 *     Generate one with: `node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"`
 *
 * Optional env:
 *   - JPYC_RECIPIENT         Defaults to the smart account itself.
 *   - JPYC_AMOUNT_HUMAN      Decimal JPYC to send (default "1").
 *   - JPYC_MAX_PER_TX_HUMAN  Per-tx cap in decimal JPYC (default "100").
 *   - JPYC_MAX_PER_DAY       Tx-count cap per 24h window (default "10").
 *
 * This script lives in scripts/ (not src/), so console output is intentional.
 */

import "dotenv/config";

import { createKernelAccountClient, createZeroDevPaymasterClient } from "@zerodev/sdk";
import { type Address, createPublicClient, getAddress, type Hex, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	createAgentSmartAccount,
	createJpycDailyLimitPolicies,
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
		throw new Error(`Missing required environment variable: ${name}.`);
	}
	return value;
}

function optionalEnv(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value.trim() === "" ? undefined : value;
}

function asPrivateKey(name: string, value: string): Hex {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
		throw new Error(`${name} must be a 0x-prefixed 32-byte hex string.`);
	}
	return value as Hex;
}

async function main(): Promise<void> {
	const ownerKey = asPrivateKey("OWNER_PRIVATE_KEY", requireEnv("OWNER_PRIVATE_KEY"));
	const sessionKey = asPrivateKey("SESSION_KEY_PRIVATE_KEY", requireEnv("SESSION_KEY_PRIVATE_KEY"));
	const projectId = requireEnv("ZERODEV_PROJECT_ID");

	const rpcUrl = zerodevRpcUrl(polygonAmoy, projectId);
	const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });

	const owner = privateKeyToAccount(ownerKey);
	const session = privateKeyToAccount(sessionKey);

	const maxPerTxHuman = optionalEnv("JPYC_MAX_PER_TX_HUMAN") ?? "100";
	const maxPerDay = Number.parseInt(optionalEnv("JPYC_MAX_PER_DAY") ?? "10", 10);

	const jpycAddress = getJpycAddress(polygonAmoy.id);
	const policies = createJpycDailyLimitPolicies({
		jpycAddress,
		maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
		maxTransfersPerDay: maxPerDay,
	});

	const account = await createAgentSmartAccount({
		publicClient,
		ownerSigner: owner,
		sessionKeySigner: session,
		policies,
	});

	console.log("Owner (EOA):       ", owner.address);
	console.log("Session key (EOA): ", session.address);
	console.log("Smart account:     ", account.address);
	console.log("Policy (per tx):   ", maxPerTxHuman, "JPYC");
	console.log("Policy (per day):  ", maxPerDay, "transfers");

	const balance = (await publicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [account.address],
	})) as bigint;
	console.log("Smart-account JPYC:", balance.toString(), "wei");

	if (balance === 0n) {
		console.error(
			"\n❌ Smart account has 0 JPYC on Polygon Amoy. Fund this address before retrying:",
		);
		console.error(`   ${account.address}`);
		process.exitCode = 1;
		return;
	}

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

	const recipientRaw = optionalEnv("JPYC_RECIPIENT") ?? account.address;
	const recipient: Address = getAddress(recipientRaw);
	const amountHuman = optionalEnv("JPYC_AMOUNT_HUMAN") ?? "1";
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

	console.log(`\nSending ${amountHuman} JPYC to ${recipient} via session key (policy-enforced)...`);
	const result = await transferJpyc(kernelClient, { to: recipient, amount });
	console.log("userOp hash:       ", result.userOpHash);
	console.log("Bundle txn hash:   ", result.transactionHash);
	console.log(
		`Polygonscan (Amoy): https://amoy.polygonscan.com/tx/${result.transactionHash ?? ""}`,
	);
	console.log(
		result.success ? "Policy-enforced JPYC transfer completed ✅" : "UserOp reported failure ❌",
	);
}

main().catch((error: unknown) => {
	console.error("M2 transfer-with-policy script failed:");
	console.error(error);
	process.exitCode = 1;
});
