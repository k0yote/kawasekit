/**
 * Observability hooks — the base interface that the kawasekit core surfaces
 * (facilitator, x402 handler, wrapFetch) emit events to. Operators wire metrics
 * / logs / traces by passing one of:
 *
 * - their own callback set (zero new dependencies, full control)
 * - one of the optional adapters at `kawasekit/observability/prometheus` or
 *   `kawasekit/observability/otlp` (push-button Prometheus / OTLP metrics)
 *
 * Design points worth reading before writing an adapter:
 *
 * - **All hooks are fire-and-forget.** {@link invokeHookSafely} swallows both
 *   synchronous throws and rejected Promises so hook misbehaviour cannot
 *   destabilise the kawasekit hot path. Adapters should still wrap any
 *   external I/O (HTTP exporter pushes, etc.) in their own resilience layer.
 *
 * - **Events carry timing.** Every event extends {@link ObservabilityEventBase}
 *   with a `startedAtMs` wall-clock timestamp and a `durationMs` measurement
 *   so histograms (Prometheus, OTLP) can be derived without the adapter
 *   needing to thread its own clocks.
 *
 * - **No private data leaks.** Hooks intentionally omit signatures, nonces,
 *   and authorization bytes. They expose only the public-after-broadcast
 *   metadata (payer, amount, network, tx hash, x402 error code) — enough for
 *   dashboards, not enough to replay a payment.
 *
 * - **Failure events carry x402 spec error codes verbatim.** The
 *   `invalidReason` / `errorReason` fields are the canonical x402 v2 codes
 *   (e.g. `insufficient_funds`, `invalid_exact_evm_payload_signature`). This
 *   gives adapters a stable label vocabulary that Grafana / Datadog can group
 *   by without ad-hoc parsing.
 *
 * @packageDocumentation
 */

import type { Address, Hex } from "viem";
import type { X402Network, X402PaymentRequirements } from "../x402/types";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Fields shared by every observability event. */
export interface ObservabilityEventBase {
	/** Wall-clock unix milliseconds when the observed operation started. */
	readonly startedAtMs: number;
	/** Wall-clock duration of the observed operation in milliseconds. */
	readonly durationMs: number;
}

/** Emitted by {@link createSelfFacilitator} after every `verify()` call. */
export type VerifyEvent =
	| (ObservabilityEventBase & {
			readonly kind: "verify";
			readonly result: "success";
			readonly network: X402Network;
			readonly payer: Address;
			/** Authorization amount in token-base units (wei for 18-decimal JPYC). */
			readonly amount: string;
	  })
	| (ObservabilityEventBase & {
			readonly kind: "verify";
			readonly result: "failure";
			readonly network: X402Network;
			/** Payer address if it was recoverable before the failure. */
			readonly payer?: Address;
			/** x402 v2 invalidReason code (e.g. `invalid_payload`). */
			readonly invalidReason: string;
			/** Human-readable detail; never includes private credentials. */
			readonly invalidMessage?: string;
	  });

/** Emitted by {@link createSelfFacilitator} after every `settle()` call. */
export type SettleEvent =
	| (ObservabilityEventBase & {
			readonly kind: "settle";
			readonly result: "success";
			readonly network: X402Network;
			readonly payer: Address;
			readonly amount: string;
			/** On-chain transaction hash of the broadcast settlement. */
			readonly transaction: Hex;
	  })
	| (ObservabilityEventBase & {
			readonly kind: "settle";
			readonly result: "failure";
			readonly network: X402Network;
			readonly payer?: Address;
			/** x402 v2 errorReason code (e.g. `insufficient_funds`). */
			readonly errorReason: string;
			readonly errorMessage?: string;
			/** Tx hash if the broadcast succeeded but the receipt reverted. */
			readonly transaction?: Hex;
	  });

/** Emitted by {@link createX402Handler} when it returns HTTP 402. */
export interface PaymentRequiredEvent extends ObservabilityEventBase {
	readonly kind: "payment_required";
	/** The URL that triggered the paywall, taken from `Request.url`. */
	readonly requestUrl: string;
	/** Networks listed in the `accepts` array, in order. */
	readonly acceptedNetworks: readonly X402Network[];
}

/** Emitted by {@link createX402Handler} when settlement unlocks the inner handler. */
export interface PaymentAcceptedEvent extends ObservabilityEventBase {
	readonly kind: "payment_accepted";
	readonly requestUrl: string;
	readonly payer: Address;
	readonly amount: string;
	readonly network: X402Network;
	readonly transaction: Hex;
}

