/**
 * Test A — Empirically verify that JPYC v2's `transferWithAuthorization`
 * cannot accept a smart-account `from`.
 *
 * Strategy:
 *   1. Owner EOA signs an EIP-712 `TransferWithAuthorization` message
 *      whose `from` field is the SMART ACCOUNT address (not the EOA's
 *      own address). We sidestep kawasekit's `signTransferWithAuthorization`
 *      guard rail by calling `account.signTypedData()` directly.
 *   2. Owner EOA submits `JPYC.transferWithAuthorization(...)` on Polygon
 *      Amoy. We bypass viem's preflight simulation by calling
 *      `sendTransaction` with manually-encoded calldata so the tx lands
 *      on-chain even though it will revert.
 *   3. JPYC's `_recover()` returns the owner EOA address (ecrecover output).
 *      The `require(recovered == from)` check then fails because
 *      `owner_EOA != smart_account` → revert with `EIP3009: invalid signature`.
 *
 * Expected outcome: Polygonscan shows a tx with status=Reverted and the
 * decoded revert reason `EIP3009: invalid signature`.
 *
 * Prerequisites:
 *   - Smart account holds any non-zero JPYC balance (nothing actually
 *     moves — the tx reverts before `_transfer`).
 *   - Owner EOA holds POL on Polygon Amoy (gets it from
 *     https://faucet.polygon.technology/).
 *
 * Run:
 *   pnpm m2:verify-eip3009-rejects-smart-account
 */

import "dotenv/config";

import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import {
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	formatUnits,
	type Hex,
	http,
	parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	authorizationDeadlineFromNow,
	generateAuthorizationNonce,
	getJpycAddress,
	JPYC_DECIMALS,
	JPYC_EIP712_DOMAIN_HINT,
	jpycAbi,
	polygonAmoy,
	zerodevRpcUrl,
} from "../src";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new Error(`Missing env var: ${name}`);
	}
	return value;
}

async function main(): Promise<void> {
	const ownerKey = requireEnv("OWNER_PRIVATE_KEY");
	if (!/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) {
		throw new Error("OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
	}
	const projectId = requireEnv("ZERODEV_PROJECT_ID");

	const rpcUrl = zerodevRpcUrl(polygonAmoy, projectId);
	const publicClient = createPublicClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
	});
	const owner = privateKeyToAccount(ownerKey as Hex);

	// Derive the same smart account as M1 (sudo-only ECDSA validator).
	const entryPoint = getEntryPoint("0.7");
	const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
		signer: owner,
		entryPoint,
		kernelVersion: KERNEL_V3_1,
	});
	const account = await createKernelAccount(publicClient, {
		plugins: { sudo: ecdsaValidator },
		entryPoint,
		kernelVersion: KERNEL_V3_1,
	});

	const jpyc = getJpycAddress(polygonAmoy.id);
	console.log("Owner (EOA):       ", owner.address);
	console.log("Smart account:     ", account.address);
	console.log("JPYC contract:     ", jpyc);

	const [saBalance, polBalance] = await Promise.all([
		publicClient.readContract({
			address: jpyc,
			abi: jpycAbi,
			functionName: "balanceOf",
			args: [account.address],
		}) as Promise<bigint>,
		publicClient.getBalance({ address: owner.address }),
	]);
	console.log("Smart-account JPYC:", formatUnits(saBalance, JPYC_DECIMALS), "JPYC");
	console.log("Owner EOA POL:     ", formatUnits(polBalance, 18), "POL");

	if (saBalance === 0n) {
		console.error(
			`\n❌ Smart account has 0 JPYC. Fund ${account.address} on Polygon Amoy and retry.`,
		);
		process.exitCode = 1;
		return;
	}
	if (polBalance === 0n) {
		console.error(
			`\n❌ Owner EOA has 0 POL on Amoy. Get some from https://faucet.polygon.technology/ for ${owner.address} and retry.`,
		);
		process.exitCode = 1;
		return;
	}

	// Construct an EIP-712 TransferWithAuthorization message whose `from`
	// is the smart account — this is the "lie" we want to test.
	const message = {
		from: account.address, // ← contract address, never recoverable via ecrecover
		to: owner.address, // arbitrary; tx reverts before any transfer
		value: parseUnits("0.1", JPYC_DECIMALS),
		validAfter: 0n,
		validBefore: authorizationDeadlineFromNow(600),
		nonce: generateAuthorizationNonce(),
	} as const;

	const domain = {
		...JPYC_EIP712_DOMAIN_HINT, // name: "JPY Coin", version: "1"
		chainId: polygonAmoy.id,
		verifyingContract: jpyc,
	};

	console.log("\n--- Off-chain signing ---");
	console.log("Claim:    from =", message.from, "(smart account)");
	console.log("Reality:  signer =", owner.address, "(owner EOA)");
	console.log("→ ecrecover will recover the owner EOA, not the smart account.");

	// Sign directly with viem — bypass kawasekit's signTransferWithAuthorization
	// guard that would refuse to sign with from != signer.
	if (!owner.signTypedData) {
		throw new Error("Owner LocalAccount cannot signTypedData (unexpected).");
	}
	const signature = await owner.signTypedData({
		domain,
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
		message,
	});
	const r = `0x${signature.slice(2, 66)}` as Hex;
	const s = `0x${signature.slice(66, 130)}` as Hex;
	const v = Number.parseInt(signature.slice(130, 132), 16);
	console.log("Signature (v, r, s):", v, r, s);

	// Encode the call and submit via raw sendTransaction so viem's
	// writeContract simulation doesn't preempt the revert.
	const data = encodeFunctionData({
		abi: jpycAbi,
		functionName: "transferWithAuthorization",
		args: [
			message.from,
			message.to,
			message.value,
			message.validAfter,
			message.validBefore,
			message.nonce,
			v,
			r,
			s,
		],
	});

	const walletClient = createWalletClient({
		chain: polygonAmoy,
		transport: http(rpcUrl),
		account: owner,
	});

	console.log("\n--- On-chain submission (expecting revert) ---");
	const hash = await walletClient.sendTransaction({
		to: jpyc,
		data,
		value: 0n,
		// Hand-set gas so we don't burn an estimate-gas RPC round trip.
		gas: 150_000n,
	});
	console.log("Tx submitted:", hash);
	console.log("Polygonscan: ", `https://amoy.polygonscan.com/tx/${hash}`);
	console.log("Waiting for receipt...");

	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	console.log("Tx status:", receipt.status);
	console.log("Gas used: ", receipt.gasUsed.toString());

	if (receipt.status === "reverted") {
		console.log(
			"\n✅ Confirmed empirically: JPYC's transferWithAuthorization rejects a smart-account `from`.",
		);
		console.log("   Decode the revert reason on Polygonscan to see `EIP3009: invalid signature`.");
	} else {
		console.error("\n❌ Unexpected: tx succeeded. The article's claim is incorrect.");
		process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error("Verification script failed:");
	console.error(error);
	process.exitCode = 1;
});
