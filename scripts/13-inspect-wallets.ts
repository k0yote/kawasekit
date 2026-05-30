/**
 * M4 — scripts/13-inspect-wallets.ts
 *
 * Read-only inspection of every wallet kawasekit cares about. Reads the
 * private keys from `.env`, derives addresses (never logs the keys), and
 * queries native-gas + JPYC balances on the chosen chain. Useful for:
 *
 *   - Confirming funding before scripts/11 + scripts/12 mainnet runs
 *   - Spot-checking Amoy state during development
 *   - Surfacing the smart-account counterfactual address that scripts/12
 *     will deploy under
 *
 * No on-chain writes, no broadcasts, no ZeroDev project ID required. Uses
 * the public chain RPC (or POLYGON_RPC_URL / POLYGON_AMOY_RPC_URL override
 * if provided).
 *
 * Required env:
 *   - KAWASEKIT_X402_CHAIN   "polygon" | "polygonAmoy" | "kaia" | "kairos" |
 *                            "avalanche" | "avalancheFuji" | "ethereum" | "sepolia"
 *
 * Optional env (any subset — script skips missing entries):
 *   - OWNER_PRIVATE_KEY                 Owner EOA + smart-account derivation
 *                                       (ZeroDev chains only; on Kaia the
 *                                       derivation warns and is skipped)
 *   - X402_PAYER_PRIVATE_KEY            x402 payer EOA (holds JPYC)
 *   - X402_FACILITATOR_PRIVATE_KEY      x402 facilitator EOA (holds native gas)
 *   - SESSION_KEY_PRIVATE_KEY           Legacy long-lived session key (M3 era)
 *   - <CHAIN>_RPC_URL                   Per-chain RPC override, e.g. KAIROS_RPC_URL,
 *                                       POLYGON_AMOY_RPC_URL, ETHEREUM_RPC_URL
 *
 * This script lives in scripts/ (not src/), so console output is intentional.
 */

import "dotenv/config";

import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { type Address, createPublicClient, formatEther, formatUnits, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	avalanche,
	avalancheFuji,
	ethereum,
	getJpycAddress,
	isSupportedChainId,
	JPYC_DECIMALS,
	jpycAbi,
	type KawaseChain,
	kaia,
	kairos,
	polygon,
	polygonAmoy,
	sepolia,
} from "../src";

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

interface ChainProfile {
	readonly chain: KawaseChain;
	readonly displayName: string;
	readonly rpcUrl: string;
	readonly explorerAddressBase: string;
}

/** Every kawasekit-supported chain, keyed by its `KAWASEKIT_X402_CHAIN` value,
 *  with the optional per-chain RPC override env var. Config-as-data. */
const CHAIN_PROFILES: Record<string, { readonly chain: KawaseChain; readonly rpcEnv: string }> = {
	polygon: { chain: polygon, rpcEnv: "POLYGON_RPC_URL" },
	polygonAmoy: { chain: polygonAmoy, rpcEnv: "POLYGON_AMOY_RPC_URL" },
	kaia: { chain: kaia, rpcEnv: "KAIA_RPC_URL" },
	kairos: { chain: kairos, rpcEnv: "KAIROS_RPC_URL" },
	avalanche: { chain: avalanche, rpcEnv: "AVALANCHE_RPC_URL" },
	avalancheFuji: { chain: avalancheFuji, rpcEnv: "AVALANCHE_FUJI_RPC_URL" },
	ethereum: { chain: ethereum, rpcEnv: "ETHEREUM_RPC_URL" },
	sepolia: { chain: sepolia, rpcEnv: "SEPOLIA_RPC_URL" },
};

function requireChainProfile(): ChainProfile {
	const raw = optionalEnv("KAWASEKIT_X402_CHAIN");
	const entry = raw !== undefined ? CHAIN_PROFILES[raw] : undefined;
	if (entry === undefined) {
		const keys = Object.keys(CHAIN_PROFILES).join('" | "');
		throw new Error(
			`KAWASEKIT_X402_CHAIN must be one of "${keys}", got ${JSON.stringify(raw ?? "<missing>")}.`,
		);
	}
	const { chain, rpcEnv } = entry;
	const rpcUrl = optionalEnv(rpcEnv) ?? chain.rpcUrls.default.http[0];
	if (rpcUrl === undefined) {
		throw new Error(`${chain.name} has no default RPC URL; set ${rpcEnv}.`);
	}
	const explorerBase = chain.blockExplorers?.default.url;
	return {
		chain,
		displayName: `${chain.name} (${chain.id})`,
		rpcUrl,
		explorerAddressBase: explorerBase !== undefined ? `${explorerBase}/address/` : "",
	};
}

interface InspectTarget {
	readonly role: string;
	readonly address: Address;
	readonly note?: string;
}

