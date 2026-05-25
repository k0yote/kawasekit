/**
 * M3-1 — scripts/07-x402-self-settle.ts
 *
 * End-to-end x402 v2 paywall on Polygon Amoy using kawasekit's self-hosted
 * facilitator. Demonstrates one full payment cycle:
 *
 *   client (EOA, holds JPYC)
 *     → wrapFetch → 402 → sign EIP-3009 → retry with PAYMENT-SIGNATURE
 *   server (kawasekit createX402Handler)
 *     → createSelfFacilitator.verify → settle (broadcast `transferWithAuthorization`
 *       from facilitator EOA paying POL gas)
 *     → invoke inner handler → attach PAYMENT-RESPONSE
 *
 * Real JPYC moves from the payer's address to the recipient's address on Amoy.
 *
 * Required env:
 *   - OWNER_PRIVATE_KEY              EOA payer (signs EIP-3009; must hold JPYC)
 *   - X402_FACILITATOR_PRIVATE_KEY   EOA gas payer (broadcasts; must hold POL)
 *
 * Optional env:
 *   - X402_RECIPIENT          Default: OWNER address (loop-back, JPYC stays put)
 *   - X402_AMOUNT_HUMAN       Decimal JPYC per call. Default "0.01"
 *   - POLYGON_AMOY_RPC_URL    Override default https://rpc-amoy.polygon.technology
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
import { privateKeyToAccount } from "viem/accounts";
import {
	buildPaymentRequirements,
	createSelfFacilitator,
	createX402Handler,
	createX402PaymentSigner,
	decodePaymentResponseHeader,
	getJpycAddress,
	JPYC_DECIMALS,
	jpycAbi,
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

async function main(): Promise<void> {
	const payerPk = requirePrivateKey("OWNER_PRIVATE_KEY");
	const facilitatorPk = requirePrivateKey("X402_FACILITATOR_PRIVATE_KEY");
	const amountHuman = optionalEnv("X402_AMOUNT_HUMAN") ?? "0.01";
	const rpcUrl = optionalEnv("POLYGON_AMOY_RPC_URL") ?? polygonAmoy.rpcUrls.default.http[0];
	if (rpcUrl === undefined) {
		throw new Error("polygonAmoy.rpcUrls.default.http[0] is undefined; set POLYGON_AMOY_RPC_URL.");
	}

	const payer = privateKeyToAccount(payerPk);
	const facilitatorAccount = privateKeyToAccount(facilitatorPk);
	const recipientRaw = optionalEnv("X402_RECIPIENT");
	const recipient: Address = recipientRaw ? getAddress(recipientRaw) : payer.address;
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

	const transport = http(rpcUrl);
	const publicClient = createPublicClient({ chain: polygonAmoy, transport });
	const facilitatorWallet = createWalletClient({
		chain: polygonAmoy,
		transport,
		account: facilitatorAccount,
	});

	const jpycAddress = getJpycAddress(polygonAmoy.id);

	console.log("=== M3-1 x402 self-facilitator E2E on Polygon Amoy ===\n");
	console.log("Chain:                  Polygon Amoy (80002)");
	console.log("RPC:                   ", rpcUrl);
	console.log("Payer EOA:             ", payer.address);
	console.log("Facilitator EOA:       ", facilitatorAccount.address);
	console.log("Recipient:             ", recipient);
	console.log("JPYC contract:         ", jpycAddress);
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
		console.error(`   Polygon Amoy JPYC faucet: https://faucet.jpyc.co.jp/`);
		process.exitCode = 1;
		return;
	}

	if (facilitatorPolBefore === 0n) {
		console.error(`\n❌ Facilitator has 0 POL — cannot pay gas to broadcast settlement.`);
		console.error(`   Fund this address: ${facilitatorAccount.address}`);
		console.error(`   Polygon Amoy POL faucet: https://faucet.polygon.technology/`);
		process.exitCode = 1;
		return;
	}

	// Build the kawasekit server-side stack.
	const facilitator = createSelfFacilitator({
		walletClient: facilitatorWallet,
		publicClient,
	});
	const requirements = buildPaymentRequirements({
		chainId: polygonAmoy.id,
		asset: jpycAddress,
		payTo: recipient,
		amount,
		maxTimeoutSeconds: 300, // generous for Amoy bundler / RPC latency
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
	const signer = createX402PaymentSigner({ account: payer });
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
					"← Polygonscan (Amoy):  ",
					`https://amoy.polygonscan.com/tx/${settlement.transaction}`,
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
		console.log("\n✅ M3-1 self-facilitator E2E PASS — go for tasks 1.8 / 1.9 follow-on work.");
	}
}

main().catch((error: unknown) => {
	console.error("\nM3-1 x402-self-settle script failed:");
	console.error(error);
	process.exitCode = 1;
});
