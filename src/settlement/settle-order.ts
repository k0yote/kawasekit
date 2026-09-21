/**
 * High-level helper: pay an order through `Settlement` from a Kernel smart account, as ONE
 * sponsored UserOp.
 *
 * An ERC-20 `transfer` carries a recipient and an amount and nothing else — it cannot say what it
 * pays for. A Settlement payment can: the chain is left with a single `Settled(ref, …)` event whose
 * `ref` the contract computed itself from what was actually paid.
 *
 * The flow:
 * 1. Resolve `Settlement` and JPYC for `kernelClient.chain` — from this package's tables, never
 *    from the caller.
 * 2. Compute the order reference locally, with the account as payer.
 * 3. If the caller supplied the reference it expects, refuse to go on unless they match.
 * 4. Encode `[JPYC.approve(Settlement, amount), Settlement.pay(…)]` and submit them as one UserOp.
 *    The account's batch makes approve-and-pay a single atomic payment; the allowance is for
 *    exactly the amount and is consumed exactly.
 *
 * @packageDocumentation
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, isAddress } from "viem";
import { isSupportedChainId, type SupportedChainId } from "../chains";
import type { ConfiguredKernelClient } from "../client/transfer-jpyc";
import { getJpycAddress, jpycAbi } from "../tokens/jpyc";
import { settlementAbi } from "./abi";
import { getSettlementAddress } from "./deployments";
import { hashOrderRef } from "./order-hash";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT64_MAX = 2n ** 64n - 1n;

/** Parameters for {@link settleOrder}. */
export interface SettleOrderParams {
	/** The order's recipient. */
	readonly merchant: Address;
	/** The exact amount, in the token's smallest unit (JPYC has 18 decimals). Must be positive. */
	readonly amount: bigint;
	/** Unix seconds after which the order can no longer be paid. Enforced on chain. */
	readonly validUntil: bigint;
	/** The commitment to the order's contents — see `hashOrderDetails`. 32 bytes. */
	readonly details: Hex;
	/**
	 * The order reference the caller expects — typically the one the order's issuer quoted. When
	 * given, it is compared with the locally computed reference BEFORE anything is sent, and a
	 * difference throws {@link SettlementOrderRefMismatchError}. Pass it whenever the reference came
	 * from someone else: it is what stops an agent paying for something other than what it agreed to.
	 */
	readonly expectedRef?: Hex;
	/**
	 * If `false`, returns immediately after submitting the UserOp without waiting for the bundler
	 * receipt. Defaults to `true`.
	 */
	readonly waitForReceipt?: boolean;
	/** The current time in unix seconds. Defaults to the system clock; injectable for tests. */
	readonly nowSeconds?: number;
}

/** Result of {@link settleOrder}. */
export interface SettleOrderResult {
	/** The order reference — known before anything is sent, and what `Settled` will carry. */
	readonly ref: Hex;
	readonly userOpHash: Hex;
	/** `null` when `waitForReceipt: false` was requested. */
	readonly transactionHash: Hex | null;
	/** `true` if the bundler receipt reported success; `null` if not awaited. */
	readonly success: boolean | null;
}

/** Thrown when input to {@link settleOrder} is structurally invalid. */
export class SettleOrderInputError extends Error {
	constructor(message: string) {
		super(`settleOrder: ${message}`);
		this.name = "SettleOrderInputError";
	}
}

/**
 * Thrown by {@link settleOrder} when the reference the caller expected is not the reference this
 * payment would produce. Nothing has been sent. Its own class — not a {@link SettleOrderInputError}
 * — so that a caller can branch on it without matching strings: it means the order it was quoted is
 * not the order it is about to pay.
 */
export class SettlementOrderRefMismatchError extends Error {
	readonly expected: Hex;
	readonly computed: Hex;

	constructor(expected: Hex, computed: Hex) {
		super(
			`settleOrder: the expected order reference ${expected} is not the one this payment would produce (${computed}). Nothing was sent.`,
		);
		this.name = "SettlementOrderRefMismatchError";
		this.expected = expected;
		this.computed = computed;
	}
}

/** One call of a UserOp batch. */
export interface SettlementCall {
	readonly to: Address;
	readonly value: bigint;
	readonly data: Hex;
}

/** Parameters for {@link buildSettlementPaymentCalls}. */
export interface BuildSettlementPaymentCallsParams {
	readonly settlement: Address;
	readonly token: Address;
	readonly merchant: Address;
	readonly amount: bigint;
	readonly validUntil: bigint;
	readonly details: Hex;
}

/**
 * The two calls a Settlement payment consists of, in order:
 * `[token.approve(settlement, amount), settlement.pay(token, merchant, amount, validUntil, details)]`.
 *
 * {@link settleOrder} sends exactly this. It is exported so that the shape has ONE definition:
 * anything that has to recognise a payment — a sponsorship policy deciding whether to pay for a
 * UserOp's gas, for instance — can build the expected calls with it instead of restating them.
 *
 * A session key's call policy bounds each call, not how many there are: a batch carrying two `pay`
 * calls passes it. Holding a UserOp to ONE payment is the sponsor's job, and this is its template.
 *
 * @example
 * ```ts
 * import { buildSettlementPaymentCalls } from "kawasekit";
 *
 * const [approve, pay] = buildSettlementPaymentCalls({ settlement, token, merchant, amount, validUntil, details });
 * ```
 */
