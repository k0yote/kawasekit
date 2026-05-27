/**
 * Smoke tests for the kawasekit CLI.
 *
 * These tests spawn the CLI exactly as an operator would, via `tsx cli/index.ts`,
 * so they cover the same path that `pnpm cli …` does. They deliberately do
 * not touch any network — only commands that fail-fast on bad input or
 * compute pure output are exercised. End-to-end Polygon Amoy flows live
 * under scripts/ and the agent-x402-jpyc example.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = resolve(__dirname, "..", "..", "cli", "index.ts");

interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number | null;
}

/**
 * Runs the CLI from a fresh temp directory so dotenv never picks up the
 * repo's checked-in `.env`. Callers can override cwd when they need it
 * (e.g. the init tests verify file output in a specific tmpdir).
 */
function copyEnv(...names: readonly string[]): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const name of names) {
		const value = process.env[name];
		if (value !== undefined) out[name] = value;
	}
	return out;
}

function runCli(
	args: readonly string[],
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): RunResult {
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "kawasekit-cli-run-"));
	// Start from a minimal env so any env that .env at repo root would
	// inject does not leak through process.env into the spawn.
	const env: NodeJS.ProcessEnv = {
		...copyEnv("PATH", "HOME", "USER", "TMPDIR"),
		...options.env,
	};
	const result = spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

/**
 * Extracts the JSON object printed by a CLI command from a stdout blob.
 * Anchors on column-0 `{` ... column-0 `}` because that is what
 * `JSON.stringify(obj, null, 2)` emits, which lets us survive any wrapper
 * output (npm warnings, dotenv ad copy, …) that may surround the command's
 * own stdout under parallel test load.
 */
function extractJsonObject(stdout: string): unknown {
	const lines = stdout.split("\n");
	const startIdx = lines.findIndex((line) => line === "{");
	if (startIdx < 0) return undefined;
	const endIdx = lines.findIndex((line, idx) => idx > startIdx && line === "}");
	if (endIdx < 0) return undefined;
	const block = lines.slice(startIdx, endIdx + 1).join("\n");
	return JSON.parse(block);
}

describe("kawasekit CLI", () => {
	describe("--help", () => {
		it("prints the top-level help with every registered command", () => {
			const result = runCli(["--help"]);
			expect(result.status).toBe(0);
			const combined = result.stdout + result.stderr;
			expect(combined).toContain("kawasekit");
			expect(combined).toContain("init");
			expect(combined).toContain("account");
			expect(combined).toContain("transfer");
			expect(combined).toContain("policy");
			expect(combined).toContain("session-key");
		});
	});

	describe("init", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "kawasekit-cli-"));
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("writes .env.example to the current working directory", () => {
			const result = runCli(["init"], { cwd: tmpDir });
			expect(result.status).toBe(0);
			const targetPath = join(tmpDir, ".env.example");
			expect(existsSync(targetPath)).toBe(true);
			const contents = readFileSync(targetPath, "utf8");
			expect(contents).toContain("OWNER_PRIVATE_KEY");
			expect(contents).toContain("ZERODEV_PROJECT_ID");
		});

		it("does not overwrite an existing .env.example without --force", () => {
			const targetPath = join(tmpDir, ".env.example");
			// Pre-populate with a sentinel value
			runCli(["init"], { cwd: tmpDir });
			const original = readFileSync(targetPath, "utf8");
			const result = runCli(["init"], { cwd: tmpDir });
			expect(result.status).toBe(0);
			expect(result.stdout + result.stderr).toContain("--force");
			expect(readFileSync(targetPath, "utf8")).toBe(original);
		});
	});

	describe("policy create", () => {
		it("emits a JSON dry-run summary for the daily-limit policy", () => {
			const result = runCli([
				"policy",
				"create",
				"--chain",
				"polygonAmoy",
				"--max-per-tx",
				"50",
				"--max-per-day",
				"5",
			]);
			expect(result.status).toBe(0);
			const parsed = extractJsonObject(result.stdout) as {
				chain: string;
				maxPerTransfer: { human: string };
				maxTransfersPerDay: number;
				policyCount: number;
			};
			expect(parsed.chain).toContain("Polygon Amoy");
			expect(parsed.maxPerTransfer.human).toBe("50");
			expect(parsed.maxTransfersPerDay).toBe(5);
			expect(parsed.policyCount).toBeGreaterThan(0);
		});

		it("rejects an unknown chain", () => {
			const result = runCli(["policy", "create", "--chain", "ethereum", "--max-per-tx", "10"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("--chain");
		});
	});

	describe("mainnet broadcast guard", () => {
		it("refuses transfer on Polygon mainnet without KAWASEKIT_ALLOW_MAINNET=1", () => {
			const result = runCli(
				[
					"transfer",
					"--chain",
					"polygon",
					"--owner-private-key",
					"0x0000000000000000000000000000000000000000000000000000000000000001",
					"--zerodev-project-id",
					"test",
					"--amount",
					"0.001",
				],
				{
					env: {
						KAWASEKIT_ALLOW_MAINNET: undefined,
						OWNER_PRIVATE_KEY: undefined,
						ZERODEV_PROJECT_ID: undefined,
					},
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr + result.stdout).toContain("KAWASEKIT_ALLOW_MAINNET=1");
		});
	});

	describe("missing required input", () => {
		it("reports a clear error when --owner-private-key is missing and env unset", () => {
			const result = runCli(
				["account", "create", "--chain", "polygonAmoy", "--zerodev-project-id", "test"],
				{
					env: {
						OWNER_PRIVATE_KEY: undefined,
					},
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr + result.stdout).toMatch(/owner-private-key|OWNER_PRIVATE_KEY/);
		});
	});
});
