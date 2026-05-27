/**
 * kawasekit observability example server.
 *
 * Exposes `/metrics` for Prometheus and continuously emits synthetic
 * kawasekit observability events so a fresh Grafana dashboard has data to
 * render. No on-chain interaction — this is purely a wiring + dashboard demo.
 *
 * Run with:
 *
 *   pnpm dev
 *
 * Then point Prometheus at http://localhost:3001/metrics and load the
 * Grafana dashboard from grafana/dashboards/kawasekit.json.
 */

import { createServer } from "node:http";
import { createPrometheusMetrics } from "kawasekit/observability/prometheus";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

const PORT = envInt("PORT", 3001);
const tickIntervalMs = envInt("TICK_INTERVAL_MS", 1500);

const metrics = createPrometheusMetrics({ prefix: "kawasekit_" });

// ---------------------------------------------------------------------------
// Synthetic event generator — keeps the dashboard alive even without a real
// paywall server in front. Each tick emits a small mix of events that should
// produce visible deltas on the Grafana panels every 10 s scrape.
// ---------------------------------------------------------------------------

type Network = "eip155:80002" | "eip155:137";
const NETWORKS: readonly Network[] = ["eip155:80002", "eip155:137"];
const VERIFY_FAILURES = [
	"insufficient_funds",
	"invalid_exact_evm_payload_signature",
	"invalid_payload",
] as const;
const SETTLE_FAILURES = ["unexpected_settle_error", "invalid_transaction_state"] as const;
const CLIENT_FAILURE_REASONS = [
	"onPayment_declined",
	"settle_rejected",
	"http_error",
	"no_acceptable_requirement",
] as const;

function pick<T>(items: readonly T[], fallback: T): T {
	if (items.length === 0) return fallback;
	const index = Math.floor(Math.random() * items.length);
	return items[index] ?? fallback;
}

function randomDuration(meanMs: number): number {
	// Log-normal-ish jitter so histogram buckets fill realistically.
	return Math.max(1, Math.floor(meanMs * (0.4 + Math.random() * 1.4)));
}

function emitSyntheticTick(): void {
	const now = Date.now();
	const network = pick(NETWORKS, "eip155:80002");

	// 80% verify success, 20% failure
	if (Math.random() < 0.8) {
		metrics.hooks.onVerify?.({
			kind: "verify",
			result: "success",
			startedAtMs: now,
			durationMs: randomDuration(150),
			network,
			payer: "0x2f5eb6A1da2Cf2e3414E274ea2A8387142619E55",
			amount: "1000000000000000",
		});
	} else {
		metrics.hooks.onVerify?.({
			kind: "verify",
			result: "failure",
			startedAtMs: now,
			durationMs: randomDuration(80),
			network,
			invalidReason: pick(VERIFY_FAILURES, "invalid_payload"),
		});
	}

	// 70% settle success, 30% failure (more aggressive failure rate than
	// production so the dashboard has interesting deltas)
	if (Math.random() < 0.7) {
		metrics.hooks.onSettle?.({
			kind: "settle",
			result: "success",
			startedAtMs: now,
			durationMs: randomDuration(2800),
			network,
			payer: "0x2f5eb6A1da2Cf2e3414E274ea2A8387142619E55",
			amount: "1000000000000000",
			transaction: "0xdeadbeef",
		});
	} else {
		metrics.hooks.onSettle?.({
			kind: "settle",
			result: "failure",
			startedAtMs: now,
			durationMs: randomDuration(1200),
			network,
			errorReason: pick(SETTLE_FAILURES, "unexpected_settle_error"),
		});
	}

	// payment_required happens ~3x as often as payment_accepted (first request
	// always 402s, second request settles)
	for (let i = 0; i < 3; i++) {
		metrics.hooks.onPaymentRequired?.({
			kind: "payment_required",
			startedAtMs: now,
			durationMs: randomDuration(5),
			requestUrl: "http://example.test/api/weather/Tokyo",
			acceptedNetworks: [network],
		});
	}
	metrics.hooks.onPaymentAccepted?.({
		kind: "payment_accepted",
		startedAtMs: now,
		durationMs: randomDuration(3000),
		requestUrl: "http://example.test/api/weather/Tokyo",
		payer: "0x2f5eb6A1da2Cf2e3414E274ea2A8387142619E55",
		amount: "1000000000000000",
		network,
		transaction: "0xdeadbeef",
	});

	// Client-side: 75% success, 25% mixed failures
	if (Math.random() < 0.75) {
		metrics.hooks.onClientPayment?.({
			kind: "client_payment",
			result: "success",
			startedAtMs: now,
			durationMs: randomDuration(3200),
			requestUrl: "http://example.test/api/weather/Tokyo",
			payer: "0x2f5eb6A1da2Cf2e3414E274ea2A8387142619E55",
			amount: "1000000000000000",
			network,
			transaction: "0xdeadbeef",
		});
	} else {
		metrics.hooks.onClientPayment?.({
			kind: "client_payment",
			result: "failure",
			startedAtMs: now,
			durationMs: randomDuration(500),
			requestUrl: "http://example.test/api/weather/Tokyo",
			reason: pick(CLIENT_FAILURE_REASONS, "http_error"),
			httpStatus: 402,
		});
	}
}

const interval = setInterval(emitSyntheticTick, tickIntervalMs);

// ---------------------------------------------------------------------------
// HTTP server — /metrics for Prometheus, anything else returns a hint.
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
	if (req.url === "/metrics") {
		res.statusCode = 200;
		res.setHeader("content-type", metrics.registry.contentType);
		res.end(await metrics.registry.metrics());
		return;
	}
	res.statusCode = 200;
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.end(
		"kawasekit observability demo\n\nScrape http://localhost:" +
			PORT +
			"/metrics with Prometheus.\nSynthetic events fire every " +
			tickIntervalMs +
			" ms.\n",
	);
});

server.listen(PORT, () => {
	console.log(`kawasekit observability demo listening on http://localhost:${PORT}`);
	console.log(`Prometheus scrape target: http://localhost:${PORT}/metrics`);
	console.log(`Synthetic events firing every ${tickIntervalMs} ms`);
});

function shutdown(): void {
	clearInterval(interval);
	server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
