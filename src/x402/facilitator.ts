/**
 * Facilitator implementations: local viem-backed (`createSelfFacilitator`) and
 * HTTP-proxied (`createHttpFacilitator`).
 *
 * Both expose the same {@link Facilitator} interface — `verify` / `settle` /
 * `supported` — so {@link createX402Handler} can swap one for the other based
 * on environment (testnet vs. mainnet, self-hosted vs. Coinbase CDP).
 *
 * Spec references:
 * - Error codes: x402 v2 spec §9 (Error Handling)
 * - Verification steps: scheme_exact_evm.md §1 Phase 2
 * - Facilitator HTTP API: x402 v2 spec §7
 *
 * @packageDocumentation
 */

import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { getAddress, parseSignature, recoverTypedDataAddress } from "viem";
import { getChain, isSupportedChainId, type SupportedChainId } from "../chains";
import {
	invokeHookSafely,
	type ObservabilityHooks,
	type SettleEvent,
	type VerifyEvent,
} from "../observability/hooks";
import { JPYC_EIP712_DOMAIN_HINT, JPYC_V2_ADDRESS, jpycAbi } from "../tokens/jpyc";
import type {
	Facilitator,
	X402PaymentRequirements,
	X402SettleRequest,
	X402SettleResponse,
	X402SupportedKind,
	X402SupportedResponse,
	X402VerifyRequest,
	X402VerifyResponse,
} from "./types";
import { chainIdToX402Network, X402_VERSION, x402NetworkToChainId } from "./types";

// ---------------------------------------------------------------------------
// Error code vocabulary (x402 v2 §9)
// ---------------------------------------------------------------------------

/**
 * Standard x402 v2 error codes used as `invalidReason` (verify) and
 * `errorReason` (settle). Kept as string literals so that consumers can
 * `switch` on the union; values match the spec verbatim.
 */
export const X402_FACILITATOR_ERROR_CODES = {
	insufficient_funds: "insufficient_funds",
	invalid_exact_evm_payload_authorization_valid_after:
		"invalid_exact_evm_payload_authorization_valid_after",
	invalid_exact_evm_payload_authorization_valid_before:
		"invalid_exact_evm_payload_authorization_valid_before",
	invalid_exact_evm_payload_authorization_value_mismatch:
		"invalid_exact_evm_payload_authorization_value_mismatch",
	invalid_exact_evm_payload_recipient_mismatch: "invalid_exact_evm_payload_recipient_mismatch",
	invalid_exact_evm_payload_signature: "invalid_exact_evm_payload_signature",
	invalid_network: "invalid_network",
	invalid_payload: "invalid_payload",
	invalid_scheme: "invalid_scheme",
	invalid_transaction_state: "invalid_transaction_state",
	unexpected_settle_error: "unexpected_settle_error",
	unexpected_verify_error: "unexpected_verify_error",
} as const;

type X402FacilitatorErrorCode =
	(typeof X402_FACILITATOR_ERROR_CODES)[keyof typeof X402_FACILITATOR_ERROR_CODES];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface NarrowExactEvmPayload {
	readonly signature: Hex;
	readonly authorization: {
		readonly from: Address;
		readonly to: Address;
		readonly value: string;
		readonly validAfter: string;
		readonly validBefore: string;
		readonly nonce: Hex;
	};
}

