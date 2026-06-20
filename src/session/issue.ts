/**
 * `issueSessionKey()` — owner-side primitive that builds a Kernel agent
 * account and wraps ZeroDev's `serializePermissionAccount` output in a
 * {@link KawasekitSessionEnvelope}.
 *
 * The envelope is portable: callers can hand it to an agent on a different
 * machine, the agent passes it to {@link restoreSessionAccount} along with the
 * session-key private key, and it ends up holding a `KernelAccountClient`
 * scoped to the policies installed at issue time.
 *
 * The owner retains sudo authority on-chain and can revoke at any time via
 * `revokeSessionKey()` (task 2.5).
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { serializePermissionAccount } from "@zerodev/permissions";
import type { KernelValidator } from "@zerodev/sdk";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { EntryPointType, GetKernelVersion } from "@zerodev/sdk/types";
import type { Address, Chain, Hex, LocalAccount, PublicClient, Transport } from "viem";
import {
	type AgentOwner,
	buildSessionPermissionValidator,
	resolveSudoValidator,
} from "../account/session-key";
import { isSupportedChainId, type SupportedChainId } from "../chains";
import {
	KAWASEKIT_SESSION_ENVELOPE_VERSION,
	type KawasekitSessionEnvelope,
	type KawasekitSessionPolicySummary,
} from "./envelope";

/** Parameters for {@link issueSessionKey}. */
export type IssueSessionKeyParams = {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly sessionKeySigner: LocalAccount;
	/**
	 * Policies the session key must satisfy at userOp validation time (e.g.
	 * {@link createJpycDailyLimitPolicies}). Supply the SAME policies in the SAME
	 * order to issue and to revoke (`buildRevokeSessionKeyCall`) — the validator
	 * identifier hashes the ordered policy array.
	 */
	readonly policies: readonly Policy[];
	/** Bind issuance to an existing deployed account (re-provision after recovery). */
	readonly address?: Address;
	/**
	 * Weighted-enable seam (RFC-0003 U-B1). Called with the SDK-built permission
	 * validator; returns the enable signature for `serializePermissionAccount`'s
	 * 3rd arg. Omit for an ECDSA owner (the default single-signer enable). For a
	 * weighted sudo this is `approvePlugin(plugin)` + `encodeSignatures([approval], true)`,
	 * computed by the caller with their weighted client. A mismatch surfaces on-chain
	 * as `EnableNotApproved` at first use.
	 */
	readonly approveEnable?: (permissionValidator: KernelValidator) => Promise<Hex>;
	/** Optional advisory expiry (unix seconds). Recorded in the envelope. */
	readonly expiresAt?: bigint;
	/** Optional advisory policy summary for host UI. */
	readonly policySummary?: KawasekitSessionPolicySummary;
	/** EntryPoint override. Defaults to v0.7. */
	readonly entryPoint?: EntryPointType<"0.7">;
	/** Kernel version override. Defaults to {@link KERNEL_V3_1}. */
	readonly kernelVersion?: GetKernelVersion<"0.7">;
} & AgentOwner;

/**
 * Issues a fresh session key for an agent smart account.
 *
 * Notes:
 * - The session-key **private key is not embedded** in the returned envelope.
 *   The agent must receive the private key out-of-band; the envelope alone is
 *   not enough to spend.
 * - The smart account is **not deployed** by this call. It will be deployed
 *   on first userOp from `restoreSessionAccount`.
 *
 * @example
 * ```ts
 * import { parseUnits } from "viem";
 * import { privateKeyToAccount } from "viem/accounts";
 * import {
 *   createJpycDailyLimitPolicies,
 *   getJpycAddress,
 *   issueSessionKey,
 *   JPYC_DECIMALS,
 *   polygonAmoy,
 *   serializeSessionEnvelope,
 * } from "kawasekit";
 *
 * const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as `0x${string}`);
 * const sessionKey = privateKeyToAccount(process.env.SESSION_KEY_PRIVATE_KEY as `0x${string}`);
 *
 * const envelope = await issueSessionKey({
 *   publicClient,
 *   ownerSigner: owner,
 *   sessionKeySigner: sessionKey,
 *   policies: createJpycDailyLimitPolicies({
 *     jpycAddress: getJpycAddress(polygonAmoy.id),
 *     maxPerTransfer: parseUnits("100", JPYC_DECIMALS),
 *     maxTransfersPerDay: 10,
 *   }),
 *   policySummary: {
 *     jpycAddress: getJpycAddress(polygonAmoy.id),
 *     maxPerTransfer: parseUnits("100", JPYC_DECIMALS),
 *     maxTransfersPerDay: 10,
 *   },
 * });
 *
 * fs.writeFileSync("agent.session", serializeSessionEnvelope(envelope));
 * ```
 */
export async function issueSessionKey(
	params: IssueSessionKeyParams,
): Promise<KawasekitSessionEnvelope> {
	const chainId = params.publicClient.chain.id;
	if (!isSupportedChainId(chainId)) {
		throw new Error(
			`issueSessionKey: publicClient.chain.id ${chainId} is not a kawasekit-supported chain`,
		);
	}
	const supportedChainId: SupportedChainId = chainId;
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
	const account = await createKernelAccount(params.publicClient, {
		plugins: { sudo: sudoValidator, regular: permissionValidator },
		...(params.address !== undefined ? { address: params.address } : {}),
		entryPoint,
		kernelVersion,
	});

	const enableSignature = params.approveEnable
		? await params.approveEnable(permissionValidator)
		: undefined;
	const serialized = enableSignature
		? await serializePermissionAccount(account, undefined, enableSignature)
		: await serializePermissionAccount(account);

	const base = {
		kawasekitVersion: KAWASEKIT_SESSION_ENVELOPE_VERSION,
		chainId: supportedChainId,
		smartAccountAddress: account.address,
		sessionKeyAddress: params.sessionKeySigner.address,
		serialized,
	} as const;
	if (params.expiresAt !== undefined && params.policySummary !== undefined) {
		return {
			...base,
			expiresAt: params.expiresAt,
			policySummary: params.policySummary,
		};
	}
	if (params.expiresAt !== undefined) {
		return { ...base, expiresAt: params.expiresAt };
	}
	if (params.policySummary !== undefined) {
		return { ...base, policySummary: params.policySummary };
	}
	return base;
}
