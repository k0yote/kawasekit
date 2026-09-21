/**
 * Builder for the Settlement callPolicy — the on-chain rule that locks a ZeroDev session key to
 * paying through the `Settlement` contract, and to nothing else:
 *
 * 1. `token.approve(spender, amount)` with `spender == settlement` and `amount ≤ maxPerPayment`
 * 2. `settlement.pay(token, merchant, amount, validUntil, details)` with `token == jpyc`,
 *    `merchant ∈ merchants`, `amount ≤ maxPerPayment`; `validUntil` and `details` unconstrained
 *
 * A payment is the batch `[approve, pay]` in one UserOp (see `../settlement/settle-order`). A bare
 * `token.transfer` is not in the scope, so every unit such a key moves carries an order reference.
 *
 * **What this policy does not bound.** It checks each call of a UserOp, not how many calls there
 * are: a batch carrying two `pay` calls passes it (observed on Polygon Amoy). Total exposure is
 * unchanged from a `transfer`-scoped key — the account's balance, until the key expires — but
 * holding a UserOp to ONE payment is the gas sponsor's job, not this policy's.
 *
 * Used by {@link createBuyListPolicies} (`./buy-list`). Internal: not exported from the package.
 *
 * @packageDocumentation
 */

import type { Policy } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import type { Abi, Address } from "viem";
import { getAddress, isAddress } from "viem";
import { normalizeRecipientAllowlist } from "./normalize-allowlist";

/**
 * The two functions in the scope, as ONE abi. `toCallPolicy` is generic over a single abi and a
 * single function name, so a two-function scope is declared against viem's general `Abi` type. That
 * opts out of per-argument type inference (`args` become `unknown[]`) and changes nothing at
 * runtime, where the selector and the argument offsets are derived from these entries. It is why
 * `test/buy-list-policy.test.ts` proves each argument's constraint from the enforced bytes.
 *
 * A dedicated two-entry abi rather than slices of `jpycAbi` / `settlementAbi`: the scope should not
 * move because an unrelated entry was added to either.
 */
const SETTLEMENT_SCOPE_ABI: Abi = [
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "pay",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "token", type: "address" },
			{ name: "merchant", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "validUntil", type: "uint64" },
			{ name: "details", type: "bytes32" },
		],
		outputs: [],
	},
];

/** `@zerodev/permissions` does not export its `Permission` type; this is the same type, derived. */
type ScopePermission = NonNullable<
	Parameters<typeof toCallPolicy<Abi, string>>[0]["permissions"]
>[number];

/** Parameters for {@link buildSettlementCallPolicy}. */
export interface SettlementCallPolicyParams {
	/** The token the key may pay with — JPYC on the target chain. */
	readonly jpycAddress: Address;
	/** The `Settlement` deployment on the target chain. */
	readonly settlementAddress: Address;
	/** The recipients the key may pay. Non-empty; checksum-normalized + de-duplicated. */
	readonly merchants: readonly Address[];
	/** Maximum token amount (raw units) per payment. Bounds both the approval and the payment. */
	readonly maxPerPayment: bigint;
}

/**
 * Build the single ZeroDev callPolicy for paying through `Settlement`. Throws on a non-positive
 * cap, an empty merchant list, a malformed `settlementAddress`, or one equal to `jpycAddress`.
 *
 * The on-chain policy version is fixed at `V0_0_4`. It is the only version the two-permission batch
 * has been run against (Polygon Amoy, 2026-09-21), and a security scope should not offer a version
 * nobody has exercised.
 */
export function buildSettlementCallPolicy(params: SettlementCallPolicyParams): Policy {
	if (params.maxPerPayment <= 0n) {
		throw new Error(`maxPerTransfer must be positive, got ${params.maxPerPayment}.`);
	}
	if (!isAddress(params.settlementAddress, { strict: false })) {
		throw new Error(`settlementAddress is not a valid address: ${params.settlementAddress}`);
	}
	const settlement = getAddress(params.settlementAddress);
	const jpyc = getAddress(params.jpycAddress);
	if (settlement === jpyc) {
		// approve(spender = the token itself) is never what was meant, and it would silently produce
		// a key that can do nothing useful.
		throw new Error("settlementAddress must differ from jpycAddress.");
	}
	const merchants = normalizeRecipientAllowlist(params.merchants);
	if (merchants.length === 0) {
		throw new Error("merchants must not be empty — a buy-list must target at least one merchant.");
	}

	// Annotated, so each `condition` keeps its literal enum member instead of widening to
	// `ParamCondition` — the policy's argument type is a union discriminated on exactly that.
	const approve: ScopePermission = {
		target: jpyc,
		abi: SETTLEMENT_SCOPE_ABI,
		functionName: "approve",
		args: [
			{ condition: ParamCondition.EQUAL, value: settlement },
			{ condition: ParamCondition.LESS_THAN_OR_EQUAL, value: params.maxPerPayment },
		],
	};
	const pay: ScopePermission = {
		target: settlement,
		abi: SETTLEMENT_SCOPE_ABI,
		functionName: "pay",
		args: [
			{ condition: ParamCondition.EQUAL, value: jpyc },
			{ condition: ParamCondition.ONE_OF, value: merchants },
			{ condition: ParamCondition.LESS_THAN_OR_EQUAL, value: params.maxPerPayment },
			null, // validUntil: the contract enforces expiry; the key's own window is the timestamp policy
			null, // details: an opaque commitment, different for every order
		],
	};

	return toCallPolicy({
		policyVersion: CallPolicyVersion.V0_0_4,
		permissions: [approve, pay],
	});
}