/** Emitted by {@link wrapFetch} after each paywall round-trip. */
export type ClientPaymentEvent =
	| (ObservabilityEventBase & {
			readonly kind: "client_payment";
			readonly result: "success";
			readonly requestUrl: string;
			readonly payer: Address;
			readonly amount: string;
			readonly network: X402Network;
			/** Settlement tx hash if the server echoed it back in PAYMENT-RESPONSE. */
			readonly transaction?: Hex;
	  })
	| (ObservabilityEventBase & {
			readonly kind: "client_payment";
			readonly result: "failure";
			readonly requestUrl: string;
			/** Short label: `onPayment_declined` / `no_acceptable_requirement` / `settle_rejected` / `http_error`. */
			readonly reason: string;
			readonly httpStatus?: number;
	  });

/** Discriminated union of every event the hook surface may emit. */
export type ObservabilityEvent =
	| VerifyEvent
	| SettleEvent
	| PaymentRequiredEvent
	| PaymentAcceptedEvent
	| ClientPaymentEvent;

// ---------------------------------------------------------------------------
// Hook callback shapes
// ---------------------------------------------------------------------------

/** Generic shape of a hook callback. Async hooks are fire-and-forget. */
export type HookCallback<TEvent> = (event: TEvent) => void | Promise<void>;

/**
 * The complete kawasekit observability surface. All fields are optional —
 * pass only the hooks for the events you care about.
 *
 * @example
 * ```ts
 * import { createSelfFacilitator } from "kawasekit";
 *
 * const facilitator = createSelfFacilitator({
 *   network: "testnet",
 *   walletClient,
 *   publicClient,
 *   hooks: {
 *     onSettle: (event) => {
 *       if (event.result === "success") {
 *         console.log("settled", event.network, event.amount, event.transaction);
 *       } else {
 *         console.warn("settle failed", event.errorReason);
 *       }
 *     },
 *   },
 * });
 * ```
 */
export interface ObservabilityHooks {
	/** Fired after every facilitator `verify()`. Discriminate on `event.result`. */
	readonly onVerify?: HookCallback<VerifyEvent>;
	/** Fired after every facilitator `settle()`. Discriminate on `event.result`. */
	readonly onSettle?: HookCallback<SettleEvent>;
	/** Fired when the x402 handler returns 402 (no payment yet). */
	readonly onPaymentRequired?: HookCallback<PaymentRequiredEvent>;
	/** Fired when a settled payment unlocks the inner x402 handler. */
	readonly onPaymentAccepted?: HookCallback<PaymentAcceptedEvent>;
	/** Fired by `wrapFetch` after each paywall round-trip. */
	readonly onClientPayment?: HookCallback<ClientPaymentEvent>;
}

// ---------------------------------------------------------------------------
// Safe invocation helper
// ---------------------------------------------------------------------------

/**
 * Invokes a single optional hook and swallows both synchronous throws and
 * rejected Promises. Use this at every site where the kawasekit core surfaces
 * call user-provided callbacks — it is the contract that guarantees hooks
 * cannot destabilise verify / settle / fetch flows.
 *
 * If a hook misbehaves, the error is discarded silently — kawasekit's
 * observability promise is "best-effort, never blocking". Future work
 * (planned in plan D12) may route discarded errors to a structured logger so
 * operators can see hook bugs without paying for them in hot paths.
 *
 * @example
 * ```ts
 * import { invokeHookSafely } from "kawasekit/observability";
 *
 * invokeHookSafely(hooks.onSettle, {
 *   kind: "settle",
 *   result: "success",
 *   startedAtMs,
 *   durationMs: Date.now() - startedAtMs,
 *   network: "eip155:80002",
 *   payer,
 *   amount,
 *   transaction: txHash,
 * });
 * ```
 */
export function invokeHookSafely<TEvent>(
	hook: HookCallback<TEvent> | undefined,
	event: TEvent,
): void {
	if (hook === undefined) return;
	try {
		const result = hook(event);
		if (result instanceof Promise) {
			result.catch(() => {
				// Discard async rejection — observability hooks are fire-and-forget.
			});
		}
	} catch {
		// Discard sync throw — observability hooks are fire-and-forget.
	}
}

// ---------------------------------------------------------------------------
// Helpers for adapter authors
// ---------------------------------------------------------------------------

/**
 * Type-safe pluck of the `accepts` network list from a
 * {@link X402PaymentRequirements} array. Adapter authors can use this to build
 * `acceptedNetworks` for {@link PaymentRequiredEvent} without re-implementing
 * the narrow.
 *
 * @example
 * ```ts
 * import { extractAcceptedNetworks } from "kawasekit/observability";
 *
 * const acceptedNetworks = extractAcceptedNetworks(requirements);
 * ```
 */
export function extractAcceptedNetworks(
	requirements: readonly X402PaymentRequirements[],
): readonly X402Network[] {
	return requirements.map((req) => req.network);
}
