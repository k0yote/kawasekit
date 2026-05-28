/**
 * `revokeSessionKey()` — owner-side primitive that uninstalls a session-key
 * permission validator from the agent's smart account.
 *
 * Implementation strategy (per plan §risk #3): ZeroDev does not expose a
 * dedicated revoke helper, so we re-derive the `PermissionPlugin` from the
 * envelope's `sessionKeyAddress` + the same policies that were installed at
 * issue time, then submit a sudo UserOp via `@zerodev/sdk`'s
 * {@link uninstallPlugin} action. After the receipt, the session key can no
 * longer sign UserOps the validator would accept.
 *
 * In-flight UserOps already submitted to the bundler but not yet mined can
 * still settle before the uninstall transaction lands. A future "soft revoke"
 * via `invalidateNonce` on the session-key validator's nonce key will close
 * that race; tracked for M5 (the helper signature accepts an
 * `invalidateInFlightNonces` option today and throws `"not implemented"` to
 * lock in the API shape). Until M5 lands, see
 * `docs/recipes/revoke-race-mitigation.md` for the four-layer operator
 * playbook (SDK call → merchant kill-switch → paymaster sponsorship
 * freeze → bundler mempool monitoring).
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { uninstallPlugin } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { EntryPointType, GetKernelVersion } from "@zerodev/sdk/types";
import { getAddress, type Hash, type LocalAccount } from "viem";
import type { ConfiguredKernelClient } from "../client/transfer-jpyc";
import type { KawasekitSessionEnvelope } from "./envelope";
import { SessionEnvelopeSignerMismatchError } from "./errors";

/** Parameters for {@link revokeSessionKey}. */
export interface RevokeSessionKeyParams {
	/**
	 * The owner's sudo Kernel client — the only entity that can call
	 * `uninstallValidation` on the agent account.
	 *
	 * **CRITICAL: must be a SUDO-ONLY kernel account** (i.e.
	 * `createKernelAccount(publicClient, { plugins: { sudo: ecdsaValidator } })`
	 * — no `regular` plugin). If you pass a client whose account also has the
	 * session-key permission validator wired as `regular`, ZeroDev signs
	 * userOps with that validator by default and the spending policy will
	 * reject `uninstallValidation` at the validation phase (`AA23 reverted`).
	 *
	 * The counterfactual smart-account address only depends on the sudo
	 * validator in Kernel v3.1, so a sudo-only client points at the SAME
	 * account as one built with both sudo + regular.
	 *
	 * Its `account.address` MUST equal `envelope.smartAccountAddress`.
	 */
	readonly ownerKernelClient: ConfiguredKernelClient;
	/** The envelope of the session being revoked. */
	readonly envelope: KawasekitSessionEnvelope;
	/**
	 * A LocalAccount whose address equals `envelope.sessionKeyAddress`. Used
	 * to reconstruct the validator's on-chain identifier; no signing is
	 * actually performed with this account during revoke.
	 */
	readonly sessionKeySigner: LocalAccount;
	/**
	 * The policies that were installed at issue time. ZeroDev does not store
	 * these on-chain in a retrievable form, so the caller MUST re-supply
	 * them. Mismatches surface as an `uninstallValidation` revert at userOp
	 * validation time.
	 */
	readonly policies: readonly Policy[];
	/**
	 * Future option: also invalidate the session-key validator's nonce key
	 * to kill in-flight UserOps. Not implemented today — passing `true`
	 * throws. Tracked for M5; see `docs/THREAT_MODEL.md` §6.3 and
	 * `docs/recipes/revoke-race-mitigation.md` for the operator playbook to
	 * use until then.
	 */
	readonly invalidateInFlightNonces?: boolean;
	/** EntryPoint override. Defaults to v0.7. */
	readonly entryPoint?: EntryPointType<"0.7">;
	/** Kernel version override. Defaults to {@link KERNEL_V3_1}. */
	readonly kernelVersion?: GetKernelVersion<"0.7">;
	/**
	 * If `false`, return after submitting the UserOp without waiting for the
	 * bundler receipt. Default `true` (wait).
	 */
	readonly waitForReceipt?: boolean;
}

