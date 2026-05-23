/**
 * EIP-3009 typed-data builders and signing helpers.
 *
 * Token-agnostic: works for any EIP-3009-compliant token (JPYC, USDC, USDP,
 * Centre FiatToken family). Pure off-chain construction — no chain RPC, no
 * submission. Submission is the caller's job (M3 x402 flow, or arbitrary
 * gas-paying relayer).
 *
 * @packageDocumentation
 */

import { type Account, type Address, getAddress, type Hex, parseSignature } from "viem";

// ---------------------------------------------------------------------------
// Domain & typed-data shapes
// ---------------------------------------------------------------------------

/**
 * EIP-712 domain for an EIP-3009-compliant token.
 *
 * `name` and `version` MUST match the values the token used when computing
 * its `DOMAIN_SEPARATOR`. For JPYC see {@link JPYC_EIP712_DOMAIN_HINT}.
 */
export interface Eip3009Domain {
	readonly name: string;
	readonly version: string;
	readonly chainId: number;
	readonly verifyingContract: Address;
}

/** Message body for {@link signTransferWithAuthorization}. */
export interface TransferWithAuthorizationMessage {
	readonly from: Address;
	readonly to: Address;
	readonly value: bigint;
	readonly validAfter: bigint;
	readonly validBefore: bigint;
	/** 32-byte random nonce. Generate with {@link generateAuthorizationNonce}. */
	readonly nonce: Hex;
}

/** Message body for {@link signReceiveWithAuthorization}. */
export type ReceiveWithAuthorizationMessage = TransferWithAuthorizationMessage;

/** Message body for {@link signCancelAuthorization}. */
export interface CancelAuthorizationMessage {
	readonly authorizer: Address;
	readonly nonce: Hex;
}

/**
 * A signed EIP-3009 authorization, ready to be passed to the token's
 * `*WithAuthorization` entrypoint as `(v, r, s)`.
 */
export interface SignedAuthorization<TMessage> {
	readonly signature: Hex;
	readonly v: number;
	readonly r: Hex;
	readonly s: Hex;
	readonly domain: Eip3009Domain;
	readonly message: TMessage;
}

// ---------------------------------------------------------------------------
// EIP-712 type definitions (must match EIP-3009 byte-for-byte)
// ---------------------------------------------------------------------------

const transferWithAuthorizationTypes = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

