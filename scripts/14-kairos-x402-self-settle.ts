/**
 * M5-3 — scripts/14-kairos-x402-self-settle.ts
 *
 * Real-bullet end-to-end x402 v2 paywall on **Kaia Kairos testnet**, the M5-3
 * verification of multi-chain support. Same flow as scripts/07 (Amoy), on Kairos:
 *
 *   client (EOA, holds JPYC on Kairos)
 *     → wrapFetch → 402 → sign EIP-3009 → retry with PAYMENT-SIGNATURE
 *   server (kawasekit createX402Handler)
 *     → createSelfFacilitator.verify → settle (broadcast `transferWithAuthorization`
 *       from facilitator EOA paying KAIA gas)
 *     → invoke inner handler → attach PAYMENT-RESPONSE
 *
 * Real JPYC moves from the payer to the recipient on Kairos. Kaia has ~1 s blocks
 * and IBFT immediate finality, so the facilitator's chain-aware default is
 * `confirmations: 1` (vs Polygon's 4).
 *
 * Required env:
 *   - X402_PAYER_PRIVATE_KEY         EOA payer (signs EIP-3009 off-chain; must
 *                                    hold JPYC on Kairos; does NOT broadcast, so
 *                                    KAIA is not required for THIS EOA)
 *   - X402_FACILITATOR_PRIVATE_KEY   EOA gas payer (broadcasts settlement; must
 *                                    hold Kairos KAIA)
 *
 * Optional env:
 *   - X402_RECIPIENT          Default: payer's own address (loop-back, JPYC stays put)
 *   - X402_AMOUNT_HUMAN       Decimal JPYC per call. Default "0.01"
 *   - KAIROS_RPC_URL          Override default kairos RPC
 *
 * Faucets (Kairos):
 *   - KAIA gas: https://faucet.kaia.io  (select Kairos)
 *   - JPYC:     https://faucet.jpyc.co.jp/  (select Kaia / Kairos)
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
	kairos,
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

async function main(): Promise<void> {
	const payerPk = requirePrivateKey("X402_PAYER_PRIVATE_KEY");
	const facilitatorPk = requirePrivateKey("X402_FACILITATOR_PRIVATE_KEY");
	const amountHuman = optionalEnv("X402_AMOUNT_HUMAN") ?? "0.01";
	const rpcUrl = optionalEnv("KAIROS_RPC_URL") ?? kairos.rpcUrls.default.http[0];
	if (rpcUrl === undefined) {
		throw new Error("kairos.rpcUrls.default.http[0] is undefined; set KAIROS_RPC_URL.");
	}
	const explorerBase = kairos.blockExplorers?.default.url;

	const payer = privateKeyToAccount(payerPk);
	// `nonceManager` is required by createSelfFacilitator (threat 2.2) to serialise
	// nonces under concurrent settle.
	const facilitatorAccount = privateKeyToAccount(facilitatorPk, { nonceManager });
	const recipientRaw = optionalEnv("X402_RECIPIENT");
	const recipient: Address = recipientRaw ? getAddress(recipientRaw) : payer.address;
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

	const transport = http(rpcUrl);
	const publicClient = createPublicClient({ chain: kairos, transport });
	const facilitatorWallet = createWalletClient({
		chain: kairos,
		transport,
		account: facilitatorAccount,
	});

	const jpycAddress = getJpycAddress(kairos.id);

	console.log("=== M5-3 x402 self-facilitator E2E on Kaia Kairos ===\n");
	console.log("Chain:                  Kaia Kairos (1001)");
	console.log("RPC:                   ", rpcUrl);
	console.log("Payer EOA:             ", payer.address);
	console.log("Facilitator EOA:       ", facilitatorAccount.address);
	console.log("Recipient:             ", recipient);
	console.log("JPYC contract:         ", jpycAddress);
	console.log("Confirmations default: ", kairos.defaultConfirmations, "(IBFT immediate finality)");
	console.log("Amount per call:       ", amountHuman, "JPYC =", amount.toString(), "wei");

	const balanceOf = async (addr: Address): Promise<bigint> =>
		(await publicClient.readContract({
			address: jpycAddress,
			abi: jpycAbi,
			functionName: "balanceOf",
			args: [addr],
		})) as bigint;

	const payerJpycBefore = await balanceOf(payer.address);
	const recipientJpycBefore = await balanceOf(recipient);
	const facilitatorKaiaBefore = await publicClient.getBalance({
		address: facilitatorAccount.address,
	});

	console.log("\n--- Balances before ---");
	console.log("Payer JPYC:            ", payerJpycBefore.toString(), "wei");
	console.log("Recipient JPYC:        ", recipientJpycBefore.toString(), "wei");
	console.log("Facilitator KAIA:      ", facilitatorKaiaBefore.toString(), "wei");

	if (payerJpycBefore < amount) {
		console.error(`\n❌ Payer has insufficient JPYC. Need ${amount}, has ${payerJpycBefore}.`);
		console.error(`   Fund this address with JPYC on Kairos: ${payer.address}`);
		console.error(`   JPYC faucet: https://faucet.jpyc.co.jp/ (select Kaia / Kairos)`);
		process.exitCode = 1;
		return;
	}

	if (facilitatorKaiaBefore === 0n) {
		console.error(`\n❌ Facilitator has 0 KAIA — cannot pay gas to broadcast settlement.`);
		console.error(`   Fund this address with KAIA on Kairos: ${facilitatorAccount.address}`);
		console.error(`   Kaia faucet: https://faucet.kaia.io (select Kairos)`);
		process.exitCode = 1;
		return;
	}

	// Build the kawasekit server-side stack.
	const facilitator = createSelfFacilitator({
		network: "testnet",
		walletClient: facilitatorWallet,
		publicClient,
	});
	const requirements = buildPaymentRequirements({
		chainId: kairos.id,
		asset: jpycAddress,
		payTo: recipient,
		amount,
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

	// Bridge node:http ↔ WHATWG Request/Response so we can keep the handler pure.
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
	const signer = createX402PaymentSigner({
		network: "testnet",
		account: payer,
		asset: { kind: "known", id: "jpyc-v2" },
	});
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
			if (settlement.transaction && explorerBase) {
				console.log("← KaiaScan (Kairos):   ", `${explorerBase}/tx/${settlement.transaction}`);
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
	const facilitatorKaiaAfter = await publicClient.getBalance({
		address: facilitatorAccount.address,
	});
	console.log("Payer JPYC:            ", payerJpycAfter.toString(), "wei");
	console.log("Recipient JPYC:        ", recipientJpycAfter.toString(), "wei");
	console.log("Facilitator KAIA:      ", facilitatorKaiaAfter.toString(), "wei");
	console.log("Payer JPYC delta:      ", (payerJpycAfter - payerJpycBefore).toString(), "wei");
	console.log(
		"Recipient JPYC delta:  ",
		(recipientJpycAfter - recipientJpycBefore).toString(),
		"wei",
	);
	console.log(
		"Facilitator KAIA spent:",
		(facilitatorKaiaBefore - facilitatorKaiaAfter).toString(),
		"wei",
	);

	if (payer.address.toLowerCase() === recipient.toLowerCase()) {
		console.log("\n(Loop-back mode: JPYC returned to the same address; net JPYC delta = 0.)");
	}

	if (process.exitCode !== 1 && settlementTxHash !== null) {
		console.log("\n✅ M5-3 Kairos x402 self-facilitator E2E PASS — JPYC settled on Kaia Kairos.");
	}
}

main().catch((error: unknown) => {
	console.error("\nM5-3 kairos-x402-self-settle script failed:");
	console.error(error);
	process.exitCode = 1;
});
