import {
	AggregationTemporality,
	type DataPoint,
	type Histogram as HistogramDataModel,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOTLPMetrics } from "./index";

const NOW = 1_700_000_000_000;

interface RecordedMetric {
	readonly name: string;
	readonly attributes: {
		readonly network?: string;
		readonly result?: string;
		readonly reason?: string;
	};
	readonly value: number;
}

function flatten(
	metrics: Awaited<ReturnType<InMemoryMetricExporter["getMetrics"]>>,
): RecordedMetric[] {
	const recorded: RecordedMetric[] = [];
	for (const collection of metrics) {
		for (const scope of collection.scopeMetrics) {
			for (const metric of scope.metrics) {
				for (const dataPoint of metric.dataPoints as DataPoint<number | HistogramDataModel>[]) {
					const attributes: RecordedMetric["attributes"] = {};
					for (const [k, v] of Object.entries(dataPoint.attributes)) {
						if (k === "network" || k === "result" || k === "reason") {
							(attributes as Record<string, string>)[k] = String(v);
						}
					}
					const value =
						typeof dataPoint.value === "number" ? dataPoint.value : dataPoint.value.count;
					recorded.push({ name: metric.descriptor.name, attributes, value });
				}
			}
		}
	}
	return recorded;
}

describe("createOTLPMetrics", () => {
	let exporter: InMemoryMetricExporter;
	let meterProvider: MeterProvider;

	beforeEach(() => {
		exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		meterProvider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
		});
	});

	afterEach(async () => {
		await meterProvider.shutdown();
	});

	it("records verify success/failure counters and histograms", async () => {
		const otel = createOTLPMetrics({ meter: meterProvider.getMeter("kawasekit") });
		otel.hooks.onVerify?.({
			kind: "verify",
			result: "success",
			startedAtMs: NOW,
			durationMs: 42,
			network: "eip155:80002",
			payer: "0x0000000000000000000000000000000000000001",
			amount: "1000",
		});
		otel.hooks.onVerify?.({
			kind: "verify",
			result: "failure",
			startedAtMs: NOW,
			durationMs: 13,
			network: "eip155:80002",
			invalidReason: "insufficient_funds",
		});

		await meterProvider.forceFlush();
		const recorded = flatten(exporter.getMetrics());

		const verifyTotalSuccess = recorded.find(
			(r) =>
				r.name === "kawasekit.verify_total" &&
				r.attributes.result === "success" &&
				r.attributes.reason === "ok",
		);
		expect(verifyTotalSuccess?.value).toBe(1);

		const verifyTotalFailure = recorded.find(
			(r) =>
				r.name === "kawasekit.verify_total" &&
				r.attributes.result === "failure" &&
				r.attributes.reason === "insufficient_funds",
		);
		expect(verifyTotalFailure?.value).toBe(1);

		const verifyDuration = recorded.filter((r) => r.name === "kawasekit.verify_duration_ms");
		expect(verifyDuration.length).toBeGreaterThanOrEqual(1);
	});

	it("records client_payment failure attributes including reason", async () => {
		const otel = createOTLPMetrics({ meter: meterProvider.getMeter("kawasekit") });
		otel.hooks.onClientPayment?.({
			kind: "client_payment",
			result: "failure",
			startedAtMs: NOW,
			durationMs: 10,
			requestUrl: "http://example.test/x",
			reason: "onPayment_declined",
			httpStatus: 402,
		});

		await meterProvider.forceFlush();
		const recorded = flatten(exporter.getMetrics());

		const counter = recorded.find(
			(r) =>
				r.name === "kawasekit.client_payment_total" &&
				r.attributes.network === "unknown" &&
				r.attributes.result === "failure" &&
				r.attributes.reason === "onPayment_declined",
		);
		expect(counter?.value).toBe(1);
	});

	it("respects a custom prefix", async () => {
		const otel = createOTLPMetrics({
			meter: meterProvider.getMeter("kawasekit"),
			prefix: "demo.",
		});
		otel.hooks.onPaymentRequired?.({
			kind: "payment_required",
			startedAtMs: NOW,
			durationMs: 1,
			requestUrl: "/",
			acceptedNetworks: ["eip155:80002"],
		});

		await meterProvider.forceFlush();
		const recorded = flatten(exporter.getMetrics());
		const counter = recorded.find((r) => r.name === "demo.payment_required_total");
		expect(counter?.value).toBe(1);
	});
});
