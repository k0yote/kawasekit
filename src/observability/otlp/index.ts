/**
 * `kawasekit/observability/otlp` — OpenTelemetry adapter for the kawasekit
 * observability hooks.
 *
 * Unlike the Prometheus adapter, this one does NOT own a MeterProvider —
 * OpenTelemetry's MeterProvider is conventionally a process-wide singleton.
 * The caller wires up their own `MeterProvider`, optionally configures an
 * OTLP exporter, and passes the resulting {@link Meter} in here so kawasekit
 * can attach its instruments.
 *
 * Usage:
 *
 * ```ts
 * import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
 * import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
 * import { metrics } from "@opentelemetry/api";
 * import { createOTLPMetrics } from "kawasekit/observability/otlp";
 * import { createSelfFacilitator } from "kawasekit";
 *
 * const meterProvider = new MeterProvider({
 *   readers: [
 *     new PeriodicExportingMetricReader({
 *       exporter: new OTLPMetricExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
 *       exportIntervalMillis: 10_000,
 *     }),
 *   ],
 * });
 * metrics.setGlobalMeterProvider(meterProvider);
 *
 * const otel = createOTLPMetrics({ meter: meterProvider.getMeter("kawasekit") });
 *
 * const facilitator = createSelfFacilitator({
 *   network: "testnet",
 *   walletClient,
 *   publicClient,
 *   hooks: otel.hooks,
 * });
 * ```
 *
 * **Privacy boundary** (plan D2 / D11): this adapter records into the OTel
 * Meter you pass in. Where those metrics end up — `OTLPMetricExporter`,
 * Datadog, New Relic, or nowhere — is determined entirely by your
 * MeterProvider configuration. kawasekit never opens its own network
 * connection.
 *
 * **Cardinality.** Same label discipline as the Prometheus adapter: `network`
 * (2 values), `result` (`success` / `failure`), and `reason` (~12 spec error
 * codes). Total time series per instrument ≤ ~50.
 *
 * @packageDocumentation
 */

import type { Counter, Histogram, Meter } from "@opentelemetry/api";
import { invokeHookSafely, type ObservabilityHooks } from "../hooks";

/** Parameters for {@link createOTLPMetrics}. */
export interface CreateOTLPMetricsParams {
	/**
	 * OpenTelemetry `Meter` to attach instruments to. Typically obtained via
	 * `meterProvider.getMeter("kawasekit", "<your-app-version>")`.
	 */
	readonly meter: Meter;
	/**
	 * Instrument name prefix. Defaults to `"kawasekit."` (OTel naming uses
	 * dots, not underscores, by convention).
	 */
	readonly prefix?: string;
	/**
	 * Optional `unit` argument passed to histogram instruments. Defaults to
	 * `"ms"` (the unit of the `durationMs` events kawasekit emits).
	 */
	readonly durationUnit?: string;
}

/** Return shape of {@link createOTLPMetrics}. */
export interface OTLPMetrics {
	/**
	 * The kawasekit observability hooks. Pass this to `createSelfFacilitator`,
	 * `createX402Handler`, or `wrapFetch`.
	 */
	readonly hooks: ObservabilityHooks;
}

/**
 * Builds the OpenTelemetry metrics surface for kawasekit on the supplied
 * {@link Meter} and returns {@link ObservabilityHooks} that record into it.
 *
 * @example
 * ```ts
 * import { metrics } from "@opentelemetry/api";
 * import { createOTLPMetrics } from "kawasekit/observability/otlp";
 *
 * const otel = createOTLPMetrics({ meter: metrics.getMeter("kawasekit") });
 * ```
 */
