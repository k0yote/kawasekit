/**
 * M4-1 — scripts/12-mainnet-session-flow.ts
 *
 * Polygon **mainnet** sibling of scripts/09 + scripts/10. Runs the full
 * session-key lifecycle on real Polygon mainnet:
 *
 *   1. Owner issues a session key bound to the daily-limit policy.
 *   2. Envelope round-trips (serialize → parse → restore) — simulates the
 *      offline handoff that real deployments do.
 *   3. Restored session key signs one sponsored JPYC.transfer UserOp. **This
 *      tx is the M4-1.9 deliverable — record its URL in CHANGELOG v0.1.0.**
 *   4. Owner sudo client revokes the session via `uninstallValidation`.
 *   5. Post-revoke transfer is attempted and expected to fail at the
 *      validation phase. The script asserts the failure.
 *
 * SAFETY GATES (same model as scripts/11):
 *
 *   1. `KAWASEKIT_X402_CHAIN=polygon|polygonAmoy` is REQUIRED. No default.
 *      Running with `polygonAmoy` is the rehearsal mode; scripts/09 + 10 are
 *      the canonical Amoy E2E. This script's Amoy mode exists to verify the
 *      structural changes (chain selection, RPC routing, network argument)
 *      before flipping to mainnet.
 *   2. When `KAWASEKIT_X402_CHAIN=polygon`, `KAWASEKIT_ALLOW_MAINNET=1` is
 *      also required. Guards a typo from becoming a real-money UserOp.
 *   3. Default transfer amount is **0.001 JPYC**. Override with
 *      `JPYC_AMOUNT_HUMAN`. The script needs at least `2 × amount` worth of
 *      JPYC in the smart account (pre-revoke transfer + post-revoke attempt
 *      which is expected to revert without spending).
 *
 * SESSION KEY POLICY for this script:
 *   The session key is **freshly generated per run** via crypto.randomBytes,
 *   NOT taken from SESSION_KEY_PRIVATE_KEY. The reason: if you re-use a
 *   long-lived session key whose validator was previously issued + revoked on
 *   the same smart account, Kernel rejects re-install with
 *   `AA23 reverted 0x756688fe` (InvalidNonce()) — the validator address is
 *   the same as a tombstoned one. Fresh-per-run avoids the tombstone and also
 *   models the production pattern (owner mints a new session, hands it to the
 *   agent, revokes it when done). scripts/09 + 10 are the canonical Amoy
 *   demos for long-lived session keys; scripts/12 is the production lifecycle.
 *
 * Required env (always):
 *   - OWNER_PRIVATE_KEY              EOA that owns the agent smart account
 *                                    (the smart-account address is derived
 *                                    from this; reuse the same key across
 *                                    runs to keep the same account funded)
 *   - ZERODEV_PROJECT_ID             Project ID that covers the chosen chain.
 *                                    **Mainnet and Amoy normally need separate
 *                                    ZeroDev projects** — set this env to the
 *                                    project matching `KAWASEKIT_X402_CHAIN`.
 *   - KAWASEKIT_X402_CHAIN           "polygon" | "polygonAmoy"
 *
 * Required env (mainnet only):
 *   - KAWASEKIT_ALLOW_MAINNET=1      Explicit "yes I mean it" gate
 *
 * Optional env:
 *   - JPYC_RECIPIENT                 Default: the smart account itself
 *                                    (loop-back). For a more interesting
 *                                    mainnet tx, set to a merchant address.
 *   - JPYC_AMOUNT_HUMAN              Default "0.001". Mainnet starts small.
 *   - JPYC_MAX_PER_TX_HUMAN          Default "100" (policy cap, not transfer).
 *   - JPYC_MAX_PER_DAY               Default "10".
 *
 * This script lives in scripts/ (not src/), so console output is intentional.
 */

import "dotenv/config";

import { randomBytes } from "node:crypto";
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
	createJpycDailyLimitPolicies,
	getJpycAddress,
	issueSessionKey,
	JPYC_DECIMALS,
	jpycAbi,
	parseSessionEnvelope,
	polygon,
	polygonAmoy,
	restoreSessionAccount,
	revokeSessionKey,
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

type SupportedChainKey = "polygon" | "polygonAmoy";

function requireChainChoice(): SupportedChainKey {
	const raw = requireEnv("KAWASEKIT_X402_CHAIN");
	if (raw !== "polygon" && raw !== "polygonAmoy") {
		throw new Error(
			`KAWASEKIT_X402_CHAIN must be "polygon" (mainnet) or "polygonAmoy" (testnet), got ${JSON.stringify(raw)}.`,
		);
	}
	return raw;
}

interface ChainProfile {
	readonly key: SupportedChainKey;
	readonly chain: typeof polygon | typeof polygonAmoy;
	readonly network: "mainnet" | "testnet";
	readonly explorerTxBase: string;
	readonly displayName: string;
}

