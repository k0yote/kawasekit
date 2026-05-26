/**
 * M4-1 — scripts/11-mainnet-self-settle.ts
 *
 * Polygon **mainnet** sibling of scripts/07-x402-self-settle.ts. Runs one full
 * x402 v2 paywall cycle (sign EIP-3009 → verify → settle) on real Polygon
 * mainnet, broadcasting `transferWithAuthorization` against the production JPYC
 * v2 contract. This is the script whose output feeds the CHANGELOG.md
 * `v0.1.0` section as one of the two required mainnet tx URLs (DoD M4-1.9 +
 * M4-1.10).
 *
 * SAFETY GATES (all enforced at startup, fail-fast):
 *
 *   1. **Explicit chain choice.** `KAWASEKIT_X402_CHAIN=polygon|polygonAmoy`
 *      is REQUIRED. No default — the operator must commit to a network in
 *      writing. Running with `polygonAmoy` is the "verify on Amoy before
 *      mainnet" rehearsal pattern called out in the M4 plan; scripts/07 is
 *      the canonical Amoy E2E, this script's Amoy mode is purely a structural
 *      smoke-test before flipping to mainnet.
 *   2. **Mainnet broadcast guard.** When `KAWASEKIT_X402_CHAIN=polygon`, the
 *      script additionally requires `KAWASEKIT_ALLOW_MAINNET=1`. Without it
 *      the script aborts before touching the network — guards a typo from
 *      becoming a real-money transfer.
 *   3. **Amount ceiling.** Default amount is **0.001 JPYC** (~0.001 JPY).
 *      Override with `X402_AMOUNT_HUMAN`, but `KAWASEKIT_ALLOW_MAINNET=1`
 *      operators are expected to start small per plan risk #1 (gradual
 *      rollout) and only widen after the first tx confirms.
 *
 * Required env (always):
 *   - X402_PAYER_PRIVATE_KEY         EOA payer (holds JPYC, signs off-chain)
 *   - X402_FACILITATOR_PRIVATE_KEY   EOA gas payer (holds POL, broadcasts)
 *   - KAWASEKIT_X402_CHAIN           "polygon" | "polygonAmoy"
 *
 * Required env (mainnet only):
 *   - KAWASEKIT_ALLOW_MAINNET=1      Explicit "yes I mean it" gate
 *
 * Optional env:
 *   - X402_RECIPIENT                 Default: payer's own address (loop-back).
 *                                    For real settlement, set this to the
 *                                    operator's merchant address so the tx
 *                                    represents a non-trivial value flow.
 *   - X402_AMOUNT_HUMAN              Decimal JPYC. Default "0.001".
 *   - POLYGON_RPC_URL                Polygon mainnet RPC override
 *   - POLYGON_AMOY_RPC_URL           Polygon Amoy RPC override
 *
 * This script lives in scripts/ (not src/), so console output is intentional.
 */

