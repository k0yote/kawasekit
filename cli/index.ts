#!/usr/bin/env node

/**
 * kawasekit CLI entry.
 *
 * Subcommands:
 *   init                              — scaffold .env.example
 *   account create                    — derive / deploy a smart account
 *   transfer                          — send JPYC via sponsored UserOp
 *   policy create                     — dry-run the daily-limit policy
 *   session-key issue|restore|revoke|rotate
 *                                     — agent session-key lifecycle
 *
 * Every subcommand that touches a network requires `--chain polygon|polygonAmoy`.
 * Mainnet broadcasts additionally require `KAWASEKIT_ALLOW_MAINNET=1` in the
 * environment.
 */

import { Command } from "commander";
import { registerAccountCommand } from "./commands/account";
import { registerInitCommand } from "./commands/init";
import { registerPolicyCommand } from "./commands/policy";
import { registerSessionKeyCommand } from "./commands/session-key";
import { registerTransferCommand } from "./commands/transfer";
import { ensureDotenvLoaded } from "./lib/env";

// Replaced at build time by tsup's `define` (see tsup.config.ts) with the
// literal package.json version. Declared here so `tsc --noEmit` typechecks.
declare const __KAWASEKIT_VERSION__: string;

ensureDotenvLoaded();

const program = new Command();
program
	.name("kawasekit")
	.description(
		"kawasekit — CLI for the kawasekit SDK (AI-agent stablecoin payments, Japan-first, JPYC-native).",
	)
	.version(__KAWASEKIT_VERSION__);

registerInitCommand(program);
registerAccountCommand(program);
registerTransferCommand(program);
registerPolicyCommand(program);
registerSessionKeyCommand(program);

program.parseAsync().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