function resolveChainProfile(key: SupportedChainKey): ChainProfile {
	if (key === "polygon") {
		return {
			key,
			chain: polygon,
			network: "mainnet",
			explorerTxBase: "https://polygonscan.com/tx/",
			displayName: "Polygon mainnet (137)",
		};
	}
	return {
		key,
		chain: polygonAmoy,
		network: "testnet",
		explorerTxBase: "https://amoy.polygonscan.com/tx/",
		displayName: "Polygon Amoy testnet (80002)",
	};
}

function assertMainnetGuard(profile: ChainProfile): void {
	if (profile.network !== "mainnet") return;
	const gate = optionalEnv("KAWASEKIT_ALLOW_MAINNET");
	if (gate !== "1") {
		throw new Error(
			"Refusing to issue and broadcast session-key UserOps on Polygon mainnet without explicit consent. Set KAWASEKIT_ALLOW_MAINNET=1 if you really intend to spend real JPYC + paymaster gas on this run.",
		);
	}
}

async function main(): Promise<void> {
	const chainKey = requireChainChoice();
	const profile = resolveChainProfile(chainKey);
	assertMainnetGuard(profile);

	const ownerKey = asPrivateKey("OWNER_PRIVATE_KEY", requireEnv("OWNER_PRIVATE_KEY"));
	const projectId = requireEnv("ZERODEV_PROJECT_ID");

	// Fresh ephemeral session key per run. See "SESSION KEY POLICY" in the
	// header comment for why we do NOT reuse SESSION_KEY_PRIVATE_KEY.
	const sessionKey = `0x${randomBytes(32).toString("hex")}` as Hex;

	const rpcUrl = zerodevRpcUrl(profile.chain, projectId);
	const owner = privateKeyToAccount(ownerKey);
	const session = privateKeyToAccount(sessionKey);

	const maxPerTxHuman = optionalEnv("JPYC_MAX_PER_TX_HUMAN") ?? "100";
	const maxPerDay = Number.parseInt(optionalEnv("JPYC_MAX_PER_DAY") ?? "10", 10);
	const amountHuman = optionalEnv("JPYC_AMOUNT_HUMAN") ?? "0.001";
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

	const jpycAddress = getJpycAddress(profile.chain.id);
	const policies = createJpycDailyLimitPolicies({
		jpycAddress,
		maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
		maxTransfersPerDay: maxPerDay,
	});

	console.log(`=== M4-1 session-key full lifecycle on ${profile.displayName} ===\n`);
	console.log("Chain:                 ", profile.displayName);
	console.log("Network intent:        ", profile.network);
	console.log("ZeroDev RPC:           ", rpcUrl);
	console.log("Owner (EOA):           ", owner.address);
	console.log("Session key (EOA):     ", session.address, "(fresh ephemeral, this run only)");
	console.log("JPYC contract:         ", jpycAddress);
	console.log("Policy max per tx:     ", maxPerTxHuman, "JPYC");
	console.log("Policy max per day:    ", maxPerDay, "transfers");
	console.log("Transfer amount:       ", amountHuman, "JPYC =", amount.toString(), "wei");

	if (profile.network === "mainnet") {
		console.log("\n⚠️  MAINNET BROADCAST — this will issue a real session validator,");
		console.log("   spend real JPYC, and consume real paymaster credit.");
		console.log("   Press Ctrl-C within 3 s to abort.");
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}

	const publicClient = createPublicClient({
		chain: profile.chain,
		transport: http(rpcUrl),
	});

	// --- Owner side: issue + envelope round-trip ---
	console.log("\n[1/5] Owner issuing session-key envelope...");
	const envelope = await issueSessionKey({
		publicClient,
		ownerSigner: owner,
		sessionKeySigner: session,
		policies,
		policySummary: {
			jpycAddress,
			maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
			maxTransfersPerDay: maxPerDay,
		},
	});
	console.log("      Smart account:   ", envelope.smartAccountAddress);
	console.log("      Envelope chainId:", envelope.chainId);
	console.log("      Envelope version:", envelope.kawasekitVersion);

	console.log("\n[2/5] Envelope serialize → parse round-trip...");
	const wire = serializeSessionEnvelope(envelope);
	console.log("      Wire size:       ", wire.length, "chars");
	const restored = parseSessionEnvelope(wire);

	// --- Agent side: restore (fresh PublicClient, mimicking another process) ---
	const agentPublicClient = createPublicClient({
		chain: profile.chain,
		transport: http(rpcUrl),
	});
	const restoredAccount = await restoreSessionAccount({
		publicClient: agentPublicClient,
		envelope: restored,
		sessionKeySigner: session,
	});
	if (getAddress(restoredAccount.address) !== getAddress(envelope.smartAccountAddress)) {
		console.error("\n❌ Restored account address does not match envelope smart-account address.");
		process.exitCode = 1;
		return;
	}
	console.log("      Restored account:", restoredAccount.address);

	// --- Pre-flight: the smart account must hold at least 2x the transfer
	//     amount because we run a pre-revoke transfer and then try one more
	//     (which is expected to revert without spending). Funding for "2x"
	//     gives the second attempt actual JPYC to fail against rather than
	//     reverting on a balance pre-check.
	const balance = (await agentPublicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [restoredAccount.address],
	})) as bigint;
	console.log("      JPYC balance:    ", balance.toString(), "wei");
	if (balance < amount * 2n) {
		console.error(
			`\n❌ Smart account needs at least ${amount * 2n} wei JPYC (two transfer attempts).`,
		);
		console.error(`   Fund this address: ${restoredAccount.address}`);
		if (profile.network === "testnet") {
			console.error(`   Polygon Amoy JPYC faucet: https://faucet.jpyc.co.jp/`);
		} else {
			console.error(`   Mainnet JPYC has no faucet — acquire via the JPYC issuer's OTC channel.`);
		}
		process.exitCode = 1;
		return;
	}

	// --- Build session-scoped kernel client (for the agent transfer) ---
	const paymasterClient = createZeroDevPaymasterClient({
		chain: profile.chain,
		transport: http(rpcUrl),
	});
	const sessionKernelClient = createKernelAccountClient({
		account: restoredAccount,
		chain: profile.chain,
		client: agentPublicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	const recipientRaw = optionalEnv("JPYC_RECIPIENT") ?? restoredAccount.address;
	const recipient: Address = getAddress(recipientRaw);

	// --- [3/5] Pre-revoke transfer — THIS is the M4-1.9 deliverable tx ---
	console.log(`\n[3/5] Pre-revoke transfer of ${amountHuman} JPYC via session key...`);
	console.log("      Recipient:       ", recipient);
	const before = await transferJpyc(sessionKernelClient, { to: recipient, amount });
	console.log("      userOp hash:     ", before.userOpHash);
	console.log("      bundle tx hash:  ", before.transactionHash);
	if (before.transactionHash) {
		console.log("      Polygonscan:     ", `${profile.explorerTxBase}${before.transactionHash}`);
	}
	if (!before.success) {
		console.error("\n❌ Pre-revoke transfer reported failure — cannot continue.");
		process.exitCode = 1;
		return;
	}

	// --- Build owner sudo-only kernel client for the revoke step ---
	//
	// Critical: revoke MUST go through the sudo (ECDSA) validator. A client
	// with both sudo + regular plugins makes ZeroDev sign with the session-key
	// permission validator, and callPolicy then rejects `uninstallValidation`
	// at the AA validation phase ("AA23 reverted"). A sudo-only account
	// derives the SAME counterfactual address because Kernel v3.1 only mixes
	// sudo into the init code (regular is lazy-installed at first use).
	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;
	const sudoValidator = await signerToEcdsaValidator(publicClient, {
		signer: owner,
		entryPoint,
		kernelVersion,
	});
	const ownerSudoAccount = await createKernelAccount(publicClient, {
		plugins: { sudo: sudoValidator },
		entryPoint,
		kernelVersion,
	});
	const ownerKernelClient = createKernelAccountClient({
		account: ownerSudoAccount,
		chain: profile.chain,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	// --- [4/5] Owner revokes the session ---
	console.log("\n[4/5] Owner revoking the session key (uninstallValidation)...");
	const revoke = await revokeSessionKey({
		ownerKernelClient,
		envelope,
		sessionKeySigner: session,
		policies,
	});
	console.log("      userOp hash:     ", revoke.userOpHash);
	console.log("      bundle tx hash:  ", revoke.transactionHash);
	if (revoke.transactionHash) {
		console.log("      Polygonscan:     ", `${profile.explorerTxBase}${revoke.transactionHash}`);
	}
	if (!revoke.success) {
		console.error("\n❌ Revoke UserOp reported failure.");
		process.exitCode = 1;
		return;
	}

	// --- [5/5] Post-revoke transfer — must revert at validation phase ---
	console.log(`\n[5/5] Post-revoke transfer attempt (expected to FAIL)...`);
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
	}

	const verdict =
		profile.network === "mainnet"
			? "✅ M4-1 mainnet session-key lifecycle PASS — record the pre-revoke tx URL in CHANGELOG.md v0.1.0 (this is the M4-1.9 deliverable; revoke + post-revoke evidence is additional credibility material)."
			: "✅ M4-1 session-key rehearsal PASS on Amoy — re-run with KAWASEKIT_X402_CHAIN=polygon when ready.";
	console.log(`\n${verdict}`);
}

main().catch((error: unknown) => {
	console.error("\nM4-1 session-flow script failed:");
	console.error(error);
	process.exitCode = 1;
});