/** Result of {@link revokeSessionKey}. */
export interface RevokeSessionKeyResult {
	/** Hash of the uninstall UserOp. */
	readonly userOpHash: Hash;
	/** Bundler transaction hash, present when `waitForReceipt` (default true). */
	readonly transactionHash: Hash | null;
	/** `true` if the bundler reported success, `null` if not awaited. */
	readonly success: boolean | null;
}

/**
 * Uninstalls a session-key permission validator from the agent's smart
 * account. After the returned UserOp lands, the session key can no longer
 * authorise actions.
 *
 * @throws {SessionEnvelopeSignerMismatchError} If `sessionKeySigner.address`
 *   does not match `envelope.sessionKeyAddress`.
 * @throws {Error} If `invalidateInFlightNonces` is `true` (planned for M5;
 *   see `docs/THREAT_MODEL.md` §6.3 and
 *   `docs/recipes/revoke-race-mitigation.md` for the four-layer
 *   operator playbook to use until then).
 *
 * @example
 * ```ts
 * import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
 * import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
 * import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
 * import { revokeSessionKey } from "kawasekit";
 *
 * // Build a SUDO-ONLY kernel account for the owner — see param JSDoc.
 * const sudoValidator = await signerToEcdsaValidator(publicClient, {
 *   signer: owner,
 *   entryPoint: getEntryPoint("0.7"),
 *   kernelVersion: KERNEL_V3_1,
 * });
 * const ownerSudoAccount = await createKernelAccount(publicClient, {
 *   plugins: { sudo: sudoValidator },
 *   entryPoint: getEntryPoint("0.7"),
 *   kernelVersion: KERNEL_V3_1,
 * });
 * const ownerKernelClient = createKernelAccountClient({
 *   account: ownerSudoAccount,
 *   chain,
 *   client: publicClient,
 *   bundlerTransport,
 *   paymaster,
 * });
 *
 * await revokeSessionKey({
 *   ownerKernelClient,
 *   envelope,
 *   sessionKeySigner,
 *   policies: createJpycDailyLimitPolicies({ ... }),
 * });
 * ```
 */
export async function revokeSessionKey(
	params: RevokeSessionKeyParams,
): Promise<RevokeSessionKeyResult> {
	const { ownerKernelClient, envelope, sessionKeySigner, policies } = params;

	if (params.invalidateInFlightNonces === true) {
		throw new Error(
			"revokeSessionKey: `invalidateInFlightNonces` is not implemented yet — the helper signature accepts the option to lock in the API shape, but in-flight nonce invalidation lands in M5. Hard revoke via uninstallPlugin is what runs today; see docs/recipes/revoke-race-mitigation.md for the four-layer operator playbook to use until then.",
		);
	}

	if (getAddress(sessionKeySigner.address) !== getAddress(envelope.sessionKeyAddress)) {
		throw new SessionEnvelopeSignerMismatchError(
			envelope.sessionKeyAddress,
			sessionKeySigner.address,
		);
	}

	if (getAddress(ownerKernelClient.account.address) !== getAddress(envelope.smartAccountAddress)) {
		throw new Error(
			`revokeSessionKey: ownerKernelClient is bound to ${ownerKernelClient.account.address}, but envelope is for ${envelope.smartAccountAddress}.`,
		);
	}

	const entryPoint = params.entryPoint ?? getEntryPoint("0.7");
	const kernelVersion = params.kernelVersion ?? KERNEL_V3_1;

	if (ownerKernelClient.client === undefined) {
		throw new Error(
			"revokeSessionKey: ownerKernelClient.client is undefined — pass `client: publicClient` when constructing the Kernel client so the validator can be reconstructed.",
		);
	}

	const modularSigner = await toECDSASigner({ signer: sessionKeySigner });
	const permissionPlugin = await toPermissionValidator(ownerKernelClient.client, {
		signer: modularSigner,
		policies: [...policies],
		entryPoint,
		kernelVersion,
	});

	const userOpHash = await uninstallPlugin(ownerKernelClient, {
		plugin: permissionPlugin,
	});

	if (params.waitForReceipt === false) {
		return { userOpHash, transactionHash: null, success: null };
	}

	const receipt = await ownerKernelClient.waitForUserOperationReceipt({
		hash: userOpHash,
	});
	return {
		userOpHash,
		transactionHash: receipt.receipt.transactionHash,
		success: receipt.success,
	};
}
