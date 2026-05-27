/**
 * `kawasekit/observability/prometheus` — push-button Prometheus adapter for
 * the kawasekit observability hooks.
 *
 * Usage:
 *
 * ```ts
 * import { createPrometheusMetrics } from "kawasekit/observability/prometheus";
 * import { createSelfFacilitator } from "kawasekit";
 *
 * const metrics = createPrometheusMetrics();
 *
 * const facilitator = createSelfFacilitator({
 *   network: "testnet",
 *   walletClient,
 *   publicClient,
 *   hooks: metrics.hooks,
 * });
 *
 * // expose on any HTTP server:
 * app.get("/metrics", async (req, res) => {
 *   res.type(metrics.registry.contentType);
 *   res.send(await metrics.registry.metrics());
 * });
 * ```
 *
 * **Privacy boundary** (plan D2 / D11): this adapter does NOT push to any
 * external endpoint. It records into a `prom-client` `Registry` that the
 * operator scrapes from. Pushgateway / federation / remote_write are the
 * operator's responsibility.
 *
 * **Cardinality.** Labels are limited to `network` (2 values for kawasekit's
 * priority chains), `result` (`success` / `failure`), and `reason` (the x402
 * spec error vocabulary, ~12 values). Total series per metric ≤ ~50. Adapters
 * that need more dimensions should build on the base hook surface directly
 * rather than extending this one.
 *
 * @packageDocumentation
 */

import { Counter, Histogram, Registry } from "prom-client";
import { invokeHookSafely, type ObservabilityHooks } from "../hooks";

/** Parameters for {@link createPrometheusMetrics}. */
export interface CreatePrometheusMetricsParams {
	/**
	 * Existing `prom-client` registry to record metrics into. If not provided,
	 * a fresh `Registry` is created (so metrics live in isolation from any
	 * global default registry).
	 */
	readonly registry?: Registry;
	/**
	 * Prefix applied to every metric name. Defaults to `"kawasekit_"`.
	 * Useful when running multiple kawasekit instances behind one scrape
	 * endpoint and you want to namespace them.
	 */
	readonly prefix?: string;
	/**
	 * Histogram buckets in milliseconds. Defaults are tuned for x402 verify +
	 * settle latencies on Polygon (Amoy bundler inclusion ~2-5 s, mainnet
	 * faster).
	 */
	readonly durationBucketsMs?: readonly number[];
}

/** Return shape of {@link createPrometheusMetrics}. */
export interface PrometheusMetrics {
	/**
	 * The kawasekit observability hooks. Pass this to `createSelfFacilitator`,
	 * `createX402Handler`, or `wrapFetch` to populate the Prometheus metrics.
	 */
	readonly hooks: ObservabilityHooks;
	/**
	 * The `prom-client` registry holding all metrics. Expose it via
	 * `registry.metrics()` on your own HTTP endpoint.
	 */
	readonly registry: Registry;
}

/**
 * Default histogram buckets in milliseconds for x402 verify / settle latencies.
 * Polygon mainnet typical settle: 2-4 s; Amoy: 2-6 s; allowing headroom up to 60 s.
 */
const DEFAULT_DURATION_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000];

/**
 * Builds the Prometheus metrics surface for kawasekit and returns
 * {@link ObservabilityHooks} that populate it.
 *
 * @example
 * ```ts
 * import { createPrometheusMetrics } from "kawasekit/observability/prometheus";
 *
 * const metrics = createPrometheusMetrics({ prefix: "kawasekit_demo_" });
 * console.log(await metrics.registry.metrics());
 * ```
 */
