---
"kawasekit": minor
---

# M4 — Mainnet support, observability, threat model, CLI, docs site, first npm publish

First real release on npm — promotes the reserved `kawasekit@0.0.1` placeholder
to a working SDK. Pre-alpha → 0.1.0 alpha line.

## Headline changes

- **Polygon mainnet support.** `createSelfFacilitator` and
  `createX402PaymentSigner` now require an explicit
  `network: "mainnet" | "testnet"` argument that is cross-checked against
  the chain's `isTestnet` flag at construction / sign time. The check is
  fail-fast so a testnet config can no longer silently broadcast against
  mainnet (or vice versa). The `KAWASEKIT_ALLOW_MAINNET=1` env gate
  additionally guards scripts and the CLI.

- **Observability surface (`kawasekit/observability/*`).** A new fire-and-
  forget hook interface (`onVerify`, `onSettle`, `onPaymentRequired`,
  `onPaymentAccepted`, `onClientPayment`) wired into the facilitator,
  x402 handler, and `wrapFetch`. Two opt-in adapters:
  `kawasekit/observability/prometheus` (records into a `prom-client`
  Registry) and `kawasekit/observability/otlp` (records into any
  OpenTelemetry Meter). No telemetry leaves the process unless the
  operator wires an exporter.

- **CLI.** `kawasekit init / account create / transfer / policy create /
  session-key (issue | restore | revoke | rotate)` — the M1/M2/M3 scripts
  promoted to a `commander`-backed CLI installed via the `bin` field. All
  network commands require `--chain polygon|polygonAmoy`; mainnet
  broadcasts additionally require `KAWASEKIT_ALLOW_MAINNET=1`.

- **Threat model.** `docs/THREAT_MODEL.md` ships as the layer-by-layer
  surface analysis used by external reviewers (5 layers: x402 wire format
  / self-facilitator EOA / session-key envelope / smart account boundary
  / agent runtime). Closes with a Known limitations section that records
  the reasoning-step idempotency gap surfaced by post-M3 external
  feedback (M5 candidate).

- **Documentation site.** Astro Starlight bilingual (English / 日本語) site
  at https://kawasekit.k0yote.dev, auto-deployed from `main` via GitHub
  Pages + Cloudflare DNS. Includes Quick Start, example walkthroughs, CLI
  reference, security policy, and a starlight-typedoc-driven API
  reference generated from `src/` JSDoc.

## Breaking changes

`createCoinbaseFacilitator` → renamed to `createHttpFacilitator`. The
function was never Coinbase-specific (HTTP-agnostic x402 v2 facilitator);
the rename lands here so v0.1.x has the right name. The old name remains
as a deprecated alias for the v0.1.x line and emits a one-shot Node
`DeprecationWarning` (`KAWASEKIT_DEP_001`) on first call. Removed in
v0.2.0.

Likewise `CreateCoinbaseFacilitatorParams` → `CreateHttpFacilitatorParams`
with a type alias kept for the v0.1.x line.

## Bug fixes worth flagging

- **tsup output paths.** When the M4-4 CLI added `cli/index.ts` to the
  tsup entry list, the implicit common-ancestor heuristic moved every
  output file from `dist/<subpath>/` to `dist/src/<subpath>/`, silently
  breaking every `package.json#exports` resolution. Fixed by switching
  tsup `entry` to the object form so each output path is pinned. Caught
  in M4-6 by `npm pack --dry-run` + a `/tmp` clean-room install.

- **Concurrent settle nonce race.** `createSelfFacilitator` JSDoc + the
  `examples/agent-x402-jpyc/server` example now document and apply
  viem's `nonceManager` — without it, parallel `settle()` from the same
  facilitator EOA silently drops txs.

## SDK surface

Subpath exports stabilised for v0.1.x:

- `kawasekit` (root)
- `kawasekit/x402`
- `kawasekit/x402/hono`
- `kawasekit/session`
- `kawasekit/observability`
- `kawasekit/observability/prometheus` (peer: `prom-client >=15`)
- `kawasekit/observability/otlp` (peer: `@opentelemetry/api >=1.9`)

`bin`: `kawasekit` (CLI).

## Release tag

This is the M4 changeset for the **0.1.0 alpha line**. The publish step
runs in `changeset pre enter alpha` mode, which emits `0.1.0-alpha.0`
under the `alpha` dist-tag so the `latest` tag remains pinned to the
`0.0.1` placeholder until GA.

Operators install pre-release versions explicitly:

```
pnpm add kawasekit@alpha          # latest alpha
pnpm add kawasekit@0.1.0-alpha.0  # exact version
```

The 0.1.0 GA will promote the line to `latest`.
