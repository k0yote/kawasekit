import { describe, expect, it } from "vitest";
import { createPrometheusMetrics } from "./index";

const NOW = 1_700_000_000_000;

describe("createPrometheusMetrics", () => {
	it("exposes the verify success / failure counter labels", async () => {
		const metrics = createPrometheusMetrics();
		metrics.hooks.onVerify?.({
			kind: "verify",
			result: "success",
			startedAtMs: NOW,
			durationMs: 42,
			network: "eip155:80002",
			payer: "0x0000000000000000000000000000000000000001",
			amount: "1000",
		});
		metrics.hooks.onVerify?.({
			kind: "verify",
			result: "failure",
			startedAtMs: NOW,
			durationMs: 13,
			network: "eip155:80002",
			invalidReason: "insufficient_funds",
		});
		const exported = await metrics.registry.metrics();
		expect(exported).toContain(
			'kawasekit_verify_total{network="eip155:80002",result="success",reason="ok"} 1',
		);
		expect(exported).toContain(
			'kawasekit_verify_total{network="eip155:80002",result="failure",reason="insufficient_funds"} 1',
		);
		expect(exported).toContain("kawasekit_verify_duration_ms");
	});

	it("exposes the settle counters labeled by reason on failure", async () => {
		const metrics = createPrometheusMetrics();
		metrics.hooks.onSettle?.({
			kind: "settle",
			result: "success",
			startedAtMs: NOW,
			durationMs: 2500,
			network: "eip155:137",
			payer: "0x0000000000000000000000000000000000000002",
			amount: "1000000",
			transaction: "0xdeadbeef",
		});
		metrics.hooks.onSettle?.({
			kind: "settle",
			result: "failure",
			startedAtMs: NOW,
			durationMs: 800,
			network: "eip155:137",
			errorReason: "unexpected_settle_error",
		});
		const exported = await metrics.registry.metrics();
		expect(exported).toContain(
			'kawasekit_settle_total{network="eip155:137",result="success",reason="ok"} 1',
		);
		expect(exported).toContain(
			'kawasekit_settle_total{network="eip155:137",result="failure",reason="unexpected_settle_error"} 1',
		);
	});

	it("increments payment_required without labels and payment_accepted with network", async () => {
		const metrics = createPrometheusMetrics();
		metrics.hooks.onPaymentRequired?.({
			kind: "payment_required",
			startedAtMs: NOW,
			durationMs: 5,
			requestUrl: "http://example.test/api/x",
			acceptedNetworks: ["eip155:80002"],
		});
		metrics.hooks.onPaymentAccepted?.({
			kind: "payment_accepted",
			startedAtMs: NOW,
			durationMs: 3000,
			requestUrl: "http://example.test/api/x",
			payer: "0x0000000000000000000000000000000000000003",
			amount: "1000",
			network: "eip155:80002",
			transaction: "0xabc",
		});
		const exported = await metrics.registry.metrics();
		expect(exported).toContain("kawasekit_payment_required_total 1");
		expect(exported).toContain('kawasekit_payment_accepted_total{network="eip155:80002"} 1');
	});

	it("labels client_payment failures by reason and uses 'unknown' network", async () => {
		const metrics = createPrometheusMetrics();
		metrics.hooks.onClientPayment?.({
			kind: "client_payment",
			result: "failure",
			startedAtMs: NOW,
			durationMs: 10,
			requestUrl: "http://example.test/x",
			reason: "onPayment_declined",
			httpStatus: 402,
		});
		const exported = await metrics.registry.metrics();
		expect(exported).toContain(
			'kawasekit_client_payment_total{network="unknown",result="failure",reason="onPayment_declined"} 1',
		);
	});

	it("accepts a custom prefix and registry", async () => {
		const sharedRegistry = createPrometheusMetrics().registry;
		const metrics = createPrometheusMetrics({
			registry: new (await import("prom-client")).Registry(),
			prefix: "demo_",
		});
		expect(metrics.registry).not.toBe(sharedRegistry);
		metrics.hooks.onPaymentRequired?.({
			kind: "payment_required",
			startedAtMs: NOW,
			durationMs: 1,
			requestUrl: "/",
			acceptedNetworks: ["eip155:80002"],
		});
		const exported = await metrics.registry.metrics();
		expect(exported).toContain("demo_payment_required_total 1");
	});
});