function isHex(value: unknown): value is Hex {
	return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function isAddressLike(value: unknown): value is Address {
	return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isDecimalString(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function narrowExactEvmPayload(payload: Record<string, unknown>): NarrowExactEvmPayload | null {
	const p = payload as { signature?: unknown; authorization?: unknown };
	if (!isHex(p.signature)) return null;
	if (typeof p.authorization !== "object" || p.authorization === null) return null;
	const a = p.authorization as {
		from?: unknown;
		to?: unknown;
		value?: unknown;
		validAfter?: unknown;
		validBefore?: unknown;
		nonce?: unknown;
	};
	if (!isAddressLike(a.from)) return null;
	if (!isAddressLike(a.to)) return null;
	if (!isDecimalString(a.value)) return null;
	if (!isDecimalString(a.validAfter)) return null;
	if (!isDecimalString(a.validBefore)) return null;
	if (!isHex(a.nonce)) return null;
	return {
		signature: p.signature,
		authorization: {
			from: a.from,
			to: a.to,
			value: a.value,
			validAfter: a.validAfter,
			validBefore: a.validBefore,
			nonce: a.nonce,
		},
	};
}

const TRANSFER_AUTHORIZATION_TYPES = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

function resolveDomain(requirements: X402PaymentRequirements): {
	readonly name: string;
	readonly version: string;
} {
	const extra = requirements.extra as { name?: unknown; version?: unknown };
	if (typeof extra.name === "string" && typeof extra.version === "string") {
		return { name: extra.name, version: extra.version };
	}
	if (getAddress(requirements.asset) === getAddress(JPYC_V2_ADDRESS)) {
		return JPYC_EIP712_DOMAIN_HINT;
	}
	throw new Error(
		"resolveDomain: `extra.name` and `extra.version` are required for non-JPYC assets",
	);
}

function failVerify(
	reason: X402FacilitatorErrorCode,
	message?: string,
	payer?: Address,
): X402VerifyResponse {
	if (message !== undefined && payer !== undefined) {
		return { isValid: false, invalidReason: reason, invalidMessage: message, payer };
	}
	if (message !== undefined) {
		return { isValid: false, invalidReason: reason, invalidMessage: message };
	}
	if (payer !== undefined) {
		return { isValid: false, invalidReason: reason, payer };
	}
	return { isValid: false, invalidReason: reason };
}

function failSettle(
	network: X402SettleResponse["network"],
	reason: X402FacilitatorErrorCode,
	options: { message?: string; payer?: Address; transaction?: string } = {},
): X402SettleResponse {
	const transaction = options.transaction ?? "";
	const base: X402SettleResponse = {
		success: false,
		errorReason: reason,
		transaction,
		network,
	};
	if (options.message !== undefined && options.payer !== undefined) {
		return { ...base, errorMessage: options.message, payer: options.payer };
	}
	if (options.message !== undefined) {
		return { ...base, errorMessage: options.message };
	}
	if (options.payer !== undefined) {
		return { ...base, payer: options.payer };
	}
	return base;
}

// ---------------------------------------------------------------------------
// Self-facilitator (local viem-backed)
// ---------------------------------------------------------------------------

/** Parameters for {@link createSelfFacilitator}. */
export interface CreateSelfFacilitatorParams {
	/**
	 * Declared production-vs-test intent. MUST agree with `walletClient.chain`:
	 * - `"mainnet"` requires a kawasekit chain with `isTestnet === false`.
	 * - `"testnet"` requires a kawasekit chain with `isTestnet === true`.
	 *
	 * The check is enforced at construction time and throws a fatal error on
	 * disagreement. The point is to make accidentally pointing a testnet
	 * configuration at a mainnet RPC (or vice versa) impossible — that mistake
	 * would broadcast real-fund transactions silently.
	 */
	readonly network: "mainnet" | "testnet";
	/**
	 * Pre-configured wallet client that broadcasts settlement transactions.
	 * The bound account pays gas. `walletClient.chain.id` determines the only
	 * chain this facilitator serves, and `walletClient.chain.isTestnet` MUST
	 * agree with the declared {@link network}.
	 */
	readonly walletClient: WalletClient<Transport, Chain, Account>;
	/**
	 * Pre-configured public client on the same chain as `walletClient`. Used
	 * for balance and authorization-state reads during verify.
	 */
	readonly publicClient: PublicClient<Transport, Chain>;
	/**
	 * Timeout (ms) for `waitForTransactionReceipt` during settle.
	 * Defaults to 60_000.
	 */
	readonly receiptTimeoutMs?: number;
	/**
	 * Optional observability callbacks. Hooks are fire-and-forget — any throw
	 * or rejection inside a hook is silently discarded and never propagates to
	 * the verify / settle return path. See {@link ObservabilityHooks}.
	 *
	 * The facilitator emits `onVerify` after every `verify()` call (including
	 * the internal re-verify that runs at the start of `settle()`) and
	 * `onSettle` after every `settle()` call.
	 */
	readonly hooks?: ObservabilityHooks;
}

/**
 * Builds a facilitator that verifies and broadcasts exact-EVM EIP-3009
 * payments using a locally-held EOA private key (gas payer).
 *
 * Intended for self-hosted paywalls and testnet (Polygon Amoy) where the
 * Coinbase CDP facilitator is not guaranteed to support the chain.
 *
 * **Concurrent settle() calls**: under any meaningful load (e.g. an LLM
 * agent fan-out) you will issue multiple `transferWithAuthorization`
 * broadcasts from the same facilitator EOA in parallel. Without local nonce
 * sequencing those broadcasts race for the same on-chain nonce and only
 * one lands. Pass viem's `nonceManager` when constructing the facilitator
 * account to make this safe — see `@example` below.
 *
 * @example
 * ```ts
 * import { createPublicClient, createWalletClient, http } from "viem";
 * import { nonceManager, privateKeyToAccount } from "viem/accounts";
 * import { createSelfFacilitator, polygonAmoy } from "kawasekit";
 *
 * // `nonceManager` is REQUIRED whenever you expect concurrent settlements.
 * const account = privateKeyToAccount(
 *   process.env.FACILITATOR_PK as `0x${string}`,
 *   { nonceManager },
 * );
 * const transport = http(process.env.RPC_URL);
 * const facilitator = createSelfFacilitator({
 *   network: "testnet", // must agree with polygonAmoy.isTestnet === true
 *   walletClient: createWalletClient({ chain: polygonAmoy, transport, account }),
 *   publicClient: createPublicClient({ chain: polygonAmoy, transport }),
 * });
 * ```
 */
export function createSelfFacilitator(params: CreateSelfFacilitatorParams): Facilitator {
	const { walletClient, publicClient } = params;
	const receiptTimeoutMs = params.receiptTimeoutMs ?? 60_000;
	const facilitatorChainId = walletClient.chain.id;
	if (!isSupportedChainId(facilitatorChainId)) {
		throw new Error(
			`createSelfFacilitator: walletClient.chain.id ${facilitatorChainId} is not a kawasekit-supported chain`,
		);
	}
	const supportedChainId: SupportedChainId = facilitatorChainId;
	const chain = getChain(supportedChainId);
	if (params.network === "mainnet" && chain.isTestnet) {
		throw new Error(
			`createSelfFacilitator: network="mainnet" but walletClient.chain "${chain.name}" (chainId ${supportedChainId}) is a testnet`,
		);
	}
	if (params.network === "testnet" && !chain.isTestnet) {
		throw new Error(
			`createSelfFacilitator: network="testnet" but walletClient.chain "${chain.name}" (chainId ${supportedChainId}) is a mainnet — refusing to broadcast with real funds`,
		);
	}
	const network = chainIdToX402Network(supportedChainId);
	const hooks = params.hooks;

	function buildVerifyEvent(
		req: X402VerifyRequest,
		response: X402VerifyResponse,
		startedAtMs: number,
	): VerifyEvent {
		const durationMs = Date.now() - startedAtMs;
		const eventNetwork = req.paymentRequirements.network;
		if (response.isValid && response.payer !== undefined) {
			return {
				kind: "verify",
				result: "success",
				startedAtMs,
				durationMs,
				network: eventNetwork,
				payer: response.payer,
				amount: req.paymentRequirements.amount,
			};
		}
		if (response.isValid) {
			// verifyCore always sets payer on success, but the X402VerifyResponse
			// type permits it to be absent; downgrade to a synthetic failure
			// event so the discriminated union remains sound for adapters.
			return {
				kind: "verify",
				result: "failure",
				startedAtMs,
				durationMs,
				network: eventNetwork,
				invalidReason: "unexpected_verify_error",
				invalidMessage: "verify succeeded but payer was not surfaced",
			};
		}
		const base = {
			kind: "verify" as const,
			result: "failure" as const,
			startedAtMs,
			durationMs,
			network: eventNetwork,
			invalidReason: response.invalidReason ?? "unexpected_verify_error",
		};
		if (response.payer !== undefined && response.invalidMessage !== undefined) {
			return { ...base, payer: response.payer, invalidMessage: response.invalidMessage };
		}
		if (response.payer !== undefined) {
			return { ...base, payer: response.payer };
		}
		if (response.invalidMessage !== undefined) {
			return { ...base, invalidMessage: response.invalidMessage };
		}
		return base;
	}

	function buildSettleEvent(
		req: X402SettleRequest,
		response: X402SettleResponse,
		startedAtMs: number,
	): SettleEvent {
		const durationMs = Date.now() - startedAtMs;
		const eventNetwork = req.paymentRequirements.network;
		if (response.success && response.payer !== undefined) {
			return {
				kind: "settle",
				result: "success",
				startedAtMs,
				durationMs,
				network: eventNetwork,
				payer: response.payer,
				amount: req.paymentRequirements.amount,
				transaction: response.transaction as Hex,
			};
		}
		if (response.success) {
			// settleCore always sets payer on success; the spec response type
			// permits it to be absent so we downgrade to a synthetic failure
			// rather than emit a malformed event.
			return {
				kind: "settle",
				result: "failure",
				startedAtMs,
				durationMs,
				network: eventNetwork,
				errorReason: "unexpected_settle_error",
				errorMessage: "settle succeeded but payer was not surfaced",
				transaction: response.transaction as Hex,
			};
		}
		const base = {
			kind: "settle" as const,
			result: "failure" as const,
			startedAtMs,
			durationMs,
			network: eventNetwork,
			errorReason: response.errorReason ?? "unexpected_settle_error",
		};
		const withPayer = response.payer !== undefined ? { ...base, payer: response.payer } : base;
		const withMessage =
			response.errorMessage !== undefined
				? { ...withPayer, errorMessage: response.errorMessage }
				: withPayer;
		if (response.transaction !== "" && response.transaction !== undefined) {
			return { ...withMessage, transaction: response.transaction as Hex };
		}
		return withMessage;
	}

	async function verifyCore(req: X402VerifyRequest): Promise<X402VerifyResponse> {
		// 1. Scheme / network gates
		if (req.paymentRequirements.scheme !== "exact") {
			return failVerify("invalid_scheme");
		}
		if (req.paymentPayload.accepted.scheme !== "exact") {
			return failVerify("invalid_scheme");
		}
		const reqChainId = x402NetworkToChainId(req.paymentRequirements.network);
		if (reqChainId !== supportedChainId) {
			return failVerify("invalid_network");
		}
		if (req.paymentPayload.accepted.network !== req.paymentRequirements.network) {
			return failVerify("invalid_network");
		}

		// 2. Narrow scheme-specific payload
		const exact = narrowExactEvmPayload(req.paymentPayload.payload);
		if (exact === null) {
			return failVerify("invalid_payload");
		}
		const auth = exact.authorization;

		// 3. Parameter matching against requirements
		if (auth.value !== req.paymentRequirements.amount) {
			return failVerify(
				"invalid_exact_evm_payload_authorization_value_mismatch",
				undefined,
				auth.from,
			);
		}
		if (getAddress(auth.to) !== getAddress(req.paymentRequirements.payTo)) {
			return failVerify("invalid_exact_evm_payload_recipient_mismatch", undefined, auth.from);
		}

		// 4. Time window
		const now = BigInt(Math.floor(Date.now() / 1000));
		const validAfter = BigInt(auth.validAfter);
		const validBefore = BigInt(auth.validBefore);
		if (now < validAfter) {
			return failVerify(
				"invalid_exact_evm_payload_authorization_valid_after",
				undefined,
				auth.from,
			);
		}
		if (now >= validBefore) {
			return failVerify(
				"invalid_exact_evm_payload_authorization_valid_before",
				undefined,
				auth.from,
			);
		}

		// 5. Signature recovery
		let recovered: Address;
		try {
			const domain = resolveDomain(req.paymentRequirements);
			recovered = await recoverTypedDataAddress({
				domain: {
					name: domain.name,
					version: domain.version,
					chainId: reqChainId,
					verifyingContract: req.paymentRequirements.asset,
				},
				types: TRANSFER_AUTHORIZATION_TYPES,
				primaryType: "TransferWithAuthorization",
				message: {
					from: auth.from,
					to: auth.to,
					value: BigInt(auth.value),
					validAfter,
					validBefore,
					nonce: auth.nonce,
				},
				signature: exact.signature,
			});
		} catch (cause) {
			return failVerify(
				"unexpected_verify_error",
				cause instanceof Error ? cause.message : String(cause),
				auth.from,
			);
		}
		if (getAddress(recovered) !== getAddress(auth.from)) {
			return failVerify("invalid_exact_evm_payload_signature", undefined, auth.from);
		}

		// 6. On-chain reads: balance + nonce-not-used
		try {
			const [balance, used] = await Promise.all([
				publicClient.readContract({
					address: req.paymentRequirements.asset,
					abi: jpycAbi,
					functionName: "balanceOf",
					args: [auth.from],
				}),
				publicClient.readContract({
					address: req.paymentRequirements.asset,
					abi: jpycAbi,
					functionName: "authorizationState",
					args: [auth.from, auth.nonce],
				}),
			]);
			if (used) {
				return failVerify("invalid_payload", "authorization nonce already used", auth.from);
			}
			if ((balance as bigint) < BigInt(auth.value)) {
				return failVerify("insufficient_funds", undefined, auth.from);
			}
		} catch (cause) {
			return failVerify(
				"unexpected_verify_error",
				cause instanceof Error ? cause.message : String(cause),
				auth.from,
			);
		}

		return { isValid: true, payer: auth.from };
	}

	async function settleCore(req: X402SettleRequest): Promise<X402SettleResponse> {
		// Re-verify before broadcasting. The wrapped `verify` is used so the
		// internal re-verify also emits onVerify; operators can dedupe in their
		// hook if they don't want the extra event.
		const verifyResult = await verify(req);
		if (!verifyResult.isValid) {
			return failSettle(
				req.paymentRequirements.network,
				(verifyResult.invalidReason as X402FacilitatorErrorCode) ?? "unexpected_settle_error",
				{
					...(verifyResult.invalidMessage !== undefined
						? { message: verifyResult.invalidMessage }
						: {}),
					...(verifyResult.payer !== undefined ? { payer: verifyResult.payer } : {}),
				},
			);
		}

		const exact = narrowExactEvmPayload(req.paymentPayload.payload);
		if (exact === null) {
			return failSettle(req.paymentRequirements.network, "invalid_payload");
		}
		const auth = exact.authorization;
		const parsed = parseSignature(exact.signature);
		const v = parsed.v !== undefined ? Number(parsed.v) : (parsed.yParity ?? 0) + 27;

		let txHash: Hex;
		try {
			txHash = await walletClient.writeContract({
				address: req.paymentRequirements.asset,
				abi: jpycAbi,
				functionName: "transferWithAuthorization",
				args: [
					auth.from,
					auth.to,
					BigInt(auth.value),
					BigInt(auth.validAfter),
					BigInt(auth.validBefore),
					auth.nonce,
					v,
					parsed.r,
					parsed.s,
				],
			});
		} catch (cause) {
			return failSettle(req.paymentRequirements.network, "unexpected_settle_error", {
				message: cause instanceof Error ? cause.message : String(cause),
				payer: auth.from,
			});
		}

		try {
			const receipt = await publicClient.waitForTransactionReceipt({
				hash: txHash,
				timeout: receiptTimeoutMs,
			});
			if (receipt.status !== "success") {
				return failSettle(req.paymentRequirements.network, "invalid_transaction_state", {
					transaction: txHash,
					payer: auth.from,
				});
			}
		} catch (cause) {
			return failSettle(req.paymentRequirements.network, "unexpected_settle_error", {
				message: cause instanceof Error ? cause.message : String(cause),
				payer: auth.from,
				transaction: txHash,
			});
		}

		return {
			success: true,
			transaction: txHash,
			network: req.paymentRequirements.network,
			payer: auth.from,
			amount: auth.value,
		};
	}

	async function verify(req: X402VerifyRequest): Promise<X402VerifyResponse> {
		const startedAtMs = Date.now();
		const result = await verifyCore(req);
		invokeHookSafely(hooks?.onVerify, buildVerifyEvent(req, result, startedAtMs));
		return result;
	}

	async function settle(req: X402SettleRequest): Promise<X402SettleResponse> {
		const startedAtMs = Date.now();
		const result = await settleCore(req);
		invokeHookSafely(hooks?.onSettle, buildSettleEvent(req, result, startedAtMs));
		return result;
	}

	async function supportedInternal(): Promise<X402SupportedResponse> {
		const kind: X402SupportedKind = {
			x402Version: X402_VERSION,
			scheme: "exact",
			network,
		};
		return {
			kinds: [kind],
			extensions: [],
			signers: { "eip155:*": [walletClient.account.address] },
		};
	}

	return {
		verify,
		settle,
		supported: supportedInternal,
	};
}

// ---------------------------------------------------------------------------
// HTTP-proxied facilitator (Coinbase CDP and any other x402 v2-compliant
// facilitator endpoint)
// ---------------------------------------------------------------------------

/** Parameters for {@link createHttpFacilitator}. */
export interface CreateHttpFacilitatorParams {
	/**
	 * Base URL of the facilitator service (Coinbase CDP, your own host, any
	 * x402 v2-compliant endpoint). Endpoints `/verify`, `/settle`, `/supported`
	 * are POST / POST / GET respectively relative to this URL. Trailing slash
	 * is stripped.
	 */
	readonly baseUrl: string;
	/**
	 * Optional callback invoked per request that returns headers to merge
	 * into the outbound request (typically `Authorization`). Receives the
	 * endpoint name so the caller can compute distinct signatures per route.
	 */
	readonly getAuthHeaders?: (
		endpoint: "verify" | "settle" | "supported",
	) => Promise<Record<string, string>> | Record<string, string>;
	/**
	 * Override the global `fetch` (e.g. for in-process testing or to inject
	 * an `undici` Agent in Node).
	 */
	readonly fetch?: typeof fetch;
}

/**
 * Builds a facilitator that proxies all RPC over HTTP to a remote endpoint,
 * matching the request / response shapes of x402 v2 spec §7.
 *
 * Works with any x402 v2-compliant facilitator — Coinbase CDP, your own
 * self-hosted facilitator behind nginx, a regional mirror — as long as it
 * exposes `/verify`, `/settle`, and `/supported` per the spec.
 *
 * If your target facilitator doesn't support the chain you need, fall back
 * to {@link createSelfFacilitator} (in-process viem broadcaster).
 *
 * @example
 * ```ts
 * import { createHttpFacilitator } from "kawasekit";
 *
 * const facilitator = createHttpFacilitator({
 *   baseUrl: process.env.X402_FACILITATOR_URL!, // e.g. Coinbase CDP endpoint
 *   getAuthHeaders: () => ({ Authorization: `Bearer ${apiKey}` }),
 * });
 * ```
 */
export function createHttpFacilitator(params: CreateHttpFacilitatorParams): Facilitator {
	const baseUrl = params.baseUrl.replace(/\/$/, "");
	const fetchImpl = params.fetch ?? fetch;
	const getAuthHeaders = params.getAuthHeaders;

	async function post<TResponse>(endpoint: "verify" | "settle", body: unknown): Promise<TResponse> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (getAuthHeaders) {
			Object.assign(headers, await getAuthHeaders(endpoint));
		}
		const response = await fetchImpl(`${baseUrl}/${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			throw new Error(
				`Facilitator ${endpoint} returned non-JSON (status ${response.status}): ${text.slice(0, 200)}`,
			);
		}
		if (!response.ok) {
			throw new Error(
				`Facilitator ${endpoint} failed (status ${response.status}): ${JSON.stringify(parsed).slice(0, 200)}`,
			);
		}
		return parsed as TResponse;
	}

	async function verifyInternal(req: X402VerifyRequest): Promise<X402VerifyResponse> {
		return post<X402VerifyResponse>("verify", {
			x402Version: req.x402Version,
			paymentPayload: req.paymentPayload,
			paymentRequirements: req.paymentRequirements,
		});
	}

	async function settleInternal(req: X402SettleRequest): Promise<X402SettleResponse> {
		return post<X402SettleResponse>("settle", {
			x402Version: req.x402Version,
			paymentPayload: req.paymentPayload,
			paymentRequirements: req.paymentRequirements,
		});
	}

	async function supportedInternal(): Promise<X402SupportedResponse> {
		const headers: Record<string, string> = {};
		if (getAuthHeaders) {
			Object.assign(headers, await getAuthHeaders("supported"));
		}
		const response = await fetchImpl(`${baseUrl}/supported`, { method: "GET", headers });
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			throw new Error(
				`Facilitator supported returned non-JSON (status ${response.status}): ${text.slice(0, 200)}`,
			);
		}
		if (!response.ok) {
			throw new Error(
				`Facilitator supported failed (status ${response.status}): ${JSON.stringify(parsed).slice(0, 200)}`,
			);
		}
		return parsed as X402SupportedResponse;
	}

	return {
		verify: verifyInternal,
		settle: settleInternal,
		supported: supportedInternal,
	};
}

// ---------------------------------------------------------------------------
// Deprecated aliases (M3-era names)
//
// The HTTP-proxied facilitator used to be called `createCoinbaseFacilitator`
// because the only x402 v2-compliant endpoint we tested against at the time
// was Coinbase CDP. The function was never Coinbase-specific — it speaks the
// raw x402 v2 HTTP shape — and the rename to `createHttpFacilitator` lands in
// v0.1.0-alpha to make that obvious before the npm publish freezes the API.
//
// The aliases below preserve M3-era call sites for the v0.1.x line. Calling
// `createCoinbaseFacilitator` emits a one-shot Node DeprecationWarning. The
// aliases will be removed in v0.2.0.
// ---------------------------------------------------------------------------

/**
 * @deprecated Renamed to {@link CreateHttpFacilitatorParams} in v0.1.0-alpha.
 *   The HTTP facilitator works with any x402 v2-compliant endpoint, not only
 *   Coinbase CDP. This alias will be removed in v0.2.0.
 */
export type CreateCoinbaseFacilitatorParams = CreateHttpFacilitatorParams;

let warnedCreateCoinbaseFacilitator = false;

/**
 * @deprecated Renamed to {@link createHttpFacilitator} in v0.1.0-alpha.
 *   This alias delegates to the new function and emits one
 *   `DeprecationWarning` per process on first call. It will be removed in
 *   v0.2.0.
 */
export function createCoinbaseFacilitator(params: CreateHttpFacilitatorParams): Facilitator {
	if (!warnedCreateCoinbaseFacilitator) {
		warnedCreateCoinbaseFacilitator = true;
		process.emitWarning(
			"createCoinbaseFacilitator() is deprecated and will be removed in kawasekit v0.2.0. Use createHttpFacilitator() instead — the function works with any x402 v2-compliant HTTP endpoint, not only Coinbase CDP.",
			{ type: "DeprecationWarning", code: "KAWASEKIT_DEP_001" },
		);
	}
	return createHttpFacilitator(params);
}
