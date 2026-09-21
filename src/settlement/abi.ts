/**
 * The `Settlement` contract's ABI — everything it has: two functions that matter, one getter, one
 * event, three errors.
 *
 * @packageDocumentation
 */

/**
 * ABI of `Settlement` v1.
 *
 * - `pay` — move `amount` of `token` from the caller to `merchant`, settling one order. The caller
 *   must have approved the contract for `amount`; a smart account does both in one UserOp.
 * - `orderRef` — the order reference for these fields, as the contract computes it.
 * - `settled` — `true` once the order with that reference has been paid.
 * - `Settled` — the single fact a payment leaves behind; `ref` is indexed, so a payment can be
 *   found by its reference alone.
 * - `AlreadySettled(ref)` / `Expired(validUntil)` / `ZeroAmount()` — why `pay` refused.
 *
 * @example
 * ```ts
 * import { getSettlementAddress, polygonAmoy, settlementAbi } from "kawasekit";
 *
 * const paid = await publicClient.readContract({
 *   address: getSettlementAddress(polygonAmoy.id),
 *   abi: settlementAbi,
 *   functionName: "settled",
 *   args: [ref],
 * });
 * ```
 */
export const settlementAbi = [
	// ----- functions -----
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
	{
		type: "function",
		name: "orderRef",
		stateMutability: "view",
		inputs: [
			{ name: "token", type: "address" },
			{ name: "payer", type: "address" },
			{ name: "merchant", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "validUntil", type: "uint64" },
			{ name: "details", type: "bytes32" },
		],
		outputs: [{ name: "", type: "bytes32" }],
	},
	{
		type: "function",
		name: "settled",
		stateMutability: "view",
		inputs: [{ name: "ref", type: "bytes32" }],
		outputs: [{ name: "", type: "bool" }],
	},
	// ----- events -----
	{
		type: "event",
		name: "Settled",
		inputs: [
			{ name: "ref", type: "bytes32", indexed: true },
			{ name: "payer", type: "address", indexed: true },
			{ name: "merchant", type: "address", indexed: true },
			{ name: "token", type: "address", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
		],
	},
	// ----- errors -----
	{ type: "error", name: "ZeroAmount", inputs: [] },
	{ type: "error", name: "Expired", inputs: [{ name: "validUntil", type: "uint64" }] },
	{ type: "error", name: "AlreadySettled", inputs: [{ name: "ref", type: "bytes32" }] },
] as const;
