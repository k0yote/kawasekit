# kawasekit observability example

End-to-end demo of the `kawasekit/observability/prometheus` adapter wired
to Prometheus + Grafana. Brings up a dashboard in ~30 seconds so you can
see what the kawasekit metrics surface looks like before integrating it
into your own server.

The demo deliberately uses **synthetic events** instead of a real Polygon
paywall — the goal here is the observability stack, not another payment
flow. If you want a real paywall to drive the metrics, point your own
kawasekit server at the same Prometheus by following the "Real paywall
integration" section below.

## Layout

```
examples/observability/
├── docker-compose.yml             # Prometheus + Grafana
├── prometheus/
│   ├── prometheus.yml             # Scrape config
│   └── rules/
│       └── kawasekit-alerts.yml   # 4 baseline alerts
├── grafana/
│   ├── provisioning/              # Auto-load datasource + dashboard
│   └── dashboards/
│       └── kawasekit.json         # 8-panel kawasekit dashboard
└── server/
    └── index.ts                   # Node demo server — exposes /metrics
                                    # and emits synthetic events
```

## Run it

You need:

- Docker + Docker Compose (Desktop ≥ 4.32 or Linux Docker ≥ 25)
- Node 22+
- pnpm 11+

From this directory:

```bash
# 1. Install the example's deps (kawasekit comes from the workspace)
pnpm install

# 2. Start the demo server (synthesises kawasekit observability events
#    every ~1.5 s and exposes /metrics on :3001)
pnpm dev

# 3. In another shell: bring up Prometheus + Grafana
docker compose up -d
```

Then open:

- **Grafana**: <http://localhost:3000> (anonymous Viewer access enabled by
  default — admin/admin if you want to edit). The `kawasekit observability`
  dashboard auto-loads.
- **Prometheus**: <http://localhost:9090>
- **Demo `/metrics`**: <http://localhost:3001/metrics>

You should see metrics ticking across all 8 panels within ~20 seconds of
the first scrape.

## What the dashboard shows

| Panel | What it tells you |
|---|---|
| verify rate (by network, result) | Throughput of facilitator `verify()` calls, split into success / failure per chain. |
| settle rate (by network, result) | Same for `settle()`. Sustained failure on one network is a degraded-chain signal. |
| verify duration p50/p95/p99 | Latency of off-chain validation work — should be low (< 200 ms). A spike here means RPC reads are slow. |
| settle duration p50/p95/p99 | Latency of on-chain broadcast. Polygon mainnet typical p99 < 5 s; Amoy slightly higher. |
| payment_required vs payment_accepted | 402 rate vs 200-after-payment rate. The gap is paywall hits that never settled — usually clients abandoning. |
| verify failure reason breakdown | Last hour bar chart by x402 spec invalid-reason code. `insufficient_funds` dominating = payer funding issue. |
| client_payment rate (by result) | `wrapFetch` paywall round-trip success rate. |
| client_payment failure reasons | Last hour bar chart by failure label (`onPayment_declined`, `settle_rejected`, `http_error`, `no_acceptable_requirement`). |

## Alert rules

The demo ships four Prometheus alert rules in
[`prometheus/rules/kawasekit-alerts.yml`](./prometheus/rules/kawasekit-alerts.yml).
They are deliberately conservative — adjust thresholds for your own SLOs:

- **KawasekitVerifyFailureRateHigh** — verify failure ratio > 50% for 5 m.
- **KawasekitSettleFailureRateHigh** — settle failure ratio > 20% for 5 m.
- **KawasekitSettleLatencyHigh** — settle p99 > 30 s for 10 m.
- **KawasekitClientPaymentDeclineRateHigh** — client budget guard
  declining > 1 pay/sec for 5 m (usually informational — your budget
  envelope is doing its job).

Check fired alerts at <http://localhost:9090/alerts>.

## Real paywall integration

To replace the synthetic event generator with a real kawasekit paywall:

```ts
import { createSelfFacilitator, createX402Handler, wrapFetch } from "kawasekit";
import { createPrometheusMetrics } from "kawasekit/observability/prometheus";

const metrics = createPrometheusMetrics({ prefix: "kawasekit_" });

const facilitator = createSelfFacilitator({
  network: "testnet",
  walletClient,
  publicClient,
  hooks: metrics.hooks,
});

const handler = createX402Handler({
  facilitator,
  requirementsFor: /* … */,
  handler: /* … */,
  hooks: metrics.hooks,
});

const fetch402 = wrapFetch({ signer, hooks: metrics.hooks });

// Expose /metrics
app.get("/metrics", async (req, res) => {
  res.type(metrics.registry.contentType);
  res.send(await metrics.registry.metrics());
});
```

The same `metrics.hooks` can be passed to all three surfaces — every event
type is recorded into the same registry, so one scrape covers verify,
settle, payment_required / payment_accepted, and client_payment.

## OpenTelemetry

If you'd rather push metrics to an OTLP collector (Datadog, New Relic,
Tempo + Mimir, …), use [`kawasekit/observability/otlp`](../../src/observability/otlp/index.ts)
instead. The hook surface is identical; the adapter records into an OTel
`Meter` instead of a Prometheus `Registry`. The example shown in the
module's JSDoc is the canonical wiring.

## Cleanup

```bash
docker compose down
# Add -v if you want to wipe Grafana / Prometheus storage too.
```

## Troubleshooting

- **Grafana shows "No data"** — give Prometheus 30 s to perform its first
  scrape, then refresh. The `up{job="kawasekit"}` query in Prometheus
  should report `1`. If it stays `0`, the demo server isn't reachable from
  the Prometheus container; verify `pnpm dev` is running and that nothing
  else is on port 3001.
- **Container can't reach `host.docker.internal`** — Linux Docker before
  20.10 needs the `extra_hosts: host.docker.internal:host-gateway` config
  already in `docker-compose.yml`. Bump Docker if it still fails.
- **Dashboard didn't auto-load** — check Grafana logs
  (`docker compose logs grafana`); the provisioning config is mounted
  read-only at `/etc/grafana/provisioning`.
