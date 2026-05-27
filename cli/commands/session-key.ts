import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
	createKernelAccount,
	createKernelAccountClient,
	createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { Command } from "commander";
import { createPublicClient, getAddress, type Hex, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	createJpycDailyLimitPolicies,
	getJpycAddress,
	issueSessionKey,
	JPYC_DECIMALS,
	type KawasekitSessionEnvelope,
	parseSessionEnvelope,
	restoreSessionAccount,
	revokeSessionKey,
	rotateSessionKey,
	serializeSessionEnvelope,
	zerodevRpcUrl,
} from "../../src";
import { assertMainnetGuard, type CliChainProfile, resolveChain } from "../lib/chain";
import { asPrivateKey, requirePrivateKey, requireValue } from "../lib/env";

interface PolicyFlags {
	readonly maxPerTx?: string;
	readonly maxPerDay?: string;
	readonly jpycAddress?: string;
}

function buildPolicies(
	profile: CliChainProfile,
	flags: PolicyFlags,
): ReturnType<typeof createJpycDailyLimitPolicies> {
	const jpycAddress = flags.jpycAddress
		? getAddress(flags.jpycAddress)
		: getJpycAddress(profile.chain.id);
	const maxPerTransfer = parseUnits(flags.maxPerTx ?? "100", JPYC_DECIMALS);
	const maxTransfersPerDay = Number.parseInt(flags.maxPerDay ?? "10", 10);
	return createJpycDailyLimitPolicies({
		jpycAddress,
		maxPerTransfer,
		maxTransfersPerDay,
	});
}

function generateEphemeralSessionKey(): Hex {
	return `0x${randomBytes(32).toString("hex")}` as Hex;
}

function loadEnvelope(envelopePath: string): KawasekitSessionEnvelope {
	const raw = readFileSync(resolve(process.cwd(), envelopePath), "utf8");
	return parseSessionEnvelope(raw);
}

// ---------------------------------------------------------------------------
// session-key issue
// ---------------------------------------------------------------------------

interface IssueOptions extends PolicyFlags {
	readonly chain?: string;
	readonly ownerPrivateKey?: string;
	readonly zerodevProjectId?: string;
	readonly sessionPrivateKey?: string;
	readonly ephemeralSession?: boolean;
	readonly output?: string;
}

async function runIssue(options: IssueOptions): Promise<void> {
	const profile = resolveChain(options.chain);
	const ownerKey = requirePrivateKey(
		options.ownerPrivateKey,
		"OWNER_PRIVATE_KEY",
		"owner-private-key",
	);
	const projectId = requireValue(
		options.zerodevProjectId,
		"ZERODEV_PROJECT_ID",
		"zerodev-project-id",
	);
	const sessionKey =
		options.ephemeralSession === true
			? generateEphemeralSessionKey()
			: asPrivateKey(
					requireValue(options.sessionPrivateKey, "SESSION_KEY_PRIVATE_KEY", "session-private-key"),
					"SESSION_KEY_PRIVATE_KEY",
				);
	const owner = privateKeyToAccount(ownerKey);
	const session = privateKeyToAccount(sessionKey);

	const rpcUrl = zerodevRpcUrl(profile.chain, projectId);
	const publicClient = createPublicClient({ chain: profile.chain, transport: http(rpcUrl) });
	const policies = buildPolicies(profile, options);

	const envelope = await issueSessionKey({
		publicClient,
		ownerSigner: owner,
		sessionKeySigner: session,
		policies,
		policySummary: {
			jpycAddress: options.jpycAddress
				? getAddress(options.jpycAddress)
				: getJpycAddress(profile.chain.id),
			maxPerTransfer: parseUnits(options.maxPerTx ?? "100", JPYC_DECIMALS),
			maxTransfersPerDay: Number.parseInt(options.maxPerDay ?? "10", 10),
		},
	});

	const wire = serializeSessionEnvelope(envelope);
	console.log("Chain:               ", profile.displayName);
	console.log("Owner (EOA):         ", owner.address);
	console.log(
		"Session key (EOA):   ",
		session.address,
		options.ephemeralSession === true ? "(fresh ephemeral, this run only)" : "",
	);
	console.log("Smart account:       ", envelope.smartAccountAddress);

	if (options.output !== undefined) {
		const outPath = resolve(process.cwd(), options.output);
		writeFileSync(outPath, wire, "utf8");
		console.log("Envelope written to: ", outPath);
	} else {
		console.log("\n--- envelope (JSON) ---");
		console.log(wire);
	}

	if (options.ephemeralSession === true) {
		console.log(
			"\n⚠️  The ephemeral session-key private key is NOT stored anywhere. Save it now if you need to restore later:",
		);
		console.log("    SESSION_KEY_PRIVATE_KEY=", sessionKey);
	}
}