const receiveWithAuthorizationTypes = {
	ReceiveWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

const cancelAuthorizationTypes = {
	CancelAuthorization: [
		{ name: "authorizer", type: "address" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random 32-byte EIP-3009 nonce.
 *
 * The nonce only needs to be unique per `(authorizer, contract)` — duplicates
 * across different tokens are harmless because the contract scopes them.
 *
 * @example
 * ```ts
 * import { generateAuthorizationNonce } from "kawasekit";
 *
 * const nonce = generateAuthorizationNonce();
 * ```
 */
export function generateAuthorizationNonce(): Hex {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * Returns a `validBefore` UNIX timestamp `seconds` in the future.
 *
 * @param seconds - Lifetime of the authorization, in seconds.
 * @param nowSec - Optional override of "now" (defaults to {@link Date.now}).
 *
 * @example
 * ```ts
 * import { authorizationDeadlineFromNow } from "kawasekit";
 *
 * const validBefore = authorizationDeadlineFromNow(60 * 5); // 5 minutes
 * ```
 */
export function authorizationDeadlineFromNow(seconds: number, nowSec?: bigint): bigint {
	const now = nowSec ?? BigInt(Math.floor(Date.now() / 1000));
	return now + BigInt(seconds);
}

function requireSignTypedData(account: Account): NonNullable<Account["signTypedData"]> {
	if (!account.signTypedData) {
		throw new Error(
			`Account ${account.address} cannot sign typed data — pass a LocalAccount or a JsonRpcAccount bound to a WalletClient.`,
		);
	}
	return account.signTypedData.bind(account);
}

function assertSignerMatches(account: Account, expectedFrom: Address, role: string): void {
	if (getAddress(account.address) !== getAddress(expectedFrom)) {
		throw new Error(
			`EIP-3009 ${role} signature must come from \`${role === "cancel" ? "authorizer" : "from"}\`: account is ${account.address}, message says ${expectedFrom}.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/**
 * Signs an EIP-3009 `TransferWithAuthorization` message.
 *
 * The signing account MUST equal `message.from` — EIP-3009 rejects signatures
 * from anyone else (the on-chain check is pure `ecrecover` against `from`).
 *
 * @example
 * ```ts
 * import { privateKeyToAccount } from "viem/accounts";
 * import {
 *   authorizationDeadlineFromNow,
 *   generateAuthorizationNonce,
 *   JPYC_EIP712_DOMAIN_HINT,
 *   polygon,
 *   signTransferWithAuthorization,
 * } from "kawasekit";
 *
 * const account = privateKeyToAccount("0x...");
 * const signed = await signTransferWithAuthorization(account, {
 *   ...JPYC_EIP712_DOMAIN_HINT,
 *   chainId: polygon.id,
 *   verifyingContract: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
 * }, {
 *   from: account.address,
 *   to: "0xBeef...",
 *   value: 100n * 10n ** 18n,
 *   validAfter: 0n,
 *   validBefore: authorizationDeadlineFromNow(300),
 *   nonce: generateAuthorizationNonce(),
 * });
 * // → submit (v, r, s) to token.transferWithAuthorization(...)
 * ```
 */
export async function signTransferWithAuthorization(
	account: Account,
	domain: Eip3009Domain,
	message: TransferWithAuthorizationMessage,
): Promise<SignedAuthorization<TransferWithAuthorizationMessage>> {
	assertSignerMatches(account, message.from, "transfer");
	const sign = requireSignTypedData(account);
	const signature = await sign({
		domain,
		types: transferWithAuthorizationTypes,
		primaryType: "TransferWithAuthorization",
		message,
	});
	return splitAuthorization(signature, domain, message);
}

/**
 * Signs an EIP-3009 `ReceiveWithAuthorization` message.
 *
 * Differs from {@link signTransferWithAuthorization} in two ways:
 * 1. Uses the `ReceiveWithAuthorization` EIP-712 type.
 * 2. The contract additionally enforces `msg.sender == to` at submission
 *    time, so only `to` (or a relayer impersonating `to` — impossible in
 *    practice) can land the tx.
 */
export async function signReceiveWithAuthorization(
	account: Account,
	domain: Eip3009Domain,
	message: ReceiveWithAuthorizationMessage,
): Promise<SignedAuthorization<ReceiveWithAuthorizationMessage>> {
	assertSignerMatches(account, message.from, "receive");
	const sign = requireSignTypedData(account);
	const signature = await sign({
		domain,
		types: receiveWithAuthorizationTypes,
		primaryType: "ReceiveWithAuthorization",
		message,
	});
	return splitAuthorization(signature, domain, message);
}

/**
 * Signs an EIP-3009 `CancelAuthorization` message.
 *
 * Cancelling consumes the nonce so a later `transferWithAuthorization` or
 * `receiveWithAuthorization` with the same nonce will revert.
 */
export async function signCancelAuthorization(
	account: Account,
	domain: Eip3009Domain,
	message: CancelAuthorizationMessage,
): Promise<SignedAuthorization<CancelAuthorizationMessage>> {
	assertSignerMatches(account, message.authorizer, "cancel");
	const sign = requireSignTypedData(account);
	const signature = await sign({
		domain,
		types: cancelAuthorizationTypes,
		primaryType: "CancelAuthorization",
		message,
	});
	return splitAuthorization(signature, domain, message);
}

function splitAuthorization<TMessage>(
	signature: Hex,
	domain: Eip3009Domain,
	message: TMessage,
): SignedAuthorization<TMessage> {
	const parsed = parseSignature(signature);
	// viem's parseSignature returns yParity ∈ {0, 1} as well as v when present.
	const v = parsed.v !== undefined ? Number(parsed.v) : (parsed.yParity ?? 0) + 27;
	return {
		signature,
		v,
		r: parsed.r,
		s: parsed.s,
		domain,
		message,
	};
}
