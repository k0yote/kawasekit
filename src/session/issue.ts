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
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { EntryPointType, GetKernelVersion } from "@zerodev/sdk/types";
import type { Chain, LocalAccount, PublicClient, Transport } from "viem";
import { createAgentSmartAccount } from "../account/session-key";
import { isSupportedChainId, type SupportedChainId } from "../chains";
import {
	KAWASEKIT_SESSION_ENVELOPE_VERSION,
	type KawasekitSessionEnvelope,
	type KawasekitSessionPolicySummary,
} from "./envelope";

/** Parameters for {@link issueSessionKey}. */
export interface IssueSessionKeyParams {
	/**
	 * viem `PublicClient` on the chain the smart account will live on. Its
	 * `chain.id` MUST be a {@link SupportedChainId} and is recorded in the
	 * envelope so restore-time mismatches fail fast.
	 */
	readonly publicClient: PublicClient<Transport, Chain>;
	/** Owner EOA — retains sudo authority. */
	readonly ownerSigner: LocalAccount;
	/** Session-key EOA — the day-to-day signer the agent will hold. */
	readonly sessionKeySigner: LocalAccount;
	/**
	 * Policies the session key must satisfy at userOp validation time
	 * (e.g. {@link createJpycDailyLimitPolicies}).
	 */
	readonly policies: readonly Policy[];
	/** Optional advisory expiry (unix seconds). Recorded in the envelope. */
	readonly expiresAt?: bigint;
	/** Optional advisory policy summary for host UI. */
	readonly policySummary?: KawasekitSessionPolicySummary;
	/** EntryPoint override. Defaults to v0.7. */
	readonly entryPoint?: EntryPointType<"0.7">;
	/** Kernel version override. Defaults to {@link KERNEL_V3_1}. */
	readonly kernelVersion?: GetKernelVersion<"0.7">;
}

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

	const account = await createAgentSmartAccount({
		publicClient: params.publicClient,
		ownerSigner: params.ownerSigner,
		sessionKeySigner: params.sessionKeySigner,
		policies: params.policies,
		entryPoint,
		kernelVersion,
	});

	const serialized = await serializePermissionAccount(account);

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
