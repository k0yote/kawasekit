/**
 * The `local` PolicyGatedSigner adapter — `enforcement: "advisory"`.
 *
 * Wraps a viem {@link Account} + a {@link SpendingPolicy} + a pinned EIP-712
 * domain. `sign(intent)` evaluates the policy SDK-side and, on pass, produces a
 * real EIP-3009 authorization via {@link signTransferWithAuthorization}. It is
 * **advisory** because the wrapped key can still sign anything elsewhere — the
 * gate is only reached if the caller chooses to call *this* `sign()`. Use it for
 * dev, the A1 cross-language fallback, and any flow that is explicitly not
 * bounded/regulated; the type-gate (`requireNonBypassable`) keeps it out of
 * flows that require non-bypassable enforcement.
 *
 * @packageDocumentation
 */

import type { Account } from "viem";
import { getAddress } from "viem";
import type { SpendingPolicy, SpendState } from "../policy/spending-policy";
import { evaluateSpendingPolicy } from "../policy/spending-policy";
import type { X402AssetParam } from "../tokens/asset-domain";
import { resolveAssetParam } from "../tokens/asset-domain";
import { signTransferWithAuthorization } from "../tokens/eip3009";
import { PolicyGatedSignerConfigError } from "./errors";
import type { PaymentIntent, PolicyGatedSigner, SignerDescription, SignResult } from "./types";

/** Parameters for {@link createLocalPolicyGatedSigner}. */
export interface CreateLocalPolicyGatedSignerParams {
	/** EOA / LocalAccount that signs the EIP-3009 authorization. */
	readonly account: Account;
	/** The spending policy this signer enforces (SDK-side, advisory). */
	readonly policy: SpendingPolicy;
	/** Asset binding — pins the EIP-712 domain `name`/`version`/`verifyingContract`. */
	readonly asset: X402AssetParam;
	/**
	 * Required literal acknowledgement that this signer is **advisory** (a
	 * key-holder can bypass its policy). Omitting it is a compile error (TS) and
	 * a construction-time throw (JS) — so constructing an advisory signer is a
	 * conscious, greppable act. For bounded/regulated flows use a cryptographic
	 * adapter instead.
	 */
	readonly acknowledgeAdvisory: true;
	/**
	 * Optional cumulative-spend view (read-only) the adapter evaluates
	 * `cumulativeCap` against. `local` does not own an authoritative ledger; the
	 * caller folds a successful spend back in (e.g. via `mergeSpendState`) before
	 * the next call. Default: empty.
	 */
	readonly spendState?: () => SpendState | Promise<SpendState>;
}

/**
 * Construct a `local` (advisory) PolicyGatedSigner.
 *
 * @example
 * ```ts
 * const signer = createLocalPolicyGatedSigner({
 *   account,
 *   policy: createSpendingPolicy({ session: { id, notAfter }, perToken: [{ token: JPYC, maxPerSign: 1_000n }] }),
 *   asset: { kind: "known", id: "jpyc-v2" },
 *   acknowledgeAdvisory: true,
 * });
 * const result = await signer.sign(intent);
 * ```
 */
export function createLocalPolicyGatedSigner(
	params: CreateLocalPolicyGatedSignerParams,
): PolicyGatedSigner<"advisory"> {
	if (params.acknowledgeAdvisory !== true) {
		throw new PolicyGatedSignerConfigError(
			"acknowledgeAdvisory",
			"a local signer is advisory (a key-holder can bypass its policy); pass `acknowledgeAdvisory: true` to construct one consciously, or use a cryptographic adapter for bounded/regulated flows",
		);
	}

	const { account, policy, spendState } = params;
	const pinned = resolveAssetParam(params.asset);
	const from = getAddress(account.address);

	return {
		enforcement: "advisory",
		from,
		async sign(intent: PaymentIntent): Promise<SignResult> {
			if (getAddress(intent.from) !== from) {
				return {
					ok: false,
					rejection: {
						reason: "from_mismatch",
						detail: `intent.from ${getAddress(intent.from)} does not equal signer.from ${from}`,
					},
				};
			}
			if (getAddress(intent.token) !== pinned.verifyingContract) {
				return {
					ok: false,
					rejection: {
						reason: "token_not_allowed",
						detail: `intent.token ${getAddress(intent.token)} does not equal the signer's pinned verifyingContract ${pinned.verifyingContract}`,
					},
				};
			}

			const state: SpendState = (await spendState?.()) ?? { spentPerToken: [] };
			const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
			const decision = evaluateSpendingPolicy(policy, intent, state, nowSeconds);
			if (!decision.ok) {
				return { ok: false, rejection: decision.rejection };
			}

			const signed = await signTransferWithAuthorization(
				account,
				{
					name: pinned.name,
					version: pinned.version,
					chainId: intent.chainId,
					verifyingContract: pinned.verifyingContract,
				},
				{
					from,
					to: intent.to,
					value: intent.value,
					validAfter: intent.validAfter,
					validBefore: intent.validBefore,
					nonce: intent.nonce,
				},
			);
			return { ok: true, signature: signed.signature, intent };
		},
		describe(): SignerDescription {
			return {
				enforcement: "advisory",
				from,
				policyId: policy.session.id,
				notAfter: policy.session.notAfter,
				revoked: policy.revoked,
			};
		},
	};
}
