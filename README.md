# kawasekit

> TypeScript SDK for stablecoin payments by AI agents. Japan-first, JPYC-native.

[![npm version](https://img.shields.io/npm/v/kawasekit.svg)](https://www.npmjs.com/package/kawasekit)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

🚧 **Status**: Pre-alpha. Built in public. Not yet ready for production use.

## Vision

kawasekit gives AI agents a way to pay for things using stablecoins — without exposing developers to chain selection, gas management, or signing complexity.

Today, AI services force users into monthly subscriptions and API key sprawl. As agentic workflows become common, the per-call cost model breaks down. kawasekit treats payments as a primitive: an agent submits an operation, the SDK handles the rest.

Built around modern account abstraction (ERC-4337 / Kernel v3.1) and Japan's first regulated yen stablecoin (JPYC, classified as 電子決済手段 under 改正資金決済法), with global expansion targeting Kaia and the broader Asia stablecoin ecosystem.

## Roadmap

- [x] **M1**: Smart account skeleton on Polygon Amoy (this release)
- [ ] **M2**: Spending policy engine + EIP-3009 + x402 handler
- [ ] **M3**: CLI bootstrap + documentation site + integration examples
- [ ] **M4**: Mainnet support + observability + npm v0.1 release
- [ ] **M5**: Community building + first real integrations
- [ ] **M6**: Managed service alpha + Rust policy engine

## Quick Start

Currently in pre-alpha. The M1 release demonstrates smart account creation on Polygon Amoy.

```bash
git clone https://github.com/k0yote/kawasekit.git
cd kawasekit
pnpm install
cp .env.example .env
# Fill in OWNER_PRIVATE_KEY and ZERODEV_PROJECT_ID
pnpm tsx scripts/01-create-account.ts
```

The public API is intentionally minimal until M2:

```typescript
import { polygonAmoy, zerodevRpcUrl, getChain } from "kawasekit";

const chain = getChain(80002); // Polygon Amoy
const rpcUrl = zerodevRpcUrl(chain, "your-zerodev-project-id");
```

## Tech Stack

- **Language**: TypeScript 6 (strict, ESM-only)
- **EVM client**: viem v2
- **Account abstraction**: ZeroDev Kernel v3.1 (ERC-4337 v0.7)
- **Build**: tsup
- **Lint/Format**: Biome
- **Runtime**: Node 22+
- **Package manager**: pnpm 11

## Supported Chains

| Chain | Status | JPYC |
|---|---|---|
| Polygon | M1 | ✅ Live (0xE7C3...c29) |
| Polygon Amoy (testnet) | M1 | — |
| Kaia | M2+ | 🚧 In development |
| Avalanche | M4+ | ✅ Live |
| Ethereum | M4+ | ✅ Live |

## Why Japan-first

The Japanese stablecoin ecosystem in 2026 is uniquely positioned:

- **JPYC** is a fully regulated yen-pegged stablecoin under the revised Payment Services Act
- Multi-chain by design (same address on Ethereum, Polygon, Avalanche)
- Kaia integration coming via LINE NEXT's Unifi
- Japanese AI startup ecosystem actively seeking modern payment rails

kawasekit aims to be the developer-facing layer that connects this stablecoin infrastructure to the global AI agent ecosystem.

## Contributing

This is currently a solo project, but contributions will be welcomed once we hit M3. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for guidelines.

For now, feedback, issues, and discussions are the most valuable contributions.

## Security

Report security issues privately to **security@k0yote.dev**. See [SECURITY.md](./SECURITY.md) for the full disclosure policy.

This SDK handles signing credentials and constructs financial operations. While the architecture avoids holding user funds, integration mistakes can still result in financial loss. Audit and test thoroughly before any mainnet usage.

## License

Apache-2.0 © k0yote

This license includes an explicit patent grant, which is important for working in the account abstraction and stablecoin space.

---

Follow development progress: [@k0yote](https://github.com/k0yote) · Project home: kawasekit.k0yote.dev (coming soon)
