/**
 * `restoreSessionAccount()` — agent-side primitive that unwraps a
 * {@link KawasekitSessionEnvelope} back into a usable Kernel account scoped
 * to the policies installed at issue time.
 *
 * Three invariants are checked **before** touching ZeroDev's deserialization
 * so that misconfiguration manifests as a typed error here, not a confusing
 * UserOp-time revert:
 *
 * 1. `envelope.kawasekitVersion` matches the current envelope version
 *    (already enforced by {@link parseSessionEnvelope}; re-checked here for
 *    callers who construct the envelope object directly).
 * 2. `envelope.chainId === publicClient.chain.id`.
 * 3. `envelope.sessionKeyAddress` matches the provided `sessionKeySigner`.
 *
 * @packageDocumentation
 */

import { deserializePermissionAccount } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import type { CreateKernelAccountReturnType } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import type { EntryPointType, GetKernelVersion } from "@zerodev/sdk/types";
import { type Chain, getAddress, type LocalAccount, type PublicClient, type Transport } from "viem";
import { KAWASEKIT_SESSION_ENVELOPE_VERSION, type KawasekitSessionEnvelope } from "./envelope";
import {
	SessionEnvelopeChainMismatchError,
	SessionEnvelopeSignerMismatchError,
	SessionEnvelopeVersionError,
} from "./errors";

/** Parameters for {@link restoreSessionAccount}. */
export interface RestoreSessionAccountParams {
	/** Must be on the same chain the envelope was issued for. */
	readonly publicClient: PublicClient<Transport, Chain>;
	/** Envelope produced by {@link issueSessionKey} (or parsed via {@link parseSessionEnvelope}). */
	readonly envelope: KawasekitSessionEnvelope;
	/**
	 * The session-key signer the agent holds. Its address MUST equal
	 * `envelope.sessionKeyAddress` — otherwise the restored account would
	 * sign userOps that the on-chain permission validator rejects.
	 */
	readonly sessionKeySigner: LocalAccount;
	/** EntryPoint override. Defaults to v0.7. */
	readonly entryPoint?: EntryPointType<"0.7">;
	/** Kernel version override. Defaults to {@link KERNEL_V3_1}. */
	readonly kernelVersion?: GetKernelVersion<"0.7">;
}

/**
 * Rebuilds the Kernel account from an envelope + the session-key signer.
 *
 * @throws {SessionEnvelopeVersionError} If `envelope.kawasekitVersion` does
 *   not match the current envelope version.
 * @throws {SessionEnvelopeChainMismatchError} If `envelope.chainId !==
 *   publicClient.chain.id`.
 * @throws {SessionEnvelopeSignerMismatchError} If `sessionKeySigner.address !==
 *   envelope.sessionKeyAddress`.
 *
 * @example
 * ```ts
 * import { createPublicClient, http } from "viem";
 * import { privateKeyToAccount } from "viem/accounts";
 * import {
 *   parseSessionEnvelope,
 *   polygonAmoy,
 *   restoreSessionAccount,
 * } from "kawasekit";
 *
 * const publicClient = createPublicClient({
 *   chain: polygonAmoy,
 *   transport: http(),
 * });
 * const envelope = parseSessionEnvelope(fs.readFileSync("agent.session", "utf8"));
 * const sessionKey = privateKeyToAccount(process.env.SESSION_KEY_PRIVATE_KEY as `0x${string}`);
 *
 * const account = await restoreSessionAccount({
 *   publicClient,
 *   envelope,
 *   sessionKeySigner: sessionKey,
 * });
 * ```
 */
export async function restoreSessionAccount(
	params: RestoreSessionAccountParams,
): Promise<CreateKernelAccountReturnType<"0.7">> {
	const { publicClient, envelope, sessionKeySigner } = params;

	if (envelope.kawasekitVersion !== KAWASEKIT_SESSION_ENVELOPE_VERSION) {
		throw new SessionEnvelopeVersionError(
			KAWASEKIT_SESSION_ENVELOPE_VERSION,
			envelope.kawasekitVersion,
		);
	}
	if (publicClient.chain.id !== envelope.chainId) {
		throw new SessionEnvelopeChainMismatchError(envelope.chainId, publicClient.chain.id);
	}
	if (getAddress(sessionKeySigner.address) !== getAddress(envelope.sessionKeyAddress)) {
		throw new SessionEnvelopeSignerMismatchError(
			envelope.sessionKeyAddress,
			sessionKeySigner.address,
		);
	}

	const entryPoint = params.entryPoint ?? getEntryPoint("0.7");
	const kernelVersion = params.kernelVersion ?? KERNEL_V3_1;
	const modularSigner = await toECDSASigner({ signer: sessionKeySigner });

	return deserializePermissionAccount(
		publicClient,
		entryPoint,
		kernelVersion,
		envelope.serialized,
		modularSigner,
	);
}
