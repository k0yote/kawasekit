/**
 * Shared builder for the JPYC `transfer` callPolicy — the on-chain rule that
 * locks a ZeroDev session key to `JPYC.transfer(to, value)` with
 * `value ≤ maxPerTransfer` and an optional recipient allowlist (condition
 * `ONE_OF`). Used by BOTH {@link createJpycDailyLimitPolicies} (`./daily-limit`)
 * and {@link createBuyListPolicies} (`./buy-list`) so the recipient/amount
 * constraint is built identically; each caller composes its own rate-limit /
 * timestamp policy on top.
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import type { Address } from "viem";
import { jpycAbi } from "../tokens/jpyc";
import { normalizeRecipientAllowlist } from "./normalize-allowlist";

/** Parameters for {@link buildJpycTransferCallPolicy}. */
export interface JpycTransferCallPolicyParams {
	/** JPYC contract address on the target chain. */
	readonly jpycAddress: Address;
	/** Maximum JPYC (raw units) per single `transfer`. Must be positive. */
	readonly maxPerTransfer: bigint;
	/**
	 * Recipient restriction. An address list constrains `to` to those recipients
	 * (`ONE_OF`); `"any"` (or `undefined`) leaves it unrestricted. Entries are
	 * checksum-normalized + de-duplicated ({@link normalizeRecipientAllowlist}).
	 * An **empty** array throws (an on-chain allowlist cannot encode "match
	 * nothing"). An address list requires `callPolicyVersion` ≥ `V0_0_2`.
	 */
	readonly recipientAllowlist?: readonly Address[] | "any" | undefined;
	/** ZeroDev callPolicy on-chain version. Defaults to V0_0_4. */
	readonly callPolicyVersion?: CallPolicyVersion | undefined;
}

/**
 * Build the single ZeroDev callPolicy for a JPYC `transfer`, enforcing the
 * per-transfer amount cap and (optionally) the recipient allowlist. Throws on a
 * non-positive `maxPerTransfer`, an empty allowlist, or an allowlist combined
 * with `callPolicyVersion` `V0_0_1` (which lacks `ONE_OF`).
 */
export function buildJpycTransferCallPolicy(params: JpycTransferCallPolicyParams): Policy {
	if (params.maxPerTransfer <= 0n) {
		throw new Error(`maxPerTransfer must be positive, got ${params.maxPerTransfer}.`);
	}
	// Resolve the recipient constraint up-front. Omitted or "any" => unrestricted
	// (a `null` arg); an address list => checksum-normalized + de-duped (shared
	// with the off-chain SpendingPolicy). Unlike off-chain, an empty list is a
	// caller bug here — an on-chain allowlist cannot encode "deny all".
	const recipients =
		params.recipientAllowlist === undefined || params.recipientAllowlist === "any"
			? null
			: normalizeRecipientAllowlist(params.recipientAllowlist);
	if (recipients !== null && recipients.length === 0) {
		throw new Error(
			'recipientAllowlist must not be empty — omit it or pass "any" to allow any recipient.',
		);
	}
	// The ONE_OF condition (used to encode an address list) is only supported by
	// the V0_0_2+ CallPolicy contract; catch the incompatible combination here
	// with a typed message rather than a bare error from deep inside toCallPolicy.
	if (recipients !== null && params.callPolicyVersion === CallPolicyVersion.V0_0_1) {
		throw new Error(
			"recipientAllowlist requires callPolicyVersion V0_0_2 or later (the ONE_OF condition is unsupported on V0_0_1).",
		);
	}

	return toCallPolicy({
		policyVersion: params.callPolicyVersion ?? CallPolicyVersion.V0_0_4,
		permissions: [
			{
				target: params.jpycAddress,
				abi: jpycAbi,
				functionName: "transfer",
				args: [
					// Recipient (`to`): unrestricted (`null`) unless an allowlist resolved
					// above, in which case it is constrained via the ONE_OF condition.
					recipients === null ? null : { condition: ParamCondition.ONE_OF, value: recipients },
					// value: must be ≤ maxPerTransfer.
					{
						condition: ParamCondition.LESS_THAN_OR_EQUAL,
						value: params.maxPerTransfer,
					},
				],
			},
		],
	});
}
