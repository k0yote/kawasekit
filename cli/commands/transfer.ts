import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
	createKernelAccount,
	createKernelAccountClient,
	createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { Command } from "commander";
import { type Address, createPublicClient, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getJpycAddress, JPYC_DECIMALS, jpycAbi, transferJpyc, zerodevRpcUrl } from "../../src";
import { assertMainnetGuard, resolveChain } from "../lib/chain";
import { requirePrivateKey, requireValue, resolveValue } from "../lib/env";

interface TransferOptions {
	readonly chain?: string;
	readonly ownerPrivateKey?: string;
	readonly zerodevProjectId?: string;
	readonly to?: string;
	readonly amount?: string;
}

async function runTransfer(options: TransferOptions): Promise<void> {
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
	const amountHuman = options.amount ?? resolveValue(undefined, "JPYC_AMOUNT_HUMAN") ?? "1";
	const amount = parseUnits(amountHuman, JPYC_DECIMALS);

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

	const jpycAddress = getJpycAddress(profile.chain.id);
	const balance = (await publicClient.readContract({
		address: jpycAddress,
		abi: jpycAbi,
		functionName: "balanceOf",
		args: [account.address],
	})) as bigint;

	const recipientRaw = options.to ?? resolveValue(undefined, "JPYC_RECIPIENT") ?? account.address;
	const recipient: Address = getAddress(recipientRaw);

	console.log("Chain:          ", profile.displayName);
	console.log("Owner (EOA):    ", owner.address);
	console.log("Smart account:  ", account.address);
	console.log("JPYC contract:  ", jpycAddress);
	console.log("Smart-account JPYC balance:", balance.toString(), "wei");
	console.log("Recipient:      ", recipient);
	console.log("Amount:         ", amountHuman, "JPYC =", amount.toString(), "wei");

	if (amount === 0n) {
		throw new Error("--amount must be greater than 0.");
	}
	if (balance < amount) {
		throw new Error(
			`Smart account has insufficient JPYC. Need ${amount.toString()} wei, has ${balance.toString()} wei. Fund ${account.address} before retrying.`,
		);
	}

	console.log(`\nSending ${amountHuman} JPYC via sponsored UserOp...`);
	const result = await transferJpyc(kernelClient, { to: recipient, amount });
	console.log("userOp hash:    ", result.userOpHash);
	console.log("bundle tx hash: ", result.transactionHash);
	if (result.transactionHash) {
		console.log("explorer:       ", `${profile.explorerTxBase}${result.transactionHash}`);
	}
	if (!result.success) {
		throw new Error("UserOp reported failure — see explorer for revert reason.");
	}
}

export function registerTransferCommand(program: Command): void {
	program
		.command("transfer")
		.description("Send JPYC from a smart account via a sponsored UserOp")
		.requiredOption("--chain <chain>", '"polygon" | "polygonAmoy"')
		.option("--owner-private-key <hex>", "Owner EOA private key (or env OWNER_PRIVATE_KEY)")
		.option("--zerodev-project-id <id>", "ZeroDev project ID (or env ZERODEV_PROJECT_ID)")
		.option(
			"--to <address>",
			"Recipient address. Defaults to the smart account itself (loop-back) when unset.",
		)
		.option("--amount <human>", 'Amount in decimal JPYC (e.g. 0.001). Default "1".')
		.action(async (options: TransferOptions) => {
			await runTransfer(options);
		});
}
