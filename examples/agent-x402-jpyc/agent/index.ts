/**
 * agent-x402-jpyc — Mastra-driven LLM agent that pays the Hono paywall.
 *
 * Flow:
 *   1. Read env (payer PK, server URL, Anthropic key, budget).
 *   2. Build a kawasekit x402 signer bound to the payer EOA and wrap fetch.
 *   3. Define a `fetch_weather` Mastra tool that calls the wrapped fetch.
 *   4. Wire the tool into a Mastra Agent backed by Anthropic Claude.
 *   5. Send the user prompt; Claude decides which cities to look up.
 *   6. Each tool call triggers one JPYC payment via x402; we log the
 *      settlement tx and Polygonscan URL.
 *
 * Run alongside the server:
 *   pnpm dev:server  # one terminal
 *   pnpm dev:agent   # another terminal
 */

import "dotenv/config";

import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import {
	createX402PaymentSigner,
	decodePaymentResponseHeader,
	JPYC_DECIMALS,
	wrapFetch,
	X402_HEADER_PAYMENT_RESPONSE,
} from "kawasekit";
import { formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { createPkProvider } from "../lib/pk-provider";

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

const payerPkProvider = createPkProvider(
	optionalEnv("AGENT_PAYER_PK_URI") ?? "env://AGENT_PAYER_PRIVATE_KEY",
);
const payerPk = await payerPkProvider.getPk();
requireEnv("ANTHROPIC_API_KEY"); // surface missing key before we call Anthropic
const serverUrl = (optionalEnv("AGENT_SERVER_URL") ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const userPrompt =
	optionalEnv("AGENT_PROMPT") ??
	"What's the weather in Tokyo, Osaka, and Kyoto? Summarise each in one line, then give a one-sentence wrap-up.";
const modelId = optionalEnv("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
const budgetHuman = optionalEnv("AGENT_BUDGET_JPYC") ?? "0.01";
const budget = parseUnits(budgetHuman, JPYC_DECIMALS);

const payer = privateKeyToAccount(payerPk);
const signer = createX402PaymentSigner({
	network: "testnet",
	account: payer,
	asset: { kind: "known", id: "jpyc-v2" },
});

let spentWei = 0n;
const settlements: Array<{ city: string; tx: string; amount: string }> = [];

const fetch402 = wrapFetch({
	signer,
	onPayment: (requirements) => {
		const next = spentWei + BigInt(requirements.amount);
		if (next > budget) {
			console.warn(
				`  ⚠ skipping payment: would push spend to ${formatUnits(next, JPYC_DECIMALS)} JPYC, over budget ${budgetHuman} JPYC`,
			);
			return false;
		}
		return true;
	},
});

const fetchWeather = createTool({
	id: "fetch_weather",
	description:
		"Look up real-time weather for a city. Costs 0.001 JPYC per call, paid via x402 with kawasekit. Use this for any weather question.",
	inputSchema: z.object({
		city: z.string().describe("The city name to look up, e.g. 'Tokyo'"),
	}),
	outputSchema: z.object({
		city: z.string(),
		condition: z.string(),
		temperature_c: z.number(),
		asOf: z.string(),
	}),
	execute: async ({ city }) => {
		const cityEncoded = encodeURIComponent(city);
		console.log(`→ fetch_weather("${city}")`);
		const response = await fetch402(`${serverUrl}/weather/${cityEncoded}`);
		if (response.status !== 200) {
			const body = await response.text();
			throw new Error(`weather lookup failed (${response.status}): ${body.slice(0, 200)}`);
		}

		const settlementHeader = response.headers.get(X402_HEADER_PAYMENT_RESPONSE);
		if (settlementHeader) {
			const settlement = decodePaymentResponseHeader(settlementHeader);
			if (settlement.success && settlement.amount !== undefined) {
				spentWei += BigInt(settlement.amount);
				settlements.push({
					city,
					tx: settlement.transaction,
					amount: settlement.amount,
				});
				console.log(
					`  ↳ paid ${formatUnits(BigInt(settlement.amount), JPYC_DECIMALS)} JPYC  tx ${settlement.transaction}`,
				);
			}
		}

		const body = (await response.json()) as {
			city: string;
			condition: string;
			temperature_c: number;
			asOf: string;
		};
		return {
			city: body.city,
			condition: body.condition,
			temperature_c: body.temperature_c,
			asOf: body.asOf,
		};
	},
});

const agent = new Agent({
	id: "weather-agent",
	name: "weather-agent",
	instructions: [
		"You are a weather assistant.",
		"For any city the user mentions, call the `fetch_weather` tool to get real-time data.",
		"Then summarise the results in plain prose.",
		"Do NOT make up weather data — only use what the tool returns.",
	].join(" "),
	model: anthropic(modelId),
	tools: { fetch_weather: fetchWeather },
});

console.log("=== agent-x402-jpyc — Mastra weather agent ===");
console.log(`payer EOA:       ${payer.address}`);
console.log(`server:          ${serverUrl}`);
console.log(`Anthropic model: ${modelId}`);
console.log(`budget:          ${budgetHuman} JPYC (= ${budget.toString()} wei)`);
console.log(`prompt:          ${userPrompt}\n`);

const result = await agent.generate(userPrompt);

console.log("\n--- agent reply ---");
console.log(result.text);

console.log("\n--- payments summary ---");
if (settlements.length === 0) {
	console.log("(no JPYC payments settled)");
} else {
	for (const s of settlements) {
		console.log(
			`  ${s.city.padEnd(12)} ${formatUnits(BigInt(s.amount), JPYC_DECIMALS).padStart(8)} JPYC  https://amoy.polygonscan.com/tx/${s.tx}`,
		);
	}
	console.log(
		`  total:       ${formatUnits(spentWei, JPYC_DECIMALS).padStart(8)} JPYC of ${budgetHuman} budget`,
	);
}
