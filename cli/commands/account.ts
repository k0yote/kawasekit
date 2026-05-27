import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
	createKernelAccount,
	createKernelAccountClient,
	createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { Command } from "commander";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { zerodevRpcUrl } from "../../src";
import { assertMainnetGuard, resolveChain } from "../lib/chain";
import { requirePrivateKey, requireValue } from "../lib/env";

interface AccountCreateOptions {
	readonly chain?: string;
	readonly ownerPrivateKey?: string;
	readonly zerodevProjectId?: string;
	readonly deploy?: boolean;
}

async function runAccountCreate(options: AccountCreateOptions): Promise<void> {
	const profile = resolveChain(options.chain);
	if (options.deploy === true) {
		assertMainnetGuard(profile);
	}

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

	const owner = privateKeyToAccount(ownerKey);
	const rpcUrl = zerodevRpcUrl(profile.chain, projectId);
	const publicClient = createPublicClient({ chain: profile.chain, transport: http(rpcUrl) });

	const entryPoint = getEntryPoint("0.7");
	const kernelVersion = KERNEL_V3_1;
	const sudoValidator = await signerToEcdsaValidator(publicClient, {
		signer: owner,
		entryPoint,
		kernelVersion,
	});
	const account = await createKernelAccount(publicClient, {
		plugins: { sudo: sudoValidator },
		entryPoint,
		kernelVersion,
	});

	console.log("Chain:                 ", profile.displayName);
	console.log("Owner (EOA):           ", owner.address);
	console.log("Smart account address: ", account.address);

	if (options.deploy !== true) {
		console.log(
			"\n(counterfactual — pass --deploy to broadcast a sponsored UserOp that deploys the account.)",
		);
		return;
	}

	console.log("\nDeploying via a sponsored self-call UserOp...");
	const paymasterClient = createZeroDevPaymasterClient({
		chain: profile.chain,
		transport: http(rpcUrl),
	});
	const kernelClient = createKernelAccountClient({
		account,
		chain: profile.chain,
		client: publicClient,
		bundlerTransport: http(rpcUrl),
		paymaster: {
			getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
		},
	});
	const userOpHash = await kernelClient.sendUserOperation({
		callData: await account.encodeCalls([{ to: account.address, value: 0n, data: "0x" }]),
	});
	console.log("userOp hash:           ", userOpHash);
	const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
	const txHash = receipt.receipt.transactionHash;
	console.log("bundle tx hash:        ", txHash);
	console.log("explorer:              ", `${profile.explorerTxBase}${txHash}`);
}

export function registerAccountCommand(program: Command): void {
	const account = program.command("account").description("Smart-account lifecycle commands");

	account
		.command("create")
		.description("Compute (or deploy) the smart-account address for an owner key")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--owner-private-key <hex>", "Owner EOA private key (or env OWNER_PRIVATE_KEY)")
		.option("--zerodev-project-id <id>", "ZeroDev project ID (or env ZERODEV_PROJECT_ID)")
		.option(
			"--deploy",
			"Broadcast a sponsored self-call UserOp that deploys the account (mainnet requires KAWASEKIT_ALLOW_MAINNET=1)",
		)
		.action(async (options: AccountCreateOptions) => {
			await runAccountCreate(options);
		});
}