export function createOTLPMetrics(params: CreateOTLPMetricsParams): OTLPMetrics {
	const { meter } = params;
	const prefix = params.prefix ?? "kawasekit.";
	const durationUnit = params.durationUnit ?? "ms";

	// --- Facilitator instruments -------------------------------------------

	const verifyTotal: Counter = meter.createCounter(`${prefix}verify_total`, {
		description:
			"Number of facilitator verify() calls, labeled by network, result, and (for failures) the x402 spec invalidReason code.",
	});
	const verifyDuration: Histogram = meter.createHistogram(`${prefix}verify_duration_ms`, {
		description: "Latency of facilitator verify() in milliseconds.",
		unit: durationUnit,
	});

	const settleTotal: Counter = meter.createCounter(`${prefix}settle_total`, {
		description:
			"Number of facilitator settle() calls, labeled by network, result, and (for failures) the x402 spec errorReason code.",
	});
	const settleDuration: Histogram = meter.createHistogram(`${prefix}settle_duration_ms`, {
		description: "Latency of facilitator settle() in milliseconds.",
		unit: durationUnit,
	});

	// --- Server-side handler instruments -----------------------------------

	const paymentRequiredTotal: Counter = meter.createCounter(`${prefix}payment_required_total`, {
		description: "Number of 402 responses returned by createX402Handler.",
	});
	const paymentAcceptedTotal: Counter = meter.createCounter(`${prefix}payment_accepted_total`, {
		description: "Number of paywall hits where settle succeeded and the inner handler ran.",
	});
	const paymentHandlerDuration: Histogram = meter.createHistogram(
		`${prefix}payment_handler_duration_ms`,
		{
			description:
				"Wall-clock latency from incoming x402-protected request to settled inner handler invocation.",
			unit: durationUnit,
		},
	);

	// --- Client-side wrapFetch instruments ---------------------------------

	const clientPaymentTotal: Counter = meter.createCounter(`${prefix}client_payment_total`, {
		description:
			"Number of wrapFetch paywall round-trips, labeled by network, result, and (for failures) the short reason code.",
	});
	const clientPaymentDuration: Histogram = meter.createHistogram(
		`${prefix}client_payment_duration_ms`,
		{
			description: "End-to-end latency of one wrapFetch paywall round-trip in milliseconds.",
			unit: durationUnit,
		},
	);

	// --- Hook implementations ----------------------------------------------

	const hooks: ObservabilityHooks = {
		onVerify: (event) => {
			const reason = event.result === "failure" ? event.invalidReason : "ok";
			verifyTotal.add(1, { network: event.network, result: event.result, reason });
			verifyDuration.record(event.durationMs, {
				network: event.network,
				result: event.result,
			});
		},
		onSettle: (event) => {
			const reason = event.result === "failure" ? event.errorReason : "ok";
			settleTotal.add(1, { network: event.network, result: event.result, reason });
			settleDuration.record(event.durationMs, {
				network: event.network,
				result: event.result,
			});
		},
		onPaymentRequired: () => {
			paymentRequiredTotal.add(1);
		},
		onPaymentAccepted: (event) => {
			paymentAcceptedTotal.add(1, { network: event.network });
			paymentHandlerDuration.record(event.durationMs, { network: event.network });
		},
		onClientPayment: (event) => {
			if (event.result === "success") {
				clientPaymentTotal.add(1, {
					network: event.network,
					result: "success",
					reason: "ok",
				});
				clientPaymentDuration.record(event.durationMs, {
					network: event.network,
					result: "success",
				});
			} else {
				clientPaymentTotal.add(1, {
					network: "unknown",
					result: "failure",
					reason: event.reason,
				});
				clientPaymentDuration.record(event.durationMs, {
					network: "unknown",
					result: "failure",
				});
			}
		},
	};

	// Defensively wrap so a buggy Meter implementation cannot escape into the
	// kawasekit hot path.
	const wrappedHooks: ObservabilityHooks = {
		onVerify: (event) => invokeHookSafely(hooks.onVerify, event),
		onSettle: (event) => invokeHookSafely(hooks.onSettle, event),
		onPaymentRequired: (event) => invokeHookSafely(hooks.onPaymentRequired, event),
		onPaymentAccepted: (event) => invokeHookSafely(hooks.onPaymentAccepted, event),
		onClientPayment: (event) => invokeHookSafely(hooks.onClientPayment, event),
	};

	return { hooks: wrappedHooks };
}
