/**
 * 0.11.0 — scripts/15-settlement-pay.ts
 *
 * Polygon Amoy E2E for a Settlement payment, and the steady-state gas comparison the design's
 * spike could not give (its figures included account deployment and validator enablement):
 *
 *   1. The owner issues a buy-list session key scoped by `createBuyListPolicies` — the key may call
 *      `JPYC.approve(Settlement)` and `Settlement.pay`, and nothing else.
 *   2. The restored session account pays TWO orders with `settleOrder`. The first carries the
 *      one-time cost of enabling the key's validator; the second is the steady state.
 *   3. The first order is paid AGAIN. The contract must refuse it (`AlreadySettled`); the script
 *      then reads `settled(ref)`, which is how a caller is meant to resolve a failed payment.
 *   4. Both `Settled` events are found by their indexed `ref` alone.
 *   5. The baseline: a second key, scoped the way a buy-list key was scoped until 0.10.x — a plain
 *      `JPYC.transfer` to the same merchant under the same cap — sends two transfers; again the
 *      second is the steady state. Same signer kind, same sponsor, same account: the comparison is
 *      "yesterday's payment against today's". It uses the deprecated
 *      `createLegacyTransferBuyListPolicies` on purpose: that IS the scope being replaced, and
 *      unlike `createJpycDailyLimitPolicies` it carries no rate-limit policy, so two back-to-back
 *      transfers cannot trip a "not due yet" refusal that has nothing to do with gas.
 *
 * Four payments of `JPYC_AMOUNT_HUMAN` land; nothing else moves. Test JPYC has no value and may not
 * be used as consideration for real goods or services (JPYC terms art. 17-2) — the "merchant" here
 * is an address of yours.
 *
 * Both session keys are generated in-process, never stored, and expire after one hour.
 *
 * Required env (as scripts/04 and /09):
 *   - OWNER_PRIVATE_KEY
 *   - ZERODEV_PROJECT_ID     a project that sponsors on Amoy with NO custom gas-policy webhook
 *
 * Optional env:
 *   - SETTLEMENT_MERCHANT    Recipient of the payments. Defaults to the owner EOA, so the JPYC
 *                            comes back to you.
 *   - JPYC_AMOUNT_HUMAN      Decimal JPYC per payment (default "1").
 *
 * This script lives in scripts/ (not src/), so console output is intentional. It never prints the
 * ZeroDev RPC URL: the project id in it is a sponsorship credential.
 */

import "dotenv/config";

import {
	type Address,
	createPublicClient,
	getAddress,
	type Hex,
	http,
	keccak256,
	parseUnits,
	stringToHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
	type ConfiguredKernelClient,
	createBuyListPolicies,
	createLegacyTransferBuyListPolicies,
	createSponsoredKernelClient,
	getJpycAddress,
	getSettlementAddress,
	hashOrderDetails,
	issueSessionKey,
	JPYC_DECIMALS,
	jpycAbi,
	polygonAmoy,
	restoreSessionAccount,
	settlementAbi,
	settleOrder,
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
	return value as Hex; // validated just above: 0x + 64 hex chars
}