export function buildSettlementPaymentCalls(
	params: BuildSettlementPaymentCallsParams,
): readonly [SettlementCall, SettlementCall] {
	return [
		{
			to: params.token,
			value: 0n,
			data: encodeFunctionData({
				abi: jpycAbi,
				functionName: "approve",
				args: [params.settlement, params.amount],
			}),
		},
		{
			to: params.settlement,
			value: 0n,
			data: encodeFunctionData({
				abi: settlementAbi,
				functionName: "pay",
				args: [params.token, params.merchant, params.amount, params.validUntil, params.details],
			}),
		},
	] as const;
}

/**
 * Pay an order through `Settlement` from the Kernel smart account, as one sponsored UserOp.
 *
 * Three things are deliberately NOT parameters:
 * - the **payer** — the contract hashes `msg.sender`, so it is `kernelClient.account.address`;
 * - the **`Settlement` address** and the **token** — they come from this package's deployment
 *   tables for `kernelClient.chain`. An order's issuer may tell you which contract to pay; this
 *   function never listens.
 *
 * It does not check the merchant against an allowlist or the amount against a cap: that is the
 * session key's on-chain policy (`createBuyListPolicies`) and the chain's job.
 *
 * **Retrying.** An order can be paid once. A retry of an already-paid order is refused by the
 * contract (`AlreadySettled`), and that refusal most likely surfaces as a THROWN bundler error
 * during gas estimation rather than as `success: false`. So on any failure after submission, do
 * not guess: read `settled(ref)` on the contract. `ref` is returned — and is computable with
 * `hashOrderRef` — before anything is sent.
 *
 * @throws {SettleOrderInputError} If an argument is structurally invalid or the order has expired.
 * @throws {SettlementOrderRefMismatchError} If `expectedRef` is given and differs. Nothing was sent.
 * @throws {SettlementNotAvailableError} If `Settlement` is not deployed on the client's chain.
 *
 * @example
 * ```ts
 * import { settleOrder } from "kawasekit";
 *
 * const { ref, transactionHash } = await settleOrder(kernelClient, {
 *   merchant: order.merchant,
 *   amount: order.amount,
 *   validUntil: order.validUntil,
 *   details: order.details,
 *   expectedRef: order.ref, // what the issuer quoted — checked before anything is sent
 * });
 * ```
 */
export async function settleOrder(
	kernelClient: ConfiguredKernelClient,
	params: SettleOrderParams,
): Promise<SettleOrderResult> {
	if (!isAddress(params.merchant, { strict: false })) {
		throw new SettleOrderInputError(`\`merchant\` is not a valid address: ${params.merchant}`);
	}
	if (params.amount <= 0n) {
		throw new SettleOrderInputError(`\`amount\` must be positive, got ${params.amount}.`);
	}
	if (!BYTES32.test(params.details)) {
		throw new SettleOrderInputError(`\`details\` must be 32 bytes of hex, got ${params.details}`);
	}
	if (params.validUntil > UINT64_MAX) {
		throw new SettleOrderInputError(
			`\`validUntil\` does not fit a uint64, got ${params.validUntil}.`,
		);
	}
	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (params.validUntil <= BigInt(now)) {
		throw new SettleOrderInputError(
			`\`validUntil\` (${params.validUntil}) is in the past (now ${now}); the contract would refuse this order.`,
		);
	}
	if (params.expectedRef !== undefined && !BYTES32.test(params.expectedRef)) {
		throw new SettleOrderInputError(
			`\`expectedRef\` must be 32 bytes of hex, got ${params.expectedRef}`,
		);
	}

	const chainId = kernelClient.chain.id;
	if (!isSupportedChainId(chainId)) {
		throw new SettleOrderInputError(`Chain ID ${chainId} is not a kawasekit-supported chain.`);
	}
	const settlement = getSettlementAddress(chainId satisfies SupportedChainId);
	const token = getJpycAddress(chainId satisfies SupportedChainId);

	const ref = hashOrderRef({
		chainId,
		settlement,
		order: {
			token,
			payer: kernelClient.account.address,
			merchant: params.merchant,
			amount: params.amount,
			validUntil: params.validUntil,
			details: params.details,
		},
	});
	if (params.expectedRef !== undefined && params.expectedRef.toLowerCase() !== ref.toLowerCase()) {
		throw new SettlementOrderRefMismatchError(params.expectedRef, ref);
	}

	const calls = buildSettlementPaymentCalls({
		settlement,
		token,
		merchant: params.merchant,
		amount: params.amount,
		validUntil: params.validUntil,
		details: params.details,
	});
	const callData = await kernelClient.account.encodeCalls([...calls]);
	const userOpHash = await kernelClient.sendUserOperation({ callData });

	if (params.waitForReceipt === false) {
		return { ref, userOpHash, transactionHash: null, success: null };
	}

	const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
	return {
		ref,
		userOpHash,
		transactionHash: receipt.receipt.transactionHash,
		success: receipt.success,
	};
}
