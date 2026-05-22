# Changelog

All notable changes to kawasekit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the `0.1.0` npm release (M4), milestone tags (`v0.0.0-mN`) mark progress.

## [v0.0.0-m1] - 2026-05-22

First milestone (M1): a runnable skeleton that creates an ERC-4337 smart
account on Polygon Amoy and sends a sponsored (gasless) transaction.

### Added

- Project bootstrap — TypeScript 6 (strict, ESM-only), tsup dual ESM/CJS
  build, Biome, Vitest, Changesets, pnpm 11 / Node 22+.
- `src/chains/polygon.ts` — `KawaseChain` type (extends viem `Chain`) with
  Polygon mainnet and Polygon Amoy configs, JPYC contract metadata, and the
  `zerodevRpcUrl` helper for ZeroDev v3 bundler/paymaster URLs.
- `src/chains/index.ts` — `supportedChains`, the `SupportedChainId` type,
  `getChain`, `isSupportedChainId`, and `ChainNotSupportedError`.
- `src/index.ts` — public API surface (chain exports).
- `scripts/01-create-account.ts` — M1 script: creates a ZeroDev Kernel v3.1
  smart account (ECDSA validator, EntryPoint v0.7) on Polygon Amoy and sends a
  sponsored user operation.
- GitHub Actions CI — typecheck, lint, test, and build on Node 22 and 24.
- Project documentation and policy files — README, CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, and `.env.example`.

### Fixed

- Declared `tslib` as a direct dependency to resolve a phantom dependency in
  `@zerodev/sdk` and `@zerodev/ecdsa-validator` (both compiled with TypeScript
  `importHelpers` but neither declares `tslib`) under pnpm's strict layout.

[v0.0.0-m1]: https://github.com/k0yote/kawasekit/releases/tag/v0.0.0-m1
