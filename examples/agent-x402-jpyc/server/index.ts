/**
 * agent-x402-jpyc — Hono paywall server.
 *
 * Paywalls `GET /weather/:city` behind a JPYC x402 v2 payment using
 * kawasekit's self-facilitator on Polygon Amoy. Listens on $PORT (default
 * 8787). Other routes are free.
 *
 * Run with:
 *   cp .env.example .env  # fill in keys
 *   pnpm dev:server
 */

import "dotenv/config";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
	buildPaymentRequirements,
	createSelfFacilitator,
	getJpycAddress,
	JPYC_DECIMALS,
	polygonAmoy,
	type X402HandlerContext,
	type X402PaymentRequirements,
} from "kawasekit";
import { type X402HonoEnv, x402Middleware } from "kawasekit/x402/hono";
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

const facilitatorPk = requirePrivateKey("X402_FACILITATOR_PRIVATE_KEY");
const recipient: Address = getAddress(requireEnv("X402_RECIPIENT"));
const priceHuman = optionalEnv("PRICE_JPYC") ?? "0.001";
const port = Number.parseInt(optionalEnv("PORT") ?? "8787", 10);
const rpcUrl = optionalEnv("POLYGON_AMOY_RPC_URL") ?? polygonAmoy.rpcUrls.default.http[0];
if (rpcUrl === undefined) {
	throw new Error("polygonAmoy.rpcUrls.default.http[0] is undefined; set POLYGON_AMOY_RPC_URL.");
}

// `nonceManager` makes the facilitator EOA safe for concurrent settle()
// calls — the LLM agent fans out 3+ fetch_weather tools in parallel, and
// without local nonce sequencing all of those settle UserOps would race for
// the same on-chain nonce and only one would land.
const facilitatorAccount = privateKeyToAccount(facilitatorPk, { nonceManager });
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: polygonAmoy, transport });
const facilitatorWallet = createWalletClient({
	chain: polygonAmoy,
	transport,
	account: facilitatorAccount,
});

const jpycAddress = getJpycAddress(polygonAmoy.id);
const price = parseUnits(priceHuman, JPYC_DECIMALS);

const facilitator = createSelfFacilitator({
	walletClient: facilitatorWallet,
	publicClient,
});

const requirements: X402PaymentRequirements = buildPaymentRequirements({
	chainId: polygonAmoy.id,
	asset: jpycAddress,
	payTo: recipient,
	amount: price,
	maxTimeoutSeconds: 300, // Amoy bundler latency
});

const app = new Hono<X402HonoEnv>();

// Free routes — useful for health checks and discovery.
app.get("/", (c) =>
	c.json({
		service: "agent-x402-jpyc",
		paywalled: "/weather/:city",
		price: `${priceHuman} JPYC`,
		network: "polygon-amoy",
		jpyc: jpycAddress,
		facilitator: facilitatorAccount.address,
		recipient,
	}),
);

// Paid route — exact-EVM EIP-3009 settlement gates the response.
app.use(
	"/weather/*",
	x402Middleware({
		facilitator,
		requirementsFor: () => [requirements],
	}),
);
app.get("/weather/:city", (c) => {
	const city = c.req.param("city");
	const ctx = c.get("x402") as X402HandlerContext | undefined;
	const tx = ctx?.settlement.transaction;

	// In a real service you'd fetch from a weather API here. The point of
	// the demo is the payment flow, not the data.
	const weather = {
		city,
		temperature_c: 22 + Math.floor(Math.random() * 8) - 4,
		condition: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)] ?? "sunny",
		asOf: new Date().toISOString(),
	};

	if (tx) {
		console.log(`  ↳ paid ${priceHuman} JPYC by ${ctx?.settlement.payer ?? "?"} | tx ${tx}`);
	}

	return c.json({
		...weather,
		payment: tx
			? {
					tx,
					polygonscan: `https://amoy.polygonscan.com/tx/${tx}`,
					amount: `${priceHuman} JPYC`,
				}
			: null,
	});
});

console.log(`agent-x402-jpyc paywall server`);
console.log(`  facilitator EOA:  ${facilitatorAccount.address}`);
console.log(`  recipient:        ${recipient}`);
console.log(`  price per call:   ${priceHuman} JPYC (= ${price.toString()} wei)`);
console.log(`  JPYC contract:    ${jpycAddress}`);
console.log(`  RPC:              ${rpcUrl}`);
console.log(`  listening on:     http://127.0.0.1:${port}`);
console.log(`  paywalled route:  GET /weather/:city`);

serve({ fetch: app.fetch, port });
