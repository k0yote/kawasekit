/**
 * Test D — Demonstrate that the Daily Limit policy rejects an over-cap
 * `JPYC.transfer()` at the ERC-4337 validation phase, before the bundler
 * ever lands a tx on-chain.
 *
 * Strategy:
 *   1. Build the agent smart account with the SAME policy that scripts/04
 *      uses (so the session key + permission validator state matches
 *      whatever was installed by scripts/04's prior run).
 *   2. Attempt to send an amount that exceeds `maxPerTransfer`. The
 *      bundler simulates the userOp; the call policy's `LESS_THAN_OR_EQUAL`
 *      constraint on `value` fails; the bundler refuses to submit.
 *   3. Capture and print the bundler error.
 *
 * Expected outcome: `transferJpyc` throws a UserOperationExecutionError
 * (or similar) whose message references the policy violation. No tx is
 * mined on-chain, but the smart account's balance is unchanged — the
 * proof is that sponsored gas was not consumed for an invalid send.
 *
 * Prerequisites:
 *   - Smart account holds JPYC (≥ amount tried; not strictly required
 *     since the bundler rejects pre-flight, but having balance keeps the
 *     test honest by ruling out the "no balance" branch).
 *   - Same SESSION_KEY_PRIVATE_KEY used by scripts/04 so the regular
 *     permission validator state matches what scripts/04 lazily enabled.
 *
 * Run:
 *   pnpm m2:policy-violation
 */

import "dotenv/config";

import { createKernelAccountClient, createZeroDevPaymasterClient } from "@zerodev/sdk";
import {
	type Address,
	createPublicClient,
	formatUnits,
	getAddress,
	type Hex,
	http,
	parseUnits,
} from "viem";
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
		throw new Error(`Missing env var: ${name}`);
	}
	return value;
}

function asPrivateKey(name: string, value: string): Hex {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
		throw new Error(`${name} must be a 0x-prefixed 32-byte hex string.`);
	}
	return value as Hex;
}

function optionalEnv(name: string): string | undefined {
	const v = process.env[name];
	return v === undefined || v.trim() === "" ? undefined : v;
}

async function main(): Promise<void> {
	const ownerKey = asPrivateKey("OWNER_PRIVATE_KEY", requireEnv("OWNER_PRIVATE_KEY"));
	const sessionKey = asPrivateKey("SESSION_KEY_PRIVATE_KEY", requireEnv("SESSION_KEY_PRIVATE_KEY"));
	const projectId = requireEnv("ZERODEV_PROJECT_ID");

	const rpcUrl = zerodevRpcUrl(polygonAmoy, projectId);
	const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });

	const owner = privateKeyToAccount(ownerKey);
	const session = privateKeyToAccount(sessionKey);

	// Match scripts/04 defaults so the validator install fingerprint is identical.
	const maxPerTxHuman = optionalEnv("JPYC_MAX_PER_TX_HUMAN") ?? "10";
	const maxPerDay = Number.parseInt(optionalEnv("JPYC_MAX_PER_DAY") ?? "10", 10);

	const jpyc = getJpycAddress(polygonAmoy.id);
	const policies = createJpycDailyLimitPolicies({
		jpycAddress: jpyc,
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
	console.log(`Policy: maxPerTransfer = ${maxPerTxHuman} JPYC, maxPerDay = ${maxPerDay}`);

	const balance = (await publicClient.readContract({
		address: jpyc,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [account.address],
	})) as bigint;
	console.log("Smart-account JPYC:", formatUnits(balance, JPYC_DECIMALS), "JPYC");

	if (balance === 0n) {
		console.error(`\n❌ Smart account has 0 JPYC. Fund ${account.address} and retry.`);
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

	// Try to send 10x the per-tx cap.
	const overCapAmount = parseUnits(maxPerTxHuman, JPYC_DECIMALS) * 10n;
	const recipientRaw = optionalEnv("JPYC_RECIPIENT") ?? account.address;
	const recipient: Address = getAddress(recipientRaw);

	console.log(
		`\nAttempting to send ${formatUnits(overCapAmount, JPYC_DECIMALS)} JPYC (10× the cap of ${maxPerTxHuman} JPYC)...`,
	);
	console.log("Expecting bundler simulation to reject this userOp.");

	try {
		const result = await transferJpyc(kernelClient, { to: recipient, amount: overCapAmount });
		console.error("\n❌ Unexpected: bundler accepted the over-cap transfer.");
		console.error("   userOp hash:", result.userOpHash);
		console.error("   tx hash:    ", result.transactionHash);
		console.error("   Policy did NOT enforce the limit. Re-examine.");
		process.exitCode = 1;
		return;
	} catch (error) {
		console.log("\n✅ Bundler rejected the userOp at validation phase:");
		if (error instanceof Error) {
			console.log("---");
			console.log(error.message);
			console.log("---");
			if (error.cause) {
				console.log("Cause:", error.cause);
			}
		} else {
			console.log(error);
		}

		// Sanity-check: balance is unchanged
		const balanceAfter = (await publicClient.readContract({
			address: jpyc,
			abi: jpycAbi,
			functionName: "balanceOf",
			args: [account.address],
		})) as bigint;
		console.log("\nSmart-account JPYC after:", formatUnits(balanceAfter, JPYC_DECIMALS), "JPYC");
		if (balanceAfter === balance) {
			console.log("✅ Balance unchanged — no funds moved.");
		} else {
			console.error("❌ Balance changed unexpectedly. Investigate.");
			process.exitCode = 1;
		}
	}
}

main().catch((error: unknown) => {
	console.error("Policy-violation script failed:");
	console.error(error);
	process.exitCode = 1;
});