/** Never let the RPC URL — and with it the project id — reach the terminal. */
function scrub(text: string, secret: string): string {
	return text
		.split(secret)
		.join("<zerodev-rpc>")
		.replace(/https?:\/\/[^\s"'`]*zerodev\.app[^\s"'`]*/gi, "<zerodev-rpc>");
}

interface Measured {
	readonly label: string;
	readonly gasUsed: bigint;
	readonly transactionHash: Hex;
}

async function main(): Promise<void> {
	const ownerKey = asPrivateKey("OWNER_PRIVATE_KEY", requireEnv("OWNER_PRIVATE_KEY"));
	const rpcUrl = zerodevRpcUrl(polygonAmoy, requireEnv("ZERODEV_PROJECT_ID"));
	const owner = privateKeyToAccount(ownerKey);

	const amountHuman = optionalEnv("JPYC_AMOUNT_HUMAN") ?? "1";
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);
	const merchant: Address = getAddress(optionalEnv("SETTLEMENT_MERCHANT") ?? owner.address);

	const jpycAddress = getJpycAddress(polygonAmoy.id);
	const settlementAddress = getSettlementAddress(polygonAmoy.id);
	const validUntil = Math.floor(Date.now() / 1000) + 3600;
	const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });

	console.log("=== 0.11.0 Settlement payment E2E on Polygon Amoy ===\n");
	console.log("Owner (EOA):        ", owner.address);
	console.log("Settlement:         ", settlementAddress);
	console.log("Merchant:           ", merchant);
	console.log("Amount per payment: ", amountHuman, "JPYC");

	/** Issue a throwaway key under `policies`, restore it, and hand back a sponsored client. */
	async function sessionClient(
		policies: Parameters<typeof issueSessionKey>[0]["policies"],
	): Promise<ConfiguredKernelClient> {
		const sessionKeySigner = privateKeyToAccount(generatePrivateKey());
		const envelope = await issueSessionKey({
			publicClient,
			ownerSigner: owner,
			sessionKeySigner,
			policies,
		});
		const account = await restoreSessionAccount({ publicClient, envelope, sessionKeySigner });
		return createSponsoredKernelClient({
			account,
			chain: polygonAmoy,
			zerodevRpc: rpcUrl,
			publicClient,
		});
	}

	const settlementClient = await sessionClient(
		createBuyListPolicies({
			jpycAddress,
			settlementAddress,
			merchants: [merchant],
			maxPerTransfer: amount,
			validUntil,
		}),
	);
	const account = settlementClient.account.address;
	console.log("Smart account:      ", account);

	const balance = await publicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [account],
	});
	const needed = 4n * amount;
	console.log("Smart-account JPYC: ", balance.toString(), "wei");
	if (balance < needed) {
		console.error(`\n❌ Insufficient JPYC: need ${needed} (4 payments), have ${balance}. Fund:`);
		console.error(`   ${account}`);
		console.error("   Polygon Amoy JPYC faucet: https://faucet.jpyc.co.jp/");
		process.exitCode = 1;
		return;
	}

	async function gasOf(client: ConfiguredKernelClient, userOpHash: Hex): Promise<bigint> {
		const receipt = await client.getUserOperationReceipt({ hash: userOpHash });
		return receipt.actualGasUsed;
	}

	let orderCount = 0;
	function newOrder() {
		orderCount += 1;
		const seed = `${Date.now()}-${orderCount}`;
		return {
			merchant,
			amount,
			validUntil: BigInt(Math.floor(Date.now() / 1000) + 900),
			details: hashOrderDetails({
				orderId: `script15-${seed}`,
				lines: [{ itemId: "script15-item", unitPrice: amount, quantity: 1 }],
				salt: keccak256(stringToHex(`script15-salt-${seed}`)),
			}),
		};
	}

	const measured: Measured[] = [];

	// --- 2. two Settlement payments with ONE key ---
	const firstOrder = newOrder();
	const refs: Hex[] = [];
	for (const [label, order] of [
		["settlement #1 (enables the key)", firstOrder],
		["settlement #2 (steady state)", newOrder()],
	] as const) {
		console.log(`\n${label} …`);
		const result = await settleOrder(settlementClient, order);
		if (result.transactionHash === null || result.success !== true) {
			throw new Error(`${label}: the UserOp did not land`);
		}
		refs.push(result.ref);
		measured.push({
			label,
			gasUsed: await gasOf(settlementClient, result.userOpHash),
			transactionHash: result.transactionHash,
		});
		console.log("  ref:  ", result.ref);
		console.log("  tx:   ", `https://amoy.polygonscan.com/tx/${result.transactionHash}`);
	}

	// --- 3. paying the first order again must be refused ---
	console.log("\nretrying order #1 — the contract must refuse it …");
	let refused = false;
	try {
		const retry = await settleOrder(settlementClient, firstOrder);
		refused = retry.success !== true;
	} catch (error) {
		refused = true;
		const text = scrub(error instanceof Error ? error.message : String(error), rpcUrl);
		const reason = /0xb196a44a/.test(text) ? "AlreadySettled (0xb196a44a)" : "see message";
		console.log("  refused:", reason);
	}
	const firstRef = refs[0];
	if (firstRef === undefined) throw new Error("unreachable: no ref recorded for order #1");
	const stillSettled = await publicClient.readContract({
		address: settlementAddress,
		abi: settlementAbi,
		functionName: "settled",
		args: [firstRef],
	});
	console.log("  settled(ref) reads:", stillSettled);

	// --- 4. both payments are findable by ref alone ---
	const latest = await publicClient.getBlockNumber();
	let found = 0;
	for (const ref of refs) {
		const logs = await publicClient.getContractEvents({
			address: settlementAddress,
			abi: settlementAbi,
			eventName: "Settled",
			args: { ref },
			fromBlock: latest - 2_000n,
			toBlock: latest,
		});
		found += logs.length;
	}
	console.log(`\nSettled events found by ref: ${found} of ${refs.length}`);

	// --- 5. the baseline: the same payments as plain transfers, under a transfer-scoped key ---
	const transferClient = await sessionClient(
		createLegacyTransferBuyListPolicies({
			jpycAddress,
			merchants: [merchant],
			maxPerTransfer: amount,
			validUntil,
		}),
	);
	for (const label of ["transfer #1 (enables the key)", "transfer #2 (steady state)"]) {
		console.log(`\n${label} …`);
		const result = await transferJpyc(transferClient, { to: merchant, amount });
		if (result.transactionHash === null || result.success !== true) {
			throw new Error(`${label}: the UserOp did not land`);
		}
		measured.push({
			label,
			gasUsed: await gasOf(transferClient, result.userOpHash),
			transactionHash: result.transactionHash,
		});
		console.log("  tx:   ", `https://amoy.polygonscan.com/tx/${result.transactionHash}`);
	}

	// --- result ---
	console.log("\n--- actualGasUsed per UserOp ---");
	for (const m of measured) console.log(`  ${m.label.padEnd(34)} ${m.gasUsed}`);
	const settle = measured[1]?.gasUsed;
	const transfer = measured[3]?.gasUsed;
	if (settle !== undefined && transfer !== undefined && transfer > 0n) {
		const percent = Number((settle * 1000n) / transfer) / 10;
		console.log(
			`\n  steady state: a Settlement payment costs ${percent}% of a plain transfer's gas`,
		);
		console.log(`  (+${settle - transfer} gas for the approval and the order reference)`);
	}

	const ok = refused && stillSettled && found === refs.length;
	if (ok) {
		console.log(
			"\n✅ Two payments landed with one key, the retry was refused, both are findable by ref.",
		);
	} else {
		console.error("\n❌ Something did not hold:", { refused, stillSettled, found });
		process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error("\n0.11.0 settlement-pay script failed:");
	const rpc = process.env["ZERODEV_PROJECT_ID"];
	const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
	// The project id is the secret part of the RPC URL; scrub both forms.
	console.error(
		rpc === undefined || rpc === "" ? text : scrub(text.split(rpc).join("<project-id>"), rpc),
	);
	process.exitCode = 1;
});
