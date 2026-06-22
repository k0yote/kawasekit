# kawasekit

> TypeScript SDK for stablecoin payments by AI agents. Japan-first, JPYC-native.

[![npm version](https://img.shields.io/npm/v/kawasekit.svg)](https://www.npmjs.com/package/kawasekit)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**GA · mainnet-capable · JPYC-native.** Published on npm with SLSA provenance; payment flows verified on Polygon mainnet.

```bash
pnpm add kawasekit
```

## What it is

kawasekit gives AI agents a way to pay for things in stablecoins — without exposing developers to chain selection, gas management, or signing complexity. It is built on modern account abstraction (ERC-4337 / ZeroDev Kernel v3.1) and Japan's first regulated yen stablecoin (JPYC, classified as 電子決済手段 under 改正資金決済法).

## What you can do

- **Agent smart accounts + scoped session keys** — a Kernel v3.1 account where the owner keeps sudo and the agent holds a policy-bounded session key (recipient allowlist + per-transfer cap + schedule window), enforced on-chain.
- **Validator-agnostic issuance** — issue and revoke a session key under any owner: a plain ECDSA key, or a passkey / weighted-validator sudo (the building block for non-custodial recovery — see the example).
- **Gasless, sponsored payments** — send JPYC as a sponsored UserOp; the agent holds no native gas token.
- **Disposable buy-list keys** — bake a buy-list (its merchants + cap + window) into a single-use session key.
- **x402 micropayments** — an HTTP 402 client, Hono server middleware, and a self-facilitator, with default-on reasoning-step idempotency.
- **EIP-3009 EOA-payer signing** — gasless `transferWithAuthorization` for EOA payers.
- **Production plumbing** — observability (Prometheus / OTLP) and a `kawasekit` CLI.

## Examples

Two runnable example projects:

- **[`examples/agent-x402-jpyc`](./examples/agent-x402-jpyc/)** — a Mastra-driven Claude agent that pays a Hono paywall in JPYC over x402 (per-call micropayments).
- **[`k0yote/kawasekit-example`](https://github.com/k0yote/kawasekit-example)** — ZeroDev session-key end-to-end payment, plus passkey owner & non-custodial recovery harnesses, verified on Polygon Amoy.

## Documentation

Full guides, the Quick Start, and an auto-generated API reference live at **[kawasekit.k0yote.dev](https://kawasekit.k0yote.dev)** (bilingual EN / 日本語), built from [`docs/`](./docs/) with Astro Starlight. The API reference tracks the published package.

## Supported chains

JPYC availability and kawasekit support are two separate axes. kawasekit ships chain configs for **Polygon, Kaia, Avalanche, and Ethereum** (+ their testnets) in `src/chains/`, each with a per-chain finality default. The **x402 EOA-payer path** works on every chain; the **smart-account path** (session keys, sponsored UserOps) is verified on Polygon.

| Chain (id) | JPYC (`0xE7C3…c29`) | kawasekit |
|---|---|---|
| Polygon (137) | ✅ Live | ✅ config + x402 + smart-account (verified on mainnet) |
| Polygon Amoy (80002) | ✅ Live | ✅ primary testnet target |
| Kaia (8217) / Kairos (1001) | ✅ Live¹ | ✅ x402 EOA path (Kairos settlement verified on-chain) |
| Avalanche (43114) / Fuji (43113) | ✅ Live | ✅ x402 EOA path |
| Ethereum (1) / Sepolia (11155111) | ✅ Live | ✅ x402 EOA path |

¹ JPYC launched on Kaia in 2026-05 at the same contract address as the other chains.

## Why Japan-first

- **JPYC** is a fully regulated yen-pegged stablecoin (電子決済手段 under 改正資金決済法), multi-chain at the same address.
- The Japanese AI startup ecosystem is actively seeking modern payment rails.

kawasekit aims to be the developer-facing layer that connects this stablecoin infrastructure to the global AI agent ecosystem.

## Security

This SDK handles signing credentials and constructs financial operations. While the architecture avoids holding user funds, integration mistakes can still result in loss — audit and test thoroughly before any mainnet use. Report security issues privately to **security@k0yote.dev**; see [SECURITY.md](./SECURITY.md) for the disclosure policy and [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the layer-by-layer threat model.

## Contributing

Issues, counter-examples, and discussions are the most valuable contributions today. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

Apache-2.0 © k0yote — includes an explicit patent grant, which matters in the account-abstraction and stablecoin space.

---

Project home: **[kawasekit.k0yote.dev](https://kawasekit.k0yote.dev)** · Follow development: [@k0yote](https://github.com/k0yote)