async function deriveSmartAccountAddress(
	owner: ReturnType<typeof privateKeyToAccount>,
	profile: ChainProfile,
): Promise<Address> {
	const publicClient = createPublicClient({
		chain: profile.chain,
		transport: http(profile.rpcUrl),
	});
	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;
	const sudoValidator = await signerToEcdsaValidator(publicClient, {
		signer: owner,
		entryPoint,
		kernelVersion,
	});
	const account = await createKernelAccount(publicClient, {
		plugins: { sudo: sudoValidator },
		entryPoint,
		kernelVersion,
	});
	return account.address;
}

async function main(): Promise<void> {
	const profile = requireChainProfile();
	const publicClient = createPublicClient({
		chain: profile.chain,
		transport: http(profile.rpcUrl),
	});
	const chainId = profile.chain.id;
	if (!isSupportedChainId(chainId)) {
		throw new Error(`${profile.displayName} is not a kawasekit-supported chain.`);
	}
	const jpycAddress = getJpycAddress(chainId);

	console.log(`=== kawasekit wallet inspection on ${profile.displayName} ===\n`);
	console.log("RPC:           ", profile.rpcUrl);
	console.log("JPYC contract: ", jpycAddress);

	const targets: InspectTarget[] = [];

	// --- Owner EOA + derived smart account ---------------------------------
	const ownerRaw = optionalEnv("OWNER_PRIVATE_KEY");
	if (ownerRaw !== undefined) {
		const owner = privateKeyToAccount(asPrivateKey("OWNER_PRIVATE_KEY", ownerRaw));
		targets.push({ role: "Owner EOA", address: owner.address });
		try {
			const smartAccountAddress = await deriveSmartAccountAddress(owner, profile);
			targets.push({
				role: "Smart account",
				address: smartAccountAddress,
				note: "counterfactual, owner-derived (Kernel v3.1 + ECDSA sudo)",
			});
		} catch (cause) {
			console.error(
				"\n⚠  Failed to derive smart account address:",
				cause instanceof Error ? cause.message : String(cause),
			);
		}
	}

	// --- x402 payer EOA -----------------------------------------------------
	const payerRaw = optionalEnv("X402_PAYER_PRIVATE_KEY");
	if (payerRaw !== undefined) {
		const payer = privateKeyToAccount(asPrivateKey("X402_PAYER_PRIVATE_KEY", payerRaw));
		targets.push({ role: "x402 payer EOA", address: payer.address });
	}

	// --- x402 facilitator EOA ----------------------------------------------
	const facRaw = optionalEnv("X402_FACILITATOR_PRIVATE_KEY");
	if (facRaw !== undefined) {
		const facilitator = privateKeyToAccount(asPrivateKey("X402_FACILITATOR_PRIVATE_KEY", facRaw));
		targets.push({ role: "x402 facilitator EOA", address: facilitator.address });
	}

	// --- Legacy long-lived session key (M3 scripts/09 + 10) ----------------
	const sessionRaw = optionalEnv("SESSION_KEY_PRIVATE_KEY");
	if (sessionRaw !== undefined) {
		const session = privateKeyToAccount(asPrivateKey("SESSION_KEY_PRIVATE_KEY", sessionRaw));
		targets.push({ role: "Session key EOA", address: session.address, note: "M3 long-lived key" });
	}

	if (targets.length === 0) {
		console.log("\n(no recognised env vars present — nothing to inspect)");
		return;
	}

	console.log("\nQuerying balances...");

	for (const target of targets) {
		const [gasWei, jpycWei] = await Promise.all([
			publicClient.getBalance({ address: target.address }),
			publicClient.readContract({
				address: jpycAddress,
				abi: jpycAbi,
				functionName: "balanceOf",
				args: [target.address],
			}) as Promise<bigint>,
		]);

		const gasHuman = formatEther(gasWei);
		const jpycHuman = formatUnits(jpycWei, JPYC_DECIMALS);
		const gasLabel = `${profile.chain.nativeCurrency.symbol}:`.padEnd(9);

		console.log(`\n${target.role}`);
		console.log("  Address: ", target.address);
		if (profile.explorerAddressBase !== "") {
			console.log("  Explorer:", `${profile.explorerAddressBase}${target.address}`);
		}
		if (target.note !== undefined) {
			console.log("  Note:    ", target.note);
		}
		console.log(`  ${gasLabel}`, gasHuman.padStart(28), `  (${gasWei.toString()} wei)`);
		console.log("  JPYC:    ", jpycHuman.padStart(28), `  (${jpycWei.toString()} wei)`);
	}
}

main().catch((error: unknown) => {
	console.error("\nM4 inspect-wallets script failed:");
	console.error(error);
	process.exitCode = 1;
});
