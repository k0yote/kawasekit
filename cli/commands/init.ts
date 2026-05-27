import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";

/**
 * `kawasekit init` — writes a starter `.env.example` into the current
 * working directory and prints next steps. Idempotent unless `--force`.
 *
 * The starter env is intentionally narrow: only the variables a brand-new
 * kawasekit consumer needs to follow the README quick-start. Operators add
 * additional vars (X402_*, KAWASEKIT_X402_CHAIN, KAWASEKIT_ALLOW_MAINNET, …)
 * as they reach those sections of the docs.
 */
const STARTER_ENV_EXAMPLE = `# kawasekit — environment variables
#
# Copy this file to \`.env\` and fill in real values:
#   cp .env.example .env
#
# NEVER commit the real \`.env\` file. It is gitignored on purpose.

# Private key of the smart-account OWNER (the EOA signer).
# 0x-prefixed 32-byte hex. Use a throwaway testnet key for testnet work.
OWNER_PRIVATE_KEY=0x...

# ZeroDev project ID. Create a project at https://dashboard.zerodev.app
# and copy its ID here. Used for bundler + paymaster sponsorship.
ZERODEV_PROJECT_ID=

# Recipient of the test transfer. Defaults to the smart account itself.
# JPYC_RECIPIENT=0x...
`;

interface InitOptions {
	readonly force?: boolean;
}

async function runInit(options: InitOptions): Promise<void> {
	const targetPath = resolve(process.cwd(), ".env.example");
	const alreadyExists = existsSync(targetPath);
	if (alreadyExists && options.force !== true) {
		console.log(`.env.example already exists at ${targetPath} — pass --force to overwrite.`);
		console.log(`Next: copy it to .env and fill in the required values.`);
		return;
	}
	writeFileSync(targetPath, STARTER_ENV_EXAMPLE, "utf8");
	console.log(`${alreadyExists ? "Overwrote" : "Wrote"} ${targetPath}`);
	console.log(`Next: copy it to .env (cp .env.example .env) and fill in the required values.`);
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Scaffold a starter .env.example in the current directory")
		.option("--force", "Overwrite an existing .env.example")
		.action(async (options: InitOptions) => {
			await runInit(options);
		});
}
