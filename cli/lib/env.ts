/**
 * Environment loading helpers shared by every CLI command.
 *
 * The CLI loads `.env` from the current working directory (so a user can
 * `cd ~/my-agent-project && kawasekit transfer …` and have their secrets
 * picked up automatically) but every command also accepts the same value
 * as an explicit `--xxx` flag for ad-hoc use.
 */

import { config as loadDotenv } from "dotenv";
import type { Hex } from "viem";

let dotenvLoaded = false;

/**
 * Ensure `.env` from the current working directory has been merged into
 * `process.env`. Safe to call multiple times — subsequent calls are no-ops.
 */
export function ensureDotenvLoaded(): void {
	if (dotenvLoaded) return;
	// `quiet: true` suppresses dotenv v17's promotional "injecting env … (tip:
	// …)" banner — a CLI loading secrets should not print to stdout, and it
	// otherwise leaks onto `--version` / `--help` output.
	loadDotenv({ override: false, quiet: true });
	dotenvLoaded = true;
}

/**
 * Resolve a value that may come from either an explicit CLI flag or a
 * named environment variable. Returns the flag value if present, otherwise
 * the env value, otherwise `undefined`.
 */
export function resolveValue(flagValue: string | undefined, envName: string): string | undefined {
	if (flagValue !== undefined && flagValue.trim() !== "") return flagValue;
	ensureDotenvLoaded();
	const raw = process.env[envName];
	if (raw === undefined || raw.trim() === "") return undefined;
	return raw;
}

/**
 * Like {@link resolveValue} but throws a CLI-flavoured error if no value
 * was found. Use for inputs the command genuinely cannot proceed without.
 */
export function requireValue(flagValue: string | undefined, envName: string, hint: string): string {
	const value = resolveValue(flagValue, envName);
	if (value === undefined) {
		throw new Error(
			`Missing required value: pass --${hint} or set ${envName} in your environment / .env file.`,
		);
	}
	return value;
}

/**
 * Validates a value as a 0x-prefixed 32-byte hex private key and returns it
 * typed as `Hex`. Throws with a CLI-friendly message on malformed input.
 */
export function asPrivateKey(value: string, source: string): Hex {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
		throw new Error(
			`${source} must be a 0x-prefixed 32-byte hex string (got ${value.length} chars).`,
		);
	}
	return value as Hex;
}

/**
 * Resolves a required private key from a `--private-key` flag or an env var.
 */
export function requirePrivateKey(
	flagValue: string | undefined,
	envName: string,
	hint: string,
): Hex {
	return asPrivateKey(requireValue(flagValue, envName, hint), envName);
}