export function createPrometheusMetrics(
	params: CreatePrometheusMetricsParams = {},
): PrometheusMetrics {
	const registry = params.registry ?? new Registry();
	const prefix = params.prefix ?? "kawasekit_";
	const buckets = [...(params.durationBucketsMs ?? DEFAULT_DURATION_BUCKETS_MS)];

	// --- Facilitator metrics ------------------------------------------------

	const verifyTotal = new Counter({
		name: `${prefix}verify_total`,
		help: "Number of facilitator verify() calls, labeled by network, result, and (for failures) the x402 spec invalidReason code.",
		labelNames: ["network", "result", "reason"] as const,
		registers: [registry],
	});
	const verifyDurationMs = new Histogram({
		name: `${prefix}verify_duration_ms`,
		help: "Latency of facilitator verify() in milliseconds.",
		labelNames: ["network", "result"] as const,
		buckets,
		registers: [registry],
	});

	const settleTotal = new Counter({
		name: `${prefix}settle_total`,
		help: "Number of facilitator settle() calls, labeled by network, result, and (for failures) the x402 spec errorReason code.",
		labelNames: ["network", "result", "reason"] as const,
		registers: [registry],
	});
	const settleDurationMs = new Histogram({
		name: `${prefix}settle_duration_ms`,
		help: "Latency of facilitator settle() in milliseconds.",
		labelNames: ["network", "result"] as const,
		buckets,
		registers: [registry],
	});

	// --- Server-side handler metrics ---------------------------------------

	const paymentRequiredTotal = new Counter({
		name: `${prefix}payment_required_total`,
		help: "Number of 402 responses returned by createX402Handler.",
		registers: [registry],
	});
	const paymentAcceptedTotal = new Counter({
		name: `${prefix}payment_accepted_total`,
		help: "Number of paywall hits where settle succeeded and the inner handler ran.",
		labelNames: ["network"] as const,
		registers: [registry],
	});
	const paymentHandlerDurationMs = new Histogram({
		name: `${prefix}payment_handler_duration_ms`,
		help: "Wall-clock latency from incoming x402-protected request to settled inner handler invocation.",
		labelNames: ["network"] as const,
		buckets,
		registers: [registry],
	});

	// --- Client-side wrapFetch metrics --------------------------------------

	const clientPaymentTotal = new Counter({
		name: `${prefix}client_payment_total`,
		help: "Number of wrapFetch paywall round-trips, labeled by network, result, and (for failures) the short reason code.",
		labelNames: ["network", "result", "reason"] as const,
		registers: [registry],
	});
	const clientPaymentDurationMs = new Histogram({
		name: `${prefix}client_payment_duration_ms`,
		help: "End-to-end latency of one wrapFetch paywall round-trip in milliseconds.",
		labelNames: ["network", "result"] as const,
		buckets,
		registers: [registry],
	});

	// --- Hook implementations ----------------------------------------------

	const hooks: ObservabilityHooks = {
		onVerify: (event) => {
			const reason = event.result === "failure" ? event.invalidReason : "ok";
			verifyTotal.inc({ network: event.network, result: event.result, reason });
			verifyDurationMs.observe({ network: event.network, result: event.result }, event.durationMs);
		},
		onSettle: (event) => {
			const reason = event.result === "failure" ? event.errorReason : "ok";
			settleTotal.inc({ network: event.network, result: event.result, reason });
			settleDurationMs.observe({ network: event.network, result: event.result }, event.durationMs);
		},
		onPaymentRequired: () => {
			paymentRequiredTotal.inc();
		},
		onPaymentAccepted: (event) => {
			paymentAcceptedTotal.inc({ network: event.network });
			paymentHandlerDurationMs.observe({ network: event.network }, event.durationMs);
		},
		onClientPayment: (event) => {
			if (event.result === "success") {
				clientPaymentTotal.inc({ network: event.network, result: "success", reason: "ok" });
				clientPaymentDurationMs.observe(
					{ network: event.network, result: "success" },
					event.durationMs,
				);
			} else {
				clientPaymentTotal.inc({
					network: "unknown",
					result: "failure",
					reason: event.reason,
				});
				clientPaymentDurationMs.observe(
					{ network: "unknown", result: "failure" },
					event.durationMs,
				);
			}
		},
	};

	// Defensively wrap every hook so the public surface keeps the
	// fire-and-forget guarantee even if a future prom-client release throws.
	const wrappedHooks: ObservabilityHooks = {
		onVerify: (event) => invokeHookSafely(hooks.onVerify, event),
		onSettle: (event) => invokeHookSafely(hooks.onSettle, event),
		onPaymentRequired: (event) => invokeHookSafely(hooks.onPaymentRequired, event),
		onPaymentAccepted: (event) => invokeHookSafely(hooks.onPaymentAccepted, event),
		onClientPayment: (event) => invokeHookSafely(hooks.onClientPayment, event),
	};

	return { hooks: wrappedHooks, registry };
}
