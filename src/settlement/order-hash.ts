/**
 * The Settlement hashing rule — the ONLY place it lives in TypeScript.
 *
 * A Settlement payment carries an order reference (`ref`), and that reference commits to the
 * order's contents (`details`). Two hashes, computed by two different parties:
 *
 * | hash      | computed by                  | EIP-712                                          |
 * |-----------|------------------------------|--------------------------------------------------|
 * | `ref`     | the `Settlement` contract    | `hashTypedData` of `Order`, under the domain     |
 * | `details` | off chain only               | `hashStruct` of `OrderDetails` — NO domain       |
 *
 * The contract computes `ref` itself from `pay`'s arguments and `msg.sender`, so a reference that
 * disagrees with the token, payer, merchant, amount or expiry actually used cannot exist. It never
 * sees the pre-image of `details`: nothing readable about a purchase reaches the chain, and the
 * per-order `salt` keeps a small order from being guessed out of the hash.
 *
 * Anyone holding an order's contents can therefore check a payment without trusting whoever issued
 * the order: recompute `details`, recompute `ref`, and look for `Settled(ref, …)`.
 *
 * Both functions here are pinned, byte for byte, against the contract by a cross-language
 * conformance corpus (`order-hash.conformance.test.ts`).
 *
 * @packageDocumentation
 */
import type { Address, Hex } from "viem";
import { hashStruct, hashTypedData } from "viem";

/** EIP-712 domain `name` of every `Settlement` deployment. */
export const SETTLEMENT_EIP712_DOMAIN_NAME = "KawasekitSettlement";

/** EIP-712 domain `version` of `Settlement` v1. */
export const SETTLEMENT_EIP712_DOMAIN_VERSION = "1";

/**
 * EIP-712 types of the order a payment settles. Exported so that out-of-process and cross-language
 * consumers bind to this exact definition — field order and type strings are part of the hash.
 *
 * @example
 * ```ts
 * import { hashTypedData } from "viem";
 * import { settlementOrderTypes } from "kawasekit";
 *
 * const ref = hashTypedData({ domain, types: settlementOrderTypes, primaryType: "Order", message });
 * ```
 */
export const settlementOrderTypes = {
	Order: [
		{ name: "token", type: "address" },
		{ name: "payer", type: "address" },
		{ name: "merchant", type: "address" },
		{ name: "amount", type: "uint256" },
		{ name: "validUntil", type: "uint64" },
		{ name: "details", type: "bytes32" },
	],
} as const;

/**
 * EIP-712 types of an order's contents — what `details` commits to.
 *
 * @example
 * ```ts
 * import { hashStruct } from "viem";
 * import { settlementOrderDetailsTypes } from "kawasekit";
 *
 * const details = hashStruct({ types: settlementOrderDetailsTypes, primaryType: "OrderDetails", data });
 * ```
 */
export const settlementOrderDetailsTypes = {
	OrderDetails: [
		{ name: "orderId", type: "string" },
		{ name: "lines", type: "OrderLine[]" },
		{ name: "salt", type: "bytes32" },
	],
	OrderLine: [
		{ name: "itemId", type: "string" },
		{ name: "unitPrice", type: "uint256" },
		{ name: "quantity", type: "uint32" },
	],
} as const;

/** One line of an order: an item, its unit price in the token's smallest unit, and a quantity. */
export interface SettlementOrderLine {
	readonly itemId: string;
	/** Raw token units (JPYC has 18 decimals). */
	readonly unitPrice: bigint;
	/** A `uint32` on the wire: an integer in `0 … 4_294_967_295`. */
	readonly quantity: number;
}

/** The fields `Settlement.pay` folds into an order reference. */
export interface SettlementOrder {
	/** The ERC-20 being paid. */
	readonly token: Address;
	/** The account that pays. On chain this is `msg.sender` — never a free choice. */
	readonly payer: Address;
	/** The recipient. */
	readonly merchant: Address;
	/** The exact amount, in the token's smallest unit. */
	readonly amount: bigint;
	/** Unix seconds after which the order can no longer be paid. A `uint64`, hence `bigint`. */
	readonly validUntil: bigint;
	/** The commitment to the order's contents — see {@link hashOrderDetails}. */
	readonly details: Hex;
}

/** Parameters for {@link hashOrderDetails}. */
export interface HashOrderDetailsParams {
	readonly orderId: string;
	readonly lines: readonly SettlementOrderLine[];
	/** 32 random bytes, fresh per order, so the contents cannot be guessed from the hash. */
	readonly salt: Hex;
}

/**
 * `details` — the off-chain commitment to an order's contents: its id, its lines and a salt.
 *
 * Strings are hashed as UTF-8 bytes, so non-ASCII ids are fine. An empty `lines` array is valid.
 *
 * @throws viem's encoding error if `salt` is not 32 bytes of hex or a `quantity` does not fit a
 *   `uint32`. `hashStruct` does not run viem's typed-data validation, so such an input surfaces as
 *   that raw error rather than a friendlier one — validate at the edge if the input is untrusted.
 *
 * @example
 * ```ts
 * import { hashOrderDetails } from "kawasekit";
 *
 * const details = hashOrderDetails({
 *   orderId: "ord_01J8ZK3V7Q",
 *   lines: [{ itemId: "item_espresso", unitPrice: 1200n * 10n ** 18n, quantity: 1 }],
 *   salt: "0x…32 bytes…",
 * });
 * ```
 */
export function hashOrderDetails(params: HashOrderDetailsParams): Hex {
	return hashStruct({
		types: settlementOrderDetailsTypes,
		primaryType: "OrderDetails",
		data: { orderId: params.orderId, lines: [...params.lines], salt: params.salt },
	});
}

/** Parameters for {@link hashOrderRef}. */
export interface HashOrderRefParams {
	readonly chainId: number;
	/** The `Settlement` deployment the order will be paid through. */
	readonly settlement: Address;
	readonly order: SettlementOrder;
}

/**
 * `ref` — the order reference, computed exactly the way `Settlement.orderRef` computes it on chain:
 * an EIP-712 digest under the domain `KawasekitSettlement` / `1` / `chainId` / `settlement`.
 *
 * The chain id and the deployment are part of the domain, so a reference cannot be replayed on
 * another chain or against another version of the contract.
 *
 * @example
 * ```ts
 * import { getJpycAddress, getSettlementAddress, hashOrderRef, polygonAmoy } from "kawasekit";
 *
 * const ref = hashOrderRef({
 *   chainId: polygonAmoy.id,
 *   settlement: getSettlementAddress(polygonAmoy.id),
 *   order: { token: getJpycAddress(polygonAmoy.id), payer, merchant, amount, validUntil, details },
 * });
 * ```
 */
export function hashOrderRef(params: HashOrderRefParams): Hex {
	return hashTypedData({
		domain: {
			name: SETTLEMENT_EIP712_DOMAIN_NAME,
			version: SETTLEMENT_EIP712_DOMAIN_VERSION,
			chainId: params.chainId,
			verifyingContract: params.settlement,
		},
		types: settlementOrderTypes,
		primaryType: "Order",
		message: params.order,
	});
}