import "dotenv/config";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type Address,
	createPublicClient,
	createWalletClient,
	getAddress,
	type Hex,
	http,
	parseUnits,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import {
	buildPaymentRequirements,
	createSelfFacilitator,
	createX402Handler,
	createX402PaymentSigner,
	decodePaymentResponseHeader,
	getJpycAddress,
	JPYC_DECIMALS,
	jpycAbi,
	polygon,
	polygonAmoy,
	wrapFetch,
	X402_HEADER_PAYMENT_RESPONSE,
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

function requirePrivateKey(name: string): Hex {
	const value = requireEnv(name);
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
	readonly rpcUrl: string;
	readonly explorerTxBase: string;
	readonly displayName: string;
}

function resolveChainProfile(key: SupportedChainKey): ChainProfile {
	if (key === "polygon") {
		const rpcUrl = optionalEnv("POLYGON_RPC_URL") ?? polygon.rpcUrls.default.http[0];
		if (rpcUrl === undefined) {
			throw new Error("polygon.rpcUrls.default.http[0] is undefined; set POLYGON_RPC_URL.");
		}
		return {
			key,
			chain: polygon,
			network: "mainnet",
			rpcUrl,
			explorerTxBase: "https://polygonscan.com/tx/",
			displayName: "Polygon mainnet (137)",
		};
	}
	const rpcUrl = optionalEnv("POLYGON_AMOY_RPC_URL") ?? polygonAmoy.rpcUrls.default.http[0];
	if (rpcUrl === undefined) {
		throw new Error("polygonAmoy.rpcUrls.default.http[0] is undefined; set POLYGON_AMOY_RPC_URL.");
	}
	return {
		key,
		chain: polygonAmoy,
		network: "testnet",
		rpcUrl,
		explorerTxBase: "https://amoy.polygonscan.com/tx/",
		displayName: "Polygon Amoy testnet (80002)",
	};
}

function assertMainnetGuard(profile: ChainProfile): void {
	if (profile.network !== "mainnet") return;
	const gate = optionalEnv("KAWASEKIT_ALLOW_MAINNET");
	if (gate !== "1") {
		throw new Error(
			"Refusing to broadcast on Polygon mainnet without explicit consent. Set KAWASEKIT_ALLOW_MAINNET=1 if you really intend to spend real JPYC + POL on this run.",
		);
	}
}

async function main(): Promise<void> {
	const chainKey = requireChainChoice();
	const profile = resolveChainProfile(chainKey);
	assertMainnetGuard(profile);

	const payerPk = requirePrivateKey("X402_PAYER_PRIVATE_KEY");
	const facilitatorPk = requirePrivateKey("X402_FACILITATOR_PRIVATE_KEY");
	const amountHuman = optionalEnv("X402_AMOUNT_HUMAN") ?? "0.001";

	const payer = privateKeyToAccount(payerPk);
	// `nonceManager` is required for concurrent settle; this script only
	// fires one settlement so the manager is redundant here, but we install
	// it so the script mirrors the production wiring pattern documented in
	// `createSelfFacilitator`.
	const facilitatorAccount = privateKeyToAccount(facilitatorPk, { nonceManager });
	const recipientRaw = optionalEnv("X402_RECIPIENT");
	const recipient: Address = recipientRaw ? getAddress(recipientRaw) : payer.address;
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

	const transport = http(profile.rpcUrl);
	const publicClient = createPublicClient({ chain: profile.chain, transport });
	const facilitatorWallet = createWalletClient({
		chain: profile.chain,
		transport,
		account: facilitatorAccount,
	});

	const jpycAddress = getJpycAddress(profile.chain.id);

	console.log(`=== M4-1 x402 self-facilitator E2E on ${profile.displayName} ===\n`);
	console.log("Chain:                 ", profile.displayName);
	console.log("Network intent:        ", profile.network);
	console.log("RPC:                   ", profile.rpcUrl);
	console.log("Payer EOA:             ", payer.address);
	console.log("Facilitator EOA:       ", facilitatorAccount.address);
	console.log("Recipient:             ", recipient);
	console.log("JPYC contract:         ", jpycAddress);
	console.log("Amount per call:       ", amountHuman, "JPYC =", amount.toString(), "wei");

	if (profile.network === "mainnet") {
		console.log("\n⚠️  MAINNET BROADCAST — this will spend real JPYC and real POL.");
		console.log("   Press Ctrl-C within 3 s to abort.");
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}

	const balanceOf = async (addr: Address): Promise<bigint> =>
		(await publicClient.readContract({
			address: jpycAddress,
			abi: jpycAbi,
			functionName: "balanceOf",
			args: [addr],
		})) as bigint;

	const payerJpycBefore = await balanceOf(payer.address);
	const recipientJpycBefore = await balanceOf(recipient);
	const facilitatorPolBefore = await publicClient.getBalance({
		address: facilitatorAccount.address,
	});

	console.log("\n--- Balances before ---");
	console.log("Payer JPYC:            ", payerJpycBefore.toString(), "wei");
	console.log("Recipient JPYC:        ", recipientJpycBefore.toString(), "wei");
	console.log("Facilitator POL:       ", facilitatorPolBefore.toString(), "wei");

	if (payerJpycBefore < amount) {
		console.error(`\n❌ Payer has insufficient JPYC. Need ${amount}, has ${payerJpycBefore}.`);
		console.error(`   Fund this address: ${payer.address}`);
		if (profile.network === "testnet") {
			console.error(`   Polygon Amoy JPYC faucet: https://faucet.jpyc.co.jp/`);
		} else {
			console.error(`   Mainnet JPYC has no faucet — acquire via the JPYC issuer's OTC channel.`);
		}
		process.exitCode = 1;
		return;
	}

	if (facilitatorPolBefore === 0n) {
		console.error(`\n❌ Facilitator has 0 POL — cannot pay gas to broadcast settlement.`);
		console.error(`   Fund this address: ${facilitatorAccount.address}`);
		if (profile.network === "testnet") {
			console.error(`   Polygon Amoy POL faucet: https://faucet.polygon.technology/`);
		} else {
			console.error(`   Acquire POL on an exchange and transfer to the facilitator.`);
		}
		process.exitCode = 1;
		return;
	}

	// Build the kawasekit server-side stack.
	const facilitator = createSelfFacilitator({
		network: profile.network,
		walletClient: facilitatorWallet,
		publicClient,
	});
	const requirements = buildPaymentRequirements({
		chainId: profile.chain.id,
		asset: jpycAddress,
		payTo: recipient,
		amount,
		// Mainnet bundlers / RPC are typically faster than Amoy but we keep the
		// same generous window so client-side signers don't have to special-case.
		maxTimeoutSeconds: 300,
	});
	const handler = createX402Handler({
		facilitator,
		requirementsFor: (req) =>
			new URL(req.url).pathname.startsWith("/api/weather/") ? [requirements] : null,
		handler: (req, ctx) => {
			const city = new URL(req.url).pathname.replace("/api/weather/", "");
			return new Response(
				JSON.stringify({
					city: city || "Unknown",
					weather: "sunny",
					paid: ctx !== null,
					settlementTx: ctx?.settlement.transaction,
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});

	// Bridge node:http ↔ WHATWG Request/Response so the handler stays pure.
	const server = createServer(async (req, res) => {
		try {
			const baseHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const url = `${baseHost}${req.url ?? "/"}`;
			const headers = new Headers();
			for (const [name, value] of Object.entries(req.headers)) {
				if (typeof value === "string") headers.set(name, value);
				else if (Array.isArray(value)) headers.set(name, value.join(", "));
			}
			const request = new Request(url, { method: req.method ?? "GET", headers });
			const response = await handler(request);
			res.statusCode = response.status;
			response.headers.forEach((value, key) => {
				res.setHeader(key, value);
			});
			const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
			res.end(body);
		} catch (cause) {
			res.statusCode = 500;
			res.setHeader("content-type", "text/plain");
			res.end(`server error: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}`;
	console.log("\nLocal paywall server:  ", baseUrl);

	// Build the kawasekit client-side stack.
	const signer = createX402PaymentSigner({ network: profile.network, account: payer });
	const fetch402 = wrapFetch({
		signer,
		onPayment: (req) => {
			console.log("\n→ Paying", req.amount, "wei JPYC to", req.payTo);
			return true;
		},
	});

	let settlementTxHash: string | null = null;
	try {
		console.log("→ GET", `${baseUrl}/api/weather/Tokyo`);
		const startMs = Date.now();
		const response = await fetch402(`${baseUrl}/api/weather/Tokyo`);
		const durationMs = Date.now() - startMs;
		console.log("← status:              ", response.status);
		console.log("← duration:            ", durationMs, "ms");

		const respHeader = response.headers.get(X402_HEADER_PAYMENT_RESPONSE);
		if (respHeader) {
			const settlement = decodePaymentResponseHeader(respHeader);
			settlementTxHash = settlement.transaction || null;
			console.log("← settlement success:  ", settlement.success);
			console.log("← payer:               ", settlement.payer);
			console.log("← tx hash:             ", settlement.transaction);
			if (settlement.transaction) {
				console.log(
					"← Polygonscan:         ",
					`${profile.explorerTxBase}${settlement.transaction}`,
				);
			}
			if (!settlement.success) {
				console.error("\n❌ Settlement reported failure:", settlement.errorReason);
				process.exitCode = 1;
			}
		} else {
			console.error("\n❌ No PAYMENT-RESPONSE header on response — payment did not settle.");
		}

		console.log("← body:                ", await response.text());

		if (response.status !== 200) {
			console.error("\n❌ Expected 200, got", response.status);
			process.exitCode = 1;
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	console.log("\n--- Balances after ---");
	const payerJpycAfter = await balanceOf(payer.address);
	const recipientJpycAfter = await balanceOf(recipient);
	const facilitatorPolAfter = await publicClient.getBalance({
		address: facilitatorAccount.address,
	});
	console.log("Payer JPYC:            ", payerJpycAfter.toString(), "wei");
	console.log("Recipient JPYC:        ", recipientJpycAfter.toString(), "wei");
	console.log("Facilitator POL:       ", facilitatorPolAfter.toString(), "wei");
	console.log("Payer JPYC delta:      ", (payerJpycAfter - payerJpycBefore).toString(), "wei");
	console.log(
		"Recipient JPYC delta:  ",
		(recipientJpycAfter - recipientJpycBefore).toString(),
		"wei",
	);
	console.log(
		"Facilitator POL spent: ",
		(facilitatorPolBefore - facilitatorPolAfter).toString(),
		"wei",
	);

	if (payer.address.toLowerCase() === recipient.toLowerCase()) {
		console.log("\n(Loop-back mode: JPYC returned to the same address; net JPYC delta = 0.)");
	}

	if (process.exitCode !== 1 && settlementTxHash !== null) {
		const verdict =
			profile.network === "mainnet"
				? "✅ M4-1 mainnet self-facilitator settlement PASS — record this tx URL in CHANGELOG.md v0.1.0."
				: "✅ M4-1 self-facilitator rehearsal PASS on Amoy — re-run with KAWASEKIT_X402_CHAIN=polygon when ready.";
		console.log(`\n${verdict}`);
	}
}

main().catch((error: unknown) => {
	console.error("\nM4-1 x402 mainnet-self-settle script failed:");
	console.error(error);
	process.exitCode = 1;
});