// ---------------------------------------------------------------------------
// session-key restore
// ---------------------------------------------------------------------------

interface RestoreOptions {
	readonly chain?: string;
	readonly zerodevProjectId?: string;
	readonly sessionPrivateKey?: string;
	readonly envelope?: string;
}

async function runRestore(options: RestoreOptions): Promise<void> {
	const profile = resolveChain(options.chain);
	const projectId = requireValue(
		options.zerodevProjectId,
		"ZERODEV_PROJECT_ID",
		"zerodev-project-id",
	);
	const sessionKey = requirePrivateKey(
		options.sessionPrivateKey,
		"SESSION_KEY_PRIVATE_KEY",
		"session-private-key",
	);
	const envelopePath = requireValue(options.envelope, "KAWASEKIT_ENVELOPE_PATH", "envelope");
	const envelope = loadEnvelope(envelopePath);

	const rpcUrl = zerodevRpcUrl(profile.chain, projectId);
	const publicClient = createPublicClient({ chain: profile.chain, transport: http(rpcUrl) });

	const account = await restoreSessionAccount({
		publicClient,
		envelope,
		sessionKeySigner: privateKeyToAccount(sessionKey),
	});

	console.log("Chain:                  ", profile.displayName);
	console.log("Envelope chainId:       ", envelope.chainId);
	console.log("Envelope smart account: ", envelope.smartAccountAddress);
	console.log("Restored account:       ", account.address);
	if (getAddress(account.address) !== getAddress(envelope.smartAccountAddress)) {
		throw new Error(
			"Restored account address does not match the envelope's smart-account address.",
		);
	}
	console.log("\n✅ Envelope restored — the agent can now sign UserOps with the session key.");
}

// ---------------------------------------------------------------------------
// session-key revoke
// ---------------------------------------------------------------------------

interface RevokeOptions extends PolicyFlags {
	readonly chain?: string;
	readonly ownerPrivateKey?: string;
	readonly zerodevProjectId?: string;
	readonly sessionPrivateKey?: string;
	readonly envelope?: string;
}

