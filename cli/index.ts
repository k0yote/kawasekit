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

// `.env` is loaded lazily by resolveValue / requireValue (cli/lib/env.ts),
// only when a command actually reads a value — so `--version` / `--help`
// never touch the filesystem or the environment.
//
// __KAWASEKIT_VERSION__ is replaced at build time by tsup's `define` (see
// tsup.config.ts) with the literal package.json version. When the CLI runs
// from un-built source (tsx, the cli-smoke tests) the identifier is undefined;
// the `typeof` guard avoids a ReferenceError and falls back to a dev marker.
declare const __KAWASEKIT_VERSION__: string;
const CLI_VERSION = typeof __KAWASEKIT_VERSION__ === "string" ? __KAWASEKIT_VERSION__ : "0.0.0-dev";

const program = new Command();
program
	.name("kawasekit")
	.description(
		"kawasekit — CLI for the kawasekit SDK (AI-agent stablecoin payments, Japan-first, JPYC-native).",
	)
	.version(CLI_VERSION);

registerInitCommand(program);
registerAccountCommand(program);
registerTransferCommand(program);
registerPolicyCommand(program);
registerSessionKeyCommand(program);

program.parseAsync().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
