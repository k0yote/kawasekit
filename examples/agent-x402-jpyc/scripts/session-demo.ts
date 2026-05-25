/**
 * Sidecar demo for kawasekit's session-key lifecycle (M3-2). Runs
 * independently of the Mastra agent: it shows owner-side issuance,
 * serialization to a portable JSON file, and agent-side restoration on a
 * fresh PublicClient.
 *
 * The Mastra agent in `agent/index.ts` does NOT use this — it pays via the
 * direct EOA + x402 path because JPYC's EIP-3009 implementation rejects
 * smart-account signers (pure ecrecover, no ERC-1271 fallback). The session
 * key lives on a different axis: it scopes how the agent's *smart account*
 * may transact (via ERC-4337 UserOps), with the owner retaining sudo
 * authority to revoke or rotate.
 *
 * Run with:
 *   cp .env.example .env  # fill OWNER_PRIVATE_KEY + AGENT_PAYER_PRIVATE_KEY
 *   pnpm dev:session-demo
 *
 * On success the script writes `.agent-state/session.json` (gitignored) so a
 * subsequent restart can re-load and restore the same envelope.
 */

import "dotenv/config";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	createJpycDailyLimitPolicies,
	getJpycAddress,
	issueSessionKey,
	JPYC_DECIMALS,
	parseSessionEnvelope,
	polygonAmoy,
	restoreSessionAccount,
	serializeSessionEnvelope,
} from "kawasekit";
import { createPublicClient, getAddress, type Hex, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new Error(`Missing required env var: ${name}. Copy .env.example to .env.`);
	}
	return value;
}

function optionalEnv(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value.trim() === "" ? undefined : value;
}

function requirePrivateKey(name: string): Hex {
	const value = requireEnv(name);
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
		throw new Error(`${name} must be a 0x-prefixed 32-byte hex string.`);
	}
	return value as Hex;
}

const ownerPk = requirePrivateKey("OWNER_PRIVATE_KEY");
const agentPk = requirePrivateKey("AGENT_PAYER_PRIVATE_KEY");
const rpcUrl = optionalEnv("POLYGON_AMOY_RPC_URL") ?? polygonAmoy.rpcUrls.default.http[0];
if (rpcUrl === undefined) {
	throw new Error("polygonAmoy.rpcUrls.default.http[0] is undefined; set POLYGON_AMOY_RPC_URL.");
}
const maxPerTxHuman = optionalEnv("SESSION_MAX_PER_TX_JPYC") ?? "100";
const maxPerDay = Number.parseInt(optionalEnv("SESSION_MAX_PER_DAY") ?? "10", 10);
const sessionFile = optionalEnv("SESSION_FILE") ?? ".agent-state/session.json";

const owner = privateKeyToAccount(ownerPk);
const agentSigner = privateKeyToAccount(agentPk);
const jpycAddress = getJpycAddress(polygonAmoy.id);

const policies = createJpycDailyLimitPolicies({
	jpycAddress,
	maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
	maxTransfersPerDay: maxPerDay,
});

console.log("=== M3-2 session-key sidecar demo ===\n");
console.log("Owner (sudo, EOA):     ", owner.address);
console.log("Agent (session signer):", agentSigner.address);
console.log("Policy max per tx:     ", maxPerTxHuman, "JPYC");
console.log("Policy max per day:    ", maxPerDay, "transfers");
console.log("RPC:                   ", rpcUrl);

// --- Owner side: issue ---
const ownerPublicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86_400 * 30); // 30 days

console.log("\n[1/3] Owner issues a session envelope (no on-chain tx)...");
const envelope = await issueSessionKey({
	publicClient: ownerPublicClient,
	ownerSigner: owner,
	sessionKeySigner: agentSigner,
	policies,
	expiresAt,
	policySummary: {
		jpycAddress,
		maxPerTransfer: parseUnits(maxPerTxHuman, JPYC_DECIMALS),
		maxTransfersPerDay: maxPerDay,
	},
});
console.log("      smart account:   ", envelope.smartAccountAddress);
console.log("      expires:         ", new Date(Number(expiresAt) * 1000).toISOString());

// --- Serialize and persist (mimics owner shipping the envelope to the agent) ---
console.log(`\n[2/3] Serializing envelope to ${sessionFile}...`);
const wire = serializeSessionEnvelope(envelope);
mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(sessionFile, wire);
console.log("      wire size:       ", wire.length, "chars");

// --- Agent side: restore on a fresh PublicClient ---
console.log("\n[3/3] Agent reads the envelope and restores on a fresh PublicClient...");
const agentPublicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });
const parsed = parseSessionEnvelope(readFileSync(sessionFile, "utf8"));
const restored = await restoreSessionAccount({
	publicClient: agentPublicClient,
	envelope: parsed,
	sessionKeySigner: agentSigner,
});
console.log("      restored address:", restored.address);

if (getAddress(restored.address) !== getAddress(envelope.smartAccountAddress)) {
	console.error("\n❌ Restored address does NOT match the issued envelope.");
	process.exitCode = 1;
} else {
	console.log("\n✅ Roundtrip OK. The envelope can be shipped to any agent process and restored.");
	console.log("   Next: build a KernelAccountClient from `restored` and send a UserOp.");
	console.log("   The on-chain UserOp + revoke flows are covered by:");
	console.log("     - root scripts/09-session-issue-restore.ts");
	console.log("     - root scripts/10-session-revoke.ts");
}
