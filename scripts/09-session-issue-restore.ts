/**
 * M3-2 — scripts/09-session-issue-restore.ts
 *
 * Polygon Amoy E2E for the session-key lifecycle issue → serialize → parse →
 * restore round-trip:
 *
 *   1. Owner builds the agent smart account + issues a KawasekitSessionEnvelope.
 *   2. We `serializeSessionEnvelope` → JSON string, then `parseSessionEnvelope`
 *      it back — simulating offline distribution (e.g. write to disk, ship to
 *      an agent on another machine).
 *   3. A **fresh** PublicClient (a different object than the one issuing used)
 *      `restoreSessionAccount`s the envelope.
 *   4. The restored account sends one sponsored JPYC.transfer userOp via the
 *      session-key validator.
 *
 * Required env (same as scripts/04):
 *   - OWNER_PRIVATE_KEY
 *   - SESSION_KEY_PRIVATE_KEY
 *   - ZERODEV_PROJECT_ID
 *
 * Optional env:
 *   - JPYC_RECIPIENT         Defaults to the smart account itself.
 *   - JPYC_AMOUNT_HUMAN      Decimal JPYC to send (default "0.01").
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
	createJpycDailyLimitPolicies,
	getJpycAddress,
	issueSessionKey,
	JPYC_DECIMALS,
	jpycAbi,
	parseSessionEnvelope,
	polygonAmoy,
	restoreSessionAccount,
	serializeSessionEnvelope,
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

	console.log("=== M3-2 session issue → restore E2E on Polygon Amoy ===\n");
	console.log("Owner (EOA):           ", owner.address);
	console.log("Session key (EOA):     ", session.address);
	console.log("Policy max per tx:     ", maxPerTxHuman, "JPYC");
	console.log("Policy max per day:    ", maxPerDay, "transfers");
	console.log("Transfer amount:       ", amountHuman, "JPYC =", amount.toString(), "wei");

	// --- Owner side: issue ---
	const ownerPublicClient = createPublicClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});
	const envelope = await issueSessionKey({
		publicClient: ownerPublicClient,
		ownerSigner: owner,
		sessionKeySigner: session,
		policies,
		policySummary: {
			jpycAddress,
			maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
			maxTransfersPerDay: maxPerDay,
		},
	});
	console.log("Smart account:         ", envelope.smartAccountAddress);
	console.log("Envelope chainId:      ", envelope.chainId);
	console.log("Envelope version:      ", envelope.kawasekitVersion);

	// --- Offline distribution simulation ---
	const wire = serializeSessionEnvelope(envelope);
	console.log("Envelope wire size:    ", wire.length, "chars");
	const restored = parseSessionEnvelope(wire);

	// --- Agent side: restore (fresh PublicClient, mimicking a separate process) ---
	const agentPublicClient = createPublicClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});
	const restoredAccount = await restoreSessionAccount({
		publicClient: agentPublicClient,
		envelope: restored,
		sessionKeySigner: session,
	});
	console.log("Restored account:      ", restoredAccount.address);
	if (getAddress(restoredAccount.address) !== getAddress(envelope.smartAccountAddress)) {
		console.error("\n❌ Restored address does not match issued envelope smart-account address.");
		process.exitCode = 1;
		return;
	}

	// --- Pre-flight: smart account JPYC balance ---
	const balance = (await agentPublicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [restoredAccount.address],
	})) as bigint;
	console.log("Smart-account JPYC:    ", balance.toString(), "wei");
	if (balance < amount) {
		console.error(
			`\n❌ Smart account has insufficient JPYC. Need ${amount}, has ${balance}. Fund this address:`,
		);
		console.error(`   ${restoredAccount.address}`);
		console.error(`   Polygon Amoy JPYC faucet: https://faucet.jpyc.co.jp/`);
		process.exitCode = 1;
		return;
	}

	// --- Build session-scoped kernel client from the restored account ---
	const paymasterClient = createZeroDevPaymasterClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});
	const sessionKernelClient = createKernelAccountClient({
		account: restoredAccount,
		chain: polygonAmoy,
		client: agentPublicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	const recipientRaw = optionalEnv("JPYC_RECIPIENT") ?? restoredAccount.address;
	const recipient: Address = getAddress(recipientRaw);

	console.log(`\nSending ${amountHuman} JPYC via the restored session key...`);
	const result = await transferJpyc(sessionKernelClient, { to: recipient, amount });
	console.log("userOp hash:           ", result.userOpHash);
	console.log("Bundle txn hash:       ", result.transactionHash);
	console.log(
		"Polygonscan (Amoy):    ",
		`https://amoy.polygonscan.com/tx/${result.transactionHash ?? ""}`,
	);

	if (result.success) {
		console.log("\n✅ Session restored end-to-end and one policy-enforced transfer landed.");
	} else {
		console.error("\n❌ UserOp reported failure — see Polygonscan for revert reason.");
		process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error("\nM3-2 session-issue-restore script failed:");
	console.error(error);
	process.exitCode = 1;
});
