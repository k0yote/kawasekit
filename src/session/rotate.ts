/**
 * `rotateSessionKey()` — a thin compositional helper that revokes the
 * current session key and issues a new one in sequence.
 *
 * Compose-don't-conflate: rotate is just `revoke` followed by `issue`. Both
 * primitives are exposed individually so callers who need finer control
 * (e.g. revoke now, issue tomorrow with different policies) can chain them
 * themselves.
 *
 * @packageDocumentation
 */

import type { KawasekitSessionEnvelope } from "./envelope";
import { type IssueSessionKeyParams, issueSessionKey } from "./issue";
import {
	type RevokeSessionKeyParams,
	type RevokeSessionKeyResult,
	revokeSessionKey,
} from "./revoke";

/** Parameters for {@link rotateSessionKey}. */
export interface RotateSessionKeyParams {
	/** Inputs for revoking the current session. `waitForReceipt` is forced `true`. */
	readonly revoke: Omit<RevokeSessionKeyParams, "waitForReceipt">;
	/** Inputs for issuing the replacement session. */
	readonly issue: IssueSessionKeyParams;
}

/** Result of {@link rotateSessionKey}. */
export interface RotateSessionKeyResult {
	/** Outcome of the revoke step. */
	readonly revoke: RevokeSessionKeyResult;
	/** The freshly issued replacement envelope. */
	readonly envelope: KawasekitSessionEnvelope;
}

/**
 * Atomically rotate the agent's session key: revoke the old, issue the new.
 *
 * The revoke is always awaited to the bundler receipt — issuing a replacement
 * before the old key is actually disarmed would leave two valid signers at
 * once, defeating the point.
 *
 * @example
 * ```ts
 * import { rotateSessionKey } from "kawasekit";
 *
 * const { revoke, envelope } = await rotateSessionKey({
 *   revoke: {
 *     ownerKernelClient,
 *     envelope: oldEnvelope,
 *     sessionKeySigner: oldSessionKeySigner,
 *     policies: oldPolicies,
 *   },
 *   issue: {
 *     publicClient,
 *     ownerSigner,
 *     sessionKeySigner: newSessionKeySigner,
 *     policies: newPolicies,
 *   },
 * });
 * ```
 */
export async function rotateSessionKey(
	params: RotateSessionKeyParams,
): Promise<RotateSessionKeyResult> {
	const revoke = await revokeSessionKey({ ...params.revoke, waitForReceipt: true });
	const envelope = await issueSessionKey(params.issue);
	return { revoke, envelope };
}
