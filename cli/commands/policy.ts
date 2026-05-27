import type { Command } from "commander";
import { getAddress, parseUnits } from "viem";
import { createJpycDailyLimitPolicies, getJpycAddress, JPYC_DECIMALS } from "../../src";
import { resolveChain } from "../lib/chain";

interface PolicyCreateOptions {
	readonly chain?: string;
	readonly maxPerTx?: string;
	readonly maxPerDay?: string;
	readonly jpycAddress?: string;
}

function parsePositiveInt(value: string, label: string): number {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}.`);
	}
	return n;
}

async function runPolicyCreate(options: PolicyCreateOptions): Promise<void> {
	const profile = resolveChain(options.chain);
	const maxPerTxHuman = options.maxPerTx ?? "100";
	const maxPerDay = parsePositiveInt(options.maxPerDay ?? "10", "--max-per-day");
	const maxPerTransfer = parseUnits(maxPerTxHuman, JPYC_DECIMALS);

	const jpycAddress = options.jpycAddress
		? getAddress(options.jpycAddress)
		: getJpycAddress(profile.chain.id);

	// Build the actual policy array — this validates the inputs end-to-end
	// using the same path the SDK will at issue time, so a `policy create`
	// dry-run catches malformed inputs before the operator commits to issuing.
	const policies = createJpycDailyLimitPolicies({
		jpycAddress,
		maxPerTransfer,
		maxTransfersPerDay: maxPerDay,
	});

	const summary = {
		chain: profile.displayName,
		jpycAddress,
		maxPerTransfer: {
			human: maxPerTxHuman,
			wei: maxPerTransfer.toString(),
		},
		maxTransfersPerDay: maxPerDay,
		policyCount: policies.length,
		note: "Dry-run. No on-chain action taken. Use `kawasekit session-key issue` with the same --max-per-tx / --max-per-day to install these on a session validator.",
	};

	console.log(JSON.stringify(summary, null, 2));
}

export function registerPolicyCommand(program: Command): void {
	const policy = program.command("policy").description("Policy builder + inspector");
	policy
		.command("create")
		.description("Dry-run the daily-limit policy and print the resolved parameters as JSON")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--max-per-tx <human>", 'Per-transfer cap in decimal JPYC. Default "100".')
		.option("--max-per-day <count>", 'Maximum transfers per 24h window. Default "10".')
		.option(
			"--jpyc-address <address>",
			"JPYC contract address override. Defaults to the canonical kawasekit address for the chosen chain.",
		)
		.action(async (options: PolicyCreateOptions) => {
			await runPolicyCreate(options);
		});
}
