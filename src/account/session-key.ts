/**
 * Agent smart account = Kernel v3.1 + ECDSA sudo validator + session-key
 * permission validator.
 *
 * The owner EOA keeps full control (sudo) and can revoke / rotate the session
 * key at any time. The session key is the day-to-day signer the AI agent
 * holds; whatever policies you attach (see {@link createJpycDailyLimitPolicies})
 * are enforced at the ERC-4337 validation phase by ZeroDev's
 * `PermissionValidator`. Violating userOps revert before execution — they
 * never spend any of the smart account's funds, and a sponsored bundler
 * cannot be tricked into paying for them either.
 *
 * @packageDocumentation
 */

import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import type { Policy } from "@zerodev/permissions";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import type { CreateKernelAccountReturnType } from "@zerodev/sdk";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { EntryPointType, GetKernelVersion } from "@zerodev/sdk/types";
import type { Chain, LocalAccount, PublicClient, Transport } from "viem";

/** Parameters for {@link createAgentSmartAccount}. */
export interface CreateAgentSmartAccountParams {
	/**
	 * viem `PublicClient` used to read on-chain state during account derivation.
	 */
	readonly publicClient: PublicClient<Transport, Chain | undefined>;
	/**
	 * The owner EOA. Retains sudo authority — can install new plugins,
	 * revoke / rotate the session key, and bypass any policy.
	 */
	readonly ownerSigner: LocalAccount;
	/**
	 * The day-to-day signer the agent holds. Authority is limited to whatever
	 * `policies` allow — by default it can do nothing.
	 */
	readonly sessionKeySigner: LocalAccount;
	/**
	 * ZeroDev policies (e.g. {@link createJpycDailyLimitPolicies}) the session
	 * key must satisfy at userOp validation time.
	 */
	readonly policies: readonly Policy[];
	/**
	 * EntryPoint version + address. Defaults to v0.7 at the canonical
	 * ERC-4337 entry-point address.
	 */
	readonly entryPoint?: EntryPointType<"0.7">;
	/** Kernel version. Defaults to {@link KERNEL_V3_1}. */
	readonly kernelVersion?: GetKernelVersion<"0.7">;
}

/**
 * Builds a Kernel v3.1 smart account with sudo (owner) + regular (session key)
 * validators wired up.
 *
 * @example
 * ```ts
 * import { parseUnits } from "viem";
 * import { privateKeyToAccount } from "viem/accounts";
 * import {
 *   createAgentSmartAccount,
 *   createJpycDailyLimitPolicies,
 *   getJpycAddress,
 *   JPYC_DECIMALS,
 *   polygonAmoy,
 * } from "kawasekit";
 *
 * const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as `0x${string}`);
 * const sessionKey = privateKeyToAccount(process.env.SESSION_KEY_PRIVATE_KEY as `0x${string}`);
 *
 * const account = await createAgentSmartAccount({
 *   publicClient,
 *   ownerSigner: owner,
 *   sessionKeySigner: sessionKey,
 *   policies: createJpycDailyLimitPolicies({
 *     jpycAddress: getJpycAddress(polygonAmoy.id),
 *     maxPerTransfer: parseUnits("100", JPYC_DECIMALS),
 *     maxTransfersPerDay: 10,
 *   }),
 * });
 * ```
 */
export async function createAgentSmartAccount(
	params: CreateAgentSmartAccountParams,
): Promise<CreateKernelAccountReturnType<"0.7">> {
	const entryPoint = params.entryPoint ?? getEntryPoint("0.7");
	const kernelVersion = params.kernelVersion ?? KERNEL_V3_1;

	const sudoValidator = await signerToEcdsaValidator(params.publicClient, {
		signer: params.ownerSigner,
		entryPoint,
		kernelVersion,
	});

	const modularSessionSigner = await toECDSASigner({ signer: params.sessionKeySigner });

	const permissionValidator = await toPermissionValidator(params.publicClient, {
		signer: modularSessionSigner,
		policies: [...params.policies],
		entryPoint,
		kernelVersion,
	});

	return createKernelAccount(params.publicClient, {
		plugins: {
			sudo: sudoValidator,
			regular: permissionValidator,
		},
		entryPoint,
		kernelVersion,
	});
}
