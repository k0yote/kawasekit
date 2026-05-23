/**
 * High-level helper: transfer JPYC from a Kernel smart account via a sponsored
 * UserOp.
 *
 * This is the canonical "agent payment" path for M2. The flow:
 * 1. Resolve the JPYC contract address for `kernelClient.chain`.
 * 2. Encode `JPYC.transfer(to, amount)` calldata.
 * 3. Wrap it as a Kernel call and submit via `sendUserOperation`.
 * 4. Wait for the bundler receipt and return both hashes.
 *
 * EIP-3009 `transferWithAuthorization` cannot be used here: JPYC's signature
 * verification is pure `ecrecover`, so a smart account cannot be `from`. See
 * `src/tokens/eip3009.ts` for the EOA-payer path.
 *
 * @packageDocumentation
 */

import type { KernelAccountClient } from "@zerodev/sdk";
import type { Address, Chain, Hex, Transport } from "viem";
import { encodeFunctionData, isAddress } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import { isSupportedChainId, type SupportedChainId } from "../chains";
import { getJpycAddress, jpycAbi } from "../tokens/jpyc";

/** A {@link KernelAccountClient} that is fully configured (chain + account). */
export type ConfiguredKernelClient = KernelAccountClient<Transport, Chain, SmartAccount>;

/** Parameters for {@link transferJpyc}. */
export interface TransferJpycParams {
	/** Recipient address. */
	readonly to: Address;
	/**
	 * Raw token amount in the token's smallest unit (JPYC has 18 decimals).
	 *
	 * @example
	 * ```ts
	 * import { parseUnits } from "viem";
	 * import { JPYC_DECIMALS } from "kawasekit";
	 *
	 * parseUnits("100", JPYC_DECIMALS); // 100 JPYC
	 * ```
	 */
	readonly amount: bigint;
	/**
	 * Optional. Defaults to waiting for the bundler receipt before returning.
	 * Set to `false` to return after the UserOp is submitted but before it
	 * lands on chain — useful when the caller wants to do its own polling.
	 */
	readonly waitForReceipt?: boolean;
}

/** Result of a {@link transferJpyc} call. */
export interface TransferJpycResult {
	readonly userOpHash: Hex;
	/** `null` when `waitForReceipt: false` was requested. */
	readonly transactionHash: Hex | null;
	/** `true` if the bundler receipt reported success; `null` if not awaited. */
	readonly success: boolean | null;
}

/** Thrown when {@link transferJpyc} is called with invalid arguments. */
export class TransferJpycInputError extends Error {
	constructor(message: string) {
		super(`transferJpyc: ${message}`);
		this.name = "TransferJpycInputError";
	}
}

/**
 * Transfer JPYC from the Kernel smart account to `to` via a sponsored UserOp.
 *
 * @example
 * ```ts
 * import { parseUnits } from "viem";
 * import { JPYC_DECIMALS, transferJpyc } from "kawasekit";
 *
 * const { userOpHash, transactionHash } = await transferJpyc(kernelClient, {
 *   to: "0xBeef0000000000000000000000000000DEADBEEF",
 *   amount: parseUnits("100", JPYC_DECIMALS),
 * });
 * ```
 */
export async function transferJpyc(
	kernelClient: ConfiguredKernelClient,
	params: TransferJpycParams,
): Promise<TransferJpycResult> {
	if (!isAddress(params.to, { strict: false })) {
		throw new TransferJpycInputError(`\`to\` is not a valid address: ${params.to}`);
	}
	if (params.amount <= 0n) {
		throw new TransferJpycInputError(`\`amount\` must be positive, got ${params.amount}.`);
	}

	const chainId = kernelClient.chain.id;
	if (!isSupportedChainId(chainId)) {
		throw new TransferJpycInputError(`Chain ID ${chainId} is not a kawasekit-supported chain.`);
	}
	const jpycAddress = getJpycAddress(chainId satisfies SupportedChainId);

	const data = encodeFunctionData({
		abi: jpycAbi,
		functionName: "transfer",
		args: [params.to, params.amount],
	});

	const callData = await kernelClient.account.encodeCalls([{ to: jpycAddress, value: 0n, data }]);

	const userOpHash = await kernelClient.sendUserOperation({ callData });

	if (params.waitForReceipt === false) {
		return { userOpHash, transactionHash: null, success: null };
	}

	const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
	return {
		userOpHash,
		transactionHash: receipt.receipt.transactionHash,
		success: receipt.success,
	};
}