async function runRevoke(options: RevokeOptions): Promise<void> {
	const profile = resolveChain(options.chain);
	assertMainnetGuard(profile);

	const ownerKey = requirePrivateKey(
		options.ownerPrivateKey,
		"OWNER_PRIVATE_KEY",
		"owner-private-key",
	);
	const projectId = requireValue(
		options.zerodevProjectId,
		"ZERODEV_PROJECT_ID",
		"zerodev-project-id",
	);
	const sessionKey = requirePrivateKey(
		options.sessionPrivateKey,
		"SESSION_KEY_PRIVATE_KEY",
		"session-private-key",
	);
	const envelopePath = requireValue(options.envelope, "KAWASEKIT_ENVELOPE_PATH", "envelope");
	const envelope = loadEnvelope(envelopePath);

	const owner = privateKeyToAccount(ownerKey);
	const session = privateKeyToAccount(sessionKey);
	const rpcUrl = zerodevRpcUrl(profile.chain, projectId);
	const publicClient = createPublicClient({ chain: profile.chain, transport: http(rpcUrl) });

	// Build a sudo-only kernel client — revoke MUST go through the ECDSA
	// validator, not the session-key permission validator. See SDK JSDoc in
	// src/session/revoke.ts.
	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;
	const sudoValidator = await signerToEcdsaValidator(publicClient, {
		signer: owner,
		entryPoint,
		kernelVersion,
	});
	const sudoAccount = await createKernelAccount(publicClient, {
		plugins: { sudo: sudoValidator },
		entryPoint,
		kernelVersion,
	});
	const paymasterClient = createZeroDevPaymasterClient({
		chain: profile.chain,
		transport: http(rpcUrl),
	});
	const ownerKernelClient = createKernelAccountClient({
		account: sudoAccount,
		chain: profile.chain,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	const policies = buildPolicies(profile, options);
	console.log("Chain:               ", profile.displayName);
	console.log("Owner (EOA):         ", owner.address);
	console.log("Session key (EOA):   ", session.address);
	console.log("Smart account:       ", envelope.smartAccountAddress);
	console.log("\nRevoking session validator (uninstallValidation)...");

	const result = await revokeSessionKey({
		ownerKernelClient,
		envelope,
		sessionKeySigner: session,
		policies,
	});
	console.log("userOp hash:    ", result.userOpHash);
	console.log("bundle tx hash: ", result.transactionHash);
	if (result.transactionHash) {
		console.log("explorer:       ", `${profile.explorerTxBase}${result.transactionHash}`);
	}
	if (!result.success) {
		throw new Error("Revoke UserOp reported failure.");
	}
}

// ---------------------------------------------------------------------------
// session-key rotate
// ---------------------------------------------------------------------------

interface RotateOptions extends PolicyFlags {
	readonly chain?: string;
	readonly ownerPrivateKey?: string;
	readonly zerodevProjectId?: string;
	readonly oldSessionPrivateKey?: string;
	readonly oldEnvelope?: string;
	readonly newSessionPrivateKey?: string;
	readonly ephemeralNewSession?: boolean;
	readonly output?: string;
}

async function runRotate(options: RotateOptions): Promise<void> {
	const profile = resolveChain(options.chain);
	assertMainnetGuard(profile);

	const ownerKey = requirePrivateKey(
		options.ownerPrivateKey,
		"OWNER_PRIVATE_KEY",
		"owner-private-key",
	);
	const projectId = requireValue(
		options.zerodevProjectId,
		"ZERODEV_PROJECT_ID",
		"zerodev-project-id",
	);
	const oldSessionKey = requirePrivateKey(
		options.oldSessionPrivateKey,
		"SESSION_KEY_PRIVATE_KEY",
		"old-session-private-key",
	);
	const oldEnvelopePath = requireValue(
		options.oldEnvelope,
		"KAWASEKIT_ENVELOPE_PATH",
		"old-envelope",
	);
	const oldEnvelope = loadEnvelope(oldEnvelopePath);

	const newSessionKey =
		options.ephemeralNewSession === true
			? generateEphemeralSessionKey()
			: asPrivateKey(
					requireValue(
						options.newSessionPrivateKey,
						"SESSION_KEY_PRIVATE_KEY_NEW",
						"new-session-private-key",
					),
					"new session private key",
				);

	const owner = privateKeyToAccount(ownerKey);
	const oldSession = privateKeyToAccount(oldSessionKey);
	const newSession = privateKeyToAccount(newSessionKey);

	const rpcUrl = zerodevRpcUrl(profile.chain, projectId);
	const publicClient = createPublicClient({ chain: profile.chain, transport: http(rpcUrl) });
	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;
	const sudoValidator = await signerToEcdsaValidator(publicClient, {
		signer: owner,
		entryPoint,
		kernelVersion,
	});
	const sudoAccount = await createKernelAccount(publicClient, {
		plugins: { sudo: sudoValidator },
		entryPoint,
		kernelVersion,
	});
	const paymasterClient = createZeroDevPaymasterClient({
		chain: profile.chain,
		transport: http(rpcUrl),
	});
	const ownerKernelClient = createKernelAccountClient({
		account: sudoAccount,
		chain: profile.chain,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});

	const policies = buildPolicies(profile, options);
	const policySummary = {
		jpycAddress: options.jpycAddress
			? getAddress(options.jpycAddress)
			: getJpycAddress(profile.chain.id),
		maxPerTransfer: parseUnits(options.maxPerTx ?? "100", JPYC_DECIMALS),
		maxTransfersPerDay: Number.parseInt(options.maxPerDay ?? "10", 10),
	};

	console.log("Chain:                   ", profile.displayName);
	console.log("Owner (EOA):             ", owner.address);
	console.log("Old session key (EOA):   ", oldSession.address);
	console.log("New session key (EOA):   ", newSession.address);
	console.log("Smart account:           ", oldEnvelope.smartAccountAddress);
	console.log("\nRotating: revoke old → issue new (awaits revoke receipt)...");

	const { revoke, envelope } = await rotateSessionKey({
		revoke: {
			ownerKernelClient,
			envelope: oldEnvelope,
			sessionKeySigner: oldSession,
			policies,
		},
		issue: {
			publicClient,
			ownerSigner: owner,
			sessionKeySigner: newSession,
			policies,
			policySummary,
		},
	});
	console.log("revoke userOp hash:   ", revoke.userOpHash);
	console.log("revoke bundle tx:     ", revoke.transactionHash);
	if (revoke.transactionHash) {
		console.log("revoke explorer:      ", `${profile.explorerTxBase}${revoke.transactionHash}`);
	}
	if (!revoke.success) {
		throw new Error("Revoke step failed — new envelope was NOT issued.");
	}

	const wire = serializeSessionEnvelope(envelope);
	if (options.output !== undefined) {
		const outPath = resolve(process.cwd(), options.output);
		writeFileSync(outPath, wire, "utf8");
		console.log("\nNew envelope written: ", outPath);
	} else {
		console.log("\n--- new envelope (JSON) ---");
		console.log(wire);
	}
	if (options.ephemeralNewSession === true) {
		console.log(
			"\n⚠️  The new ephemeral session-key private key is NOT stored anywhere. Save it now if you need to restore later:",
		);
		console.log("    SESSION_KEY_PRIVATE_KEY=", newSessionKey);
	}
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSessionKeyCommand(program: Command): void {
	const sessionKey = program
		.command("session-key")
		.description("Issue / restore / revoke / rotate agent session keys");

	sessionKey
		.command("issue")
		.description("Owner issues a session-key envelope for the agent")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--owner-private-key <hex>", "Owner EOA private key (or env OWNER_PRIVATE_KEY)")
		.option("--zerodev-project-id <id>", "ZeroDev project ID (or env ZERODEV_PROJECT_ID)")
		.option(
			"--session-private-key <hex>",
			"Session EOA private key (or env SESSION_KEY_PRIVATE_KEY)",
		)
		.option(
			"--ephemeral-session",
			"Generate a fresh ephemeral session key for this run (use for production rotation; printed at end, never stored automatically)",
		)
		.option("--max-per-tx <human>", 'Per-transfer cap in decimal JPYC. Default "100".')
		.option("--max-per-day <count>", 'Maximum transfers per 24h window. Default "10".')
		.option(
			"--jpyc-address <address>",
			"JPYC contract override. Defaults to the canonical kawasekit address.",
		)
		.option("--output <path>", "Write the envelope JSON to this path instead of stdout.")
		.action(async (options: IssueOptions) => {
			await runIssue(options);
		});

	sessionKey
		.command("restore")
		.description("Agent restores a smart-account client from an envelope file")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--zerodev-project-id <id>", "ZeroDev project ID (or env ZERODEV_PROJECT_ID)")
		.option(
			"--session-private-key <hex>",
			"Session EOA private key (or env SESSION_KEY_PRIVATE_KEY)",
		)
		.option("--envelope <path>", "Path to the envelope JSON file")
		.action(async (options: RestoreOptions) => {
			await runRestore(options);
		});

	sessionKey
		.command("revoke")
		.description("Owner revokes a session key by uninstalling its permission validator")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--owner-private-key <hex>", "Owner EOA private key (or env OWNER_PRIVATE_KEY)")
		.option("--zerodev-project-id <id>", "ZeroDev project ID (or env ZERODEV_PROJECT_ID)")
		.option("--session-private-key <hex>", "Session EOA private key the validator was issued under")
		.option("--envelope <path>", "Path to the envelope JSON file to revoke")
		.option(
			"--max-per-tx <human>",
			'Per-transfer cap (must match issue-time value). Default "100".',
		)
		.option(
			"--max-per-day <count>",
			'Daily transfer count (must match issue-time value). Default "10".',
		)
		.option("--jpyc-address <address>", "JPYC contract override.")
		.action(async (options: RevokeOptions) => {
			await runRevoke(options);
		});

	sessionKey
		.command("rotate")
		.description("Revoke the old session and issue a new one in one shot (atomic-ish)")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--owner-private-key <hex>", "Owner EOA private key (or env OWNER_PRIVATE_KEY)")
		.option("--zerodev-project-id <id>", "ZeroDev project ID (or env ZERODEV_PROJECT_ID)")
		.option(
			"--old-session-private-key <hex>",
			"Old session-key private key (or env SESSION_KEY_PRIVATE_KEY)",
		)
		.option("--old-envelope <path>", "Path to the old envelope JSON file")
		.option(
			"--new-session-private-key <hex>",
			"New session-key private key (or env SESSION_KEY_PRIVATE_KEY_NEW)",
		)
		.option(
			"--ephemeral-new-session",
			"Generate a fresh ephemeral new session key for this rotation",
		)
		.option("--max-per-tx <human>", 'Per-transfer cap (same for old + new). Default "100".')
		.option("--max-per-day <count>", 'Daily transfer count (same for old + new). Default "10".')
		.option("--jpyc-address <address>", "JPYC contract override.")
		.option("--output <path>", "Write the new envelope JSON to this path.")
		.action(async (options: RotateOptions) => {
			await runRotate(options);
		});
}
