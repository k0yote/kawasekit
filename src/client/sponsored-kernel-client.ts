/**
 * Build a gas-sponsored Kernel account client — a {@link ConfiguredKernelClient}
 * whose UserOp gas is paid by the ZeroDev paymaster. Pass the returned client
 * straight to {@link transferJpyc}; callers never construct a paymaster client or
 * cast to {@link ConfiguredKernelClient}.
 *
 * @packageDocumentation
 */

import {
	type CreateKernelAccountReturnType,
	createKernelAccountClient,
	createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { type Address, type Chain, http, type PublicClient, type Transport } from "viem";
import { invokeHookSafely } from "../observability/hooks";
import type { ConfiguredKernelClient } from "./transfer-jpyc";

/**
 * Optional sponsorship observability. Hooks fire through {@link invokeHookSafely},
 * so a throwing hook never breaks sponsorship. The existing `ObservabilityHooks`
 * is x402-facilitator-shaped (verify/settle); this is the paymaster-seam surface.
 */
export interface SponsoredKernelClientObservability {
	/** Fired AFTER the paymaster GRANTS sponsorship for a userOp. */
	readonly onSponsor?: (event: { readonly account: Address }) => void;
	/** Fired when the paymaster DECLINES sponsorship (the raw error then propagates). */
	readonly onSponsorError?: (event: { readonly account: Address; readonly error: unknown }) => void;
}

/**
 * @internal Sponsor a userOp and fire the granted/declined observability hook.
 * The original paymaster error is re-thrown unchanged (no SDK wrapping). Exported
 * for unit testing the seam without a live chain; NOT part of the public API
 * (not re-exported from `src/index.ts`).
 */
export async function sponsorWithObservability<T>(
	sponsor: () => Promise<T>,
	account: Address,
	observability: SponsoredKernelClientObservability | undefined,
): Promise<T> {
	try {
		const data = await sponsor();
		invokeHookSafely(observability?.onSponsor, { account });
		return data;
	} catch (error) {
		invokeHookSafely(observability?.onSponsorError, { account, error });
		throw error;
	}
}

/** Parameters for {@link createSponsoredKernelClient}. */
export interface CreateSponsoredKernelClientParams {
	/** A Kernel v0.7 account from `createAgentSmartAccount` or `restoreSessionAccount`. */
	readonly account: CreateKernelAccountReturnType<"0.7">;
	/** The viem chain the client operates on (e.g. `polygonAmoy`). */
	readonly chain: Chain;
	/**
	 * The ZeroDev RPC URL — used for BOTH the bundler and the paymaster (ZeroDev
	 * serves both from one project RPC). Build it from a project id with
	 * `zerodevRpcUrl(chain, projectId)`, or paste the dashboard URL.
	 */
	readonly zerodevRpc: string;
	/** Optional viem `PublicClient` for on-chain reads during userOp prep (recommended). */
	readonly publicClient?: PublicClient<Transport, Chain>;
	/** Optional sponsorship observability — granted / declined. */
	readonly observability?: SponsoredKernelClientObservability;
}

/**
 * Build a gas-sponsored Kernel account client. The returned
 * {@link ConfiguredKernelClient} pays UserOp gas via the ZeroDev paymaster and is
 * accepted directly by {@link transferJpyc} — no caller-side cast.
 *
 * @example
 * ```ts
 * import {
 *   createSponsoredKernelClient,
 *   polygonAmoy,
 *   restoreSessionAccount,
 *   transferJpyc,
 *   zerodevRpcUrl,
 * } from "kawasekit";
 *
 * const account = await restoreSessionAccount({ publicClient, envelope, sessionKeySigner });
 * const client = createSponsoredKernelClient({
 *   account,
 *   chain: polygonAmoy,
 *   zerodevRpc: zerodevRpcUrl(polygonAmoy, projectId),
 *   publicClient,
 * });
 * const { transactionHash } = await transferJpyc(client, { to, amount });
 * ```
 */
export function createSponsoredKernelClient(
	params: CreateSponsoredKernelClientParams,
): ConfiguredKernelClient {
	const paymasterClient = createZeroDevPaymasterClient({
		chain: params.chain,
		transport: http(params.zerodevRpc),
	});
	const client = createKernelAccountClient({
		account: params.account,
		chain: params.chain,
		// exactOptionalPropertyTypes: only pass `client` when given (never `undefined`).
		...(params.publicClient !== undefined ? { client: params.publicClient } : {}),
		bundlerTransport: http(params.zerodevRpc),
		paymaster: {
			getPaymasterData: (userOperation) =>
				sponsorWithObservability(
					() => paymasterClient.sponsorUserOperation({ userOperation }),
					params.account.address,
					params.observability,
				),
		},
	});
	// createKernelAccountClient's deep generics don't unify with the exported
	// ConfiguredKernelClient alias; the runtime client is identical. One cast here
	// means callers never cast (closing gap G4).
	return client as unknown as ConfiguredKernelClient;
}
