/**
 * Facilitator implementations: local viem-backed (`createSelfFacilitator`) and
 * HTTP-proxied (`createCoinbaseFacilitator`).
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
import { isSupportedChainId, type SupportedChainId } from "../chains";
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
	 * Pre-configured wallet client that broadcasts settlement transactions.
	 * The bound account pays gas. `walletClient.chain.id` determines the only
	 * chain this facilitator serves.
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
}

/**
 * Builds a facilitator that verifies and broadcasts exact-EVM EIP-3009
 * payments using a locally-held EOA private key (gas payer).
 *
 * Intended for self-hosted paywalls and testnet (Polygon Amoy) where the
 * Coinbase CDP facilitator is not guaranteed to support the chain.
 *
 * @example
 * ```ts
 * import { createPublicClient, createWalletClient, http } from "viem";
 * import { privateKeyToAccount } from "viem/accounts";
 * import { createSelfFacilitator, polygonAmoy } from "kawasekit";
 *
 * const account = privateKeyToAccount(process.env.FACILITATOR_PK as `0x${string}`);
 * const transport = http(process.env.RPC_URL);
 * const facilitator = createSelfFacilitator({
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
	const network = chainIdToX402Network(supportedChainId);

	async function verifyInternal(req: X402VerifyRequest): Promise<X402VerifyResponse> {
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

	async function settleInternal(req: X402SettleRequest): Promise<X402SettleResponse> {
		// Re-verify before broadcasting.
		const verifyResult = await verifyInternal(req);
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
		verify: verifyInternal,
		settle: settleInternal,
		supported: supportedInternal,
	};
}

// ---------------------------------------------------------------------------
// HTTP-proxied facilitator (Coinbase CDP and any other x402 v2-compliant
// facilitator endpoint)
// ---------------------------------------------------------------------------

/** Parameters for {@link createCoinbaseFacilitator}. */
export interface CreateCoinbaseFacilitatorParams {
	/**
	 * Base URL of the facilitator service (e.g. Coinbase CDP). Endpoints
	 * `/verify`, `/settle`, `/supported` are POST / POST / GET respectively
	 * relative to this URL. Trailing slash is stripped.
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
 * Despite the name, this client is **not Coinbase-specific** — any service
 * exposing `/verify`, `/settle`, and `/supported` per the spec works.
 *
 * If Polygon Amoy is not in the facilitator's supported networks (see plan
 * risk #1), the M3 demo falls back to {@link createSelfFacilitator}.
 *
 * @example
 * ```ts
 * import { createCoinbaseFacilitator } from "kawasekit";
 *
 * const facilitator = createCoinbaseFacilitator({
 *   baseUrl: process.env.X402_FACILITATOR_URL!, // e.g. Coinbase CDP endpoint
 *   getAuthHeaders: () => ({ Authorization: `Bearer ${apiKey}` }),
 * });
 * ```
 */
export function createCoinbaseFacilitator(params: CreateCoinbaseFacilitatorParams): Facilitator {
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
