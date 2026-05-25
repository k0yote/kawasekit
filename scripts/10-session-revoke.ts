/**
 * M3-2 — scripts/10-session-revoke.ts
 *
 * Polygon Amoy E2E for `revokeSessionKey`:
 *
 *   1. Owner issues + restores a session key (same setup as scripts/09).
 *   2. One successful sponsored transfer via the session key (proves the
 *      session is live).
 *   3. Owner sudo Kernel client uninstalls the session-key permission
 *      validator via `revokeSessionKey`.
 *   4. A second transfer attempt via the (now-revoked) session key is expected
 *      to revert at the AA validation phase. The script asserts the failure.
 *
 * Required env: same as scripts/09 (OWNER_PRIVATE_KEY, SESSION_KEY_PRIVATE_KEY,
 * ZERODEV_PROJECT_ID).
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
	issueSessionKey,
	JPYC_DECIMALS,
	jpycAbi,
	polygonAmoy,
	restoreSessionAccount,
	revokeSessionKey,
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
	const owner = privateKeyToAccount(ownerKey);
	const session = privateKeyToAccount(sessionKey);

	const maxPerTxHuman = optionalEnv("JPYC_MAX_PER_TX_HUMAN") ?? "100";
	const maxPerDay = Number.parseInt(optionalEnv("JPYC_MAX_PER_DAY") ?? "10", 10);
	const amountHuman = optionalEnv("JPYC_AMOUNT_HUMAN") ?? "0.01";
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

	const jpycAddress = getJpycAddress(polygonAmoy.id);
	const policies = createJpycDailyLimitPolicies({
		jpycAddress,
		maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
		maxTransfersPerDay: maxPerDay,
	});

	const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });

	console.log("=== M3-2 session-revoke E2E on Polygon Amoy ===\n");
	console.log("Owner (EOA):           ", owner.address);
	console.log("Session key (EOA):     ", session.address);

	// --- Owner side: build smart account + issue ---
	const envelope = await issueSessionKey({
		publicClient,
		ownerSigner: owner,
		sessionKeySigner: session,
		policies,
	});
	console.log("Smart account:         ", envelope.smartAccountAddress);

	// --- Build the owner-sudo kernel client (sudo only — no regular plugin) ---
	const ownerSudoAccount = await createAgentSmartAccount({
		publicClient,
		ownerSigner: owner,
		sessionKeySigner: session,
		policies,
	});
	const paymasterClient = createZeroDevPaymasterClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});
	const ownerKernelClient = createKernelAccountClient({
		account: ownerSudoAccount,
		chain: polygonAmoy,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	// --- Agent side: restore + session kernel client ---
	const restoredAccount = await restoreSessionAccount({
		publicClient,
		envelope,
		sessionKeySigner: session,
	});
	const sessionKernelClient = createKernelAccountClient({
		account: restoredAccount,
		chain: polygonAmoy,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	// --- Pre-flight balance ---
	const balance = (await publicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [restoredAccount.address],
	})) as bigint;
	console.log("Smart-account JPYC:    ", balance.toString(), "wei");
	if (balance < amount * 2n) {
		console.error(
			`\n❌ Smart account needs at least ${amount * 2n} wei JPYC (two transfers). Fund this address:`,
		);
		console.error(`   ${restoredAccount.address}`);
		process.exitCode = 1;
		return;
	}

	const recipientRaw = optionalEnv("JPYC_RECIPIENT") ?? restoredAccount.address;
	const recipient: Address = getAddress(recipientRaw);

	// --- 1. Pre-revoke transfer (should succeed) ---
	console.log(`\n[1/3] Pre-revoke transfer of ${amountHuman} JPYC via session key...`);
	const before = await transferJpyc(sessionKernelClient, { to: recipient, amount });
	console.log("      userOp hash:     ", before.userOpHash);
	console.log("      bundle tx hash:  ", before.transactionHash);
	console.log(
		"      Polygonscan:     ",
		`https://amoy.polygonscan.com/tx/${before.transactionHash ?? ""}`,
	);
	if (!before.success) {
		console.error("\n❌ Pre-revoke transfer reported failure — cannot continue.");
		process.exitCode = 1;
		return;
	}

	// --- 2. Owner revokes the session ---
	console.log("\n[2/3] Owner revoking the session key (uninstallValidation)...");
	const revoke = await revokeSessionKey({
		ownerKernelClient,
		envelope,
		sessionKeySigner: session,
		policies,
	});
	console.log("      userOp hash:     ", revoke.userOpHash);
	console.log("      bundle tx hash:  ", revoke.transactionHash);
	console.log(
		"      Polygonscan:     ",
		`https://amoy.polygonscan.com/tx/${revoke.transactionHash ?? ""}`,
	);
	if (!revoke.success) {
		console.error("\n❌ Revoke UserOp reported failure.");
		process.exitCode = 1;
		return;
	}

	// --- 3. Post-revoke transfer (expected to revert at validation phase) ---
	console.log(`\n[3/3] Post-revoke transfer attempt (expected to FAIL)...`);
	try {
		const after = await transferJpyc(sessionKernelClient, { to: recipient, amount });
		console.error("\n❌ Post-revoke transfer unexpectedly succeeded:");
		console.error("      userOp hash:    ", after.userOpHash);
		console.error("      tx hash:        ", after.transactionHash);
		process.exitCode = 1;
		return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log("      reverted as expected:", message.slice(0, 200));
		console.log("\n✅ Session revoke E2E: pre-revoke success + post-revoke rejection confirmed.");
	}
}

main().catch((error: unknown) => {
	console.error("\nM3-2 session-revoke script failed:");
	console.error(error);
	process.exitCode = 1;
});
