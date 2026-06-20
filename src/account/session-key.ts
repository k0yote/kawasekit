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
import type { CreateKernelAccountReturnType, KernelValidator } from "@zerodev/sdk";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { EntryPointType, GetKernelVersion } from "@zerodev/sdk/types";
import type { Address, Chain, Client, LocalAccount, PublicClient, Transport } from "viem";

/**
 * Owner = ECDSA convenience XOR a pre-built sudo validator (weighted / passkey / MPC).
 *
 * @remarks Pass a pre-built validator via `sudoValidator`, never via `ownerSigner`.
 * Because ZeroDev's `KernelValidator` structurally extends `LocalAccount`, a validator
 * mis-passed in the `ownerSigner` slot type-checks and would be wrapped as an ECDSA
 * signer (confusing downstream failure) rather than used as the sudo directly.
 */
export type AgentOwner =
	| { readonly ownerSigner: LocalAccount; readonly sudoValidator?: never }
	| { readonly sudoValidator: KernelValidator; readonly ownerSigner?: never };

/**
 * Resolve the sudo validator: a caller-injected `sudoValidator`, or the ECDSA
 * convenience path from `ownerSigner`. Throws (before any chain access) if both
 * or neither is supplied — the runtime guard behind the {@link AgentOwner} union.
 */
export async function resolveSudoValidator(params: {
	readonly publicClient: PublicClient<Transport, Chain | undefined>;
	// `| undefined` (not just `?`) so callers may forward the `AgentOwner` union's
	// inactive arm verbatim under `exactOptionalPropertyTypes`.
	readonly ownerSigner?: LocalAccount | undefined;
	readonly sudoValidator?: KernelValidator | undefined;
	readonly entryPoint: EntryPointType<"0.7">;
	readonly kernelVersion: GetKernelVersion<"0.7">;
}): Promise<KernelValidator> {
	if (params.ownerSigner !== undefined && params.sudoValidator !== undefined) {
		throw new Error("kawasekit: pass exactly one of `ownerSigner` or `sudoValidator`, not both.");
	}
	if (params.sudoValidator !== undefined) return params.sudoValidator;
	if (params.ownerSigner === undefined) {
		throw new Error("kawasekit: pass one of `ownerSigner` (ECDSA) or `sudoValidator` (pre-built).");
	}
	return signerToEcdsaValidator(params.publicClient, {
		signer: params.ownerSigner,
		entryPoint: params.entryPoint,
		kernelVersion: params.kernelVersion,
	});
}

/**
 * Build the session-key permission validator. Intended as the **single shared
 * builder** for both issuance and revocation so they derive the identical
 * validator identifier from the same `(sessionKeySigner, policies)` — pass
 * identical policies in identical ORDER, since the identifier hashes the ordered
 * policy array (a mismatch makes revoke target the wrong validator). Issuance
 * uses it today; revocation migrates onto it in the U-B2 builder.
 */
export async function buildSessionPermissionValidator(params: {
	// `Client` (not `PublicClient`) — `toPermissionValidator` only needs a viem `Client`,
	// and this lets a Kernel client's `.client` be reused verbatim at revoke time.
	readonly publicClient: Client;
	readonly sessionKeySigner: LocalAccount;
	readonly policies: readonly Policy[];
	readonly entryPoint: EntryPointType<"0.7">;
	readonly kernelVersion: GetKernelVersion<"0.7">;
}): Promise<KernelValidator> {
	const signer = await toECDSASigner({ signer: params.sessionKeySigner });
	return toPermissionValidator(params.publicClient, {
		signer,
		policies: [...params.policies],
		entryPoint: params.entryPoint,
		kernelVersion: params.kernelVersion,
	});
}

/** Parameters for {@link createAgentSmartAccount}. */
export type CreateAgentSmartAccountParams = {
	readonly publicClient: PublicClient<Transport, Chain | undefined>;
	readonly sessionKeySigner: LocalAccount;
	readonly policies: readonly Policy[];
	/** Bind to an existing deployed account (e.g. re-provision after recovery). */
	readonly address?: Address;
	readonly entryPoint?: EntryPointType<"0.7">;
	readonly kernelVersion?: GetKernelVersion<"0.7">;
} & AgentOwner;

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

	const sudoValidator = await resolveSudoValidator({
		publicClient: params.publicClient,
		ownerSigner: params.ownerSigner,
		sudoValidator: params.sudoValidator,
		entryPoint,
		kernelVersion,
	});
	const permissionValidator = await buildSessionPermissionValidator({
		publicClient: params.publicClient,
		sessionKeySigner: params.sessionKeySigner,
		policies: params.policies,
		entryPoint,
		kernelVersion,
	});

	return createKernelAccount(params.publicClient, {
		plugins: { sudo: sudoValidator, regular: permissionValidator },
		...(params.address !== undefined ? { address: params.address } : {}),
		entryPoint,
		kernelVersion,
	});
}
