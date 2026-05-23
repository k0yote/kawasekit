# Changelog

All notable changes to kawasekit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the `0.1.0` npm release (M4), milestone tags (`v0.0.0-mN`) mark progress.

## [v0.0.0-m2] - 2026-05-23

Second milestone (M2): an agent-payable JPYC stack — sponsored UserOp transfer,
EIP-3009 EOA-payer signing helpers, and a daily-limit spending policy enforced
at the ERC-4337 validation phase.

### Added

- `transferJpyc(kernelClient, { to, amount })` — sends `JPYC.transfer()` as a
  sponsored Kernel UserOp. This is the agent's canonical send path; EIP-3009
  can't be used here because JPYC verifies signatures with pure `ecrecover`,
  so smart-account `from` is unsupported.
- `src/tokens/eip3009.ts` — EOA-payer typed-data builders and signers
  (`signTransferWithAuthorization` / `signReceiveWithAuthorization` /
  `signCancelAuthorization`) plus `generateAuthorizationNonce` and
  `authorizationDeadlineFromNow`. Pure off-chain construction; M3 will wire
  these into the x402 / pull-payment flow.
- `src/tokens/jpyc.ts` — JPYC v2 metadata: per-chain `jpycDeployments` (Polygon
  + Amoy both at `0xE7C3D8C9...c29`), `JPYC_DECIMALS`, `JPYC_V2_ADDRESS`,
  `JPYC_EIP712_DOMAIN_HINT`, and a minimal ERC-20 + EIP-3009 ABI (`jpycAbi`).
  `getJpycAddress(chainId)` looks up the deployment safely.
- `src/policy/daily-limit.ts` — `createJpycDailyLimitPolicies({ jpycAddress,
  maxPerTransfer, maxTransfersPerDay })` composes ZeroDev's `callPolicy`
  (per-tx value cap) and `rateLimitPolicy` (24h tx count) into a daily-limit
  policy bundle. `ONE_DAY_SECONDS` exposed.
- `src/account/session-key.ts` — `createAgentSmartAccount({ publicClient,
  ownerSigner, sessionKeySigner, policies })` builds a Kernel v3.1 account
  with sudo (owner) + regular (session-key permission validator) plugins.
  Policy-violating userOps revert at validation; sponsored gas is never
  consumed.
- `scripts/03-transfer-jpyc.ts` (`pnpm m2:transfer-jpyc`) and
  `scripts/04-transfer-with-policy.ts` (`pnpm m2:transfer-with-policy`) —
  Polygon Amoy end-to-end demos.
- `kawasekit-contracts` companion repository (private, M2-1) — Foundry
  project with a test-only `MockJPYC` that mirrors JPYC's EIP-3009 surface
  byte-for-byte (same TYPEHASHes, same `ecrecover`-only signer check, no
  Pausable / Blocklist / Minter). Compiled bytecode lands under
  `test/fixtures/MockJPYC.json` via `script/sync-sdk-fixtures.sh`.
- Vitest harness: `prool`-driven anvil lifecycle, 16 unit + integration
  cases covering EIP-3009 happy / expired / nonce-reuse / frontrun / cancel
  paths, JPYC transfer calldata encoding, transferJpyc input validation,
  and daily-limit policy shape.

### Changed

- `KawaseChain` no longer carries a `jpycAddress` field. Token-deployment
  data lives in `src/tokens/jpyc.ts` (single source of truth). Migrate from
  `polygon.jpycAddress` to `getJpycAddress(polygon.id)`.

### Dependencies

- Added `@zerodev/permissions@5.5.14` (production).
- Added `prool@^0.2.4` (development).

### Known limitations

- JPYC on Polygon Amoy is mint-controlled with no public faucet, so the
  Amoy E2E scripts exit at the "balance == 0" check unless the agent's
  smart account has been pre-funded by JPYC Inc.
- Recipient allowlisting is not part of the M2 spending policy. Per-tx
  amount and per-day count are enforced; `to` is unrestricted. M3 will add
  allowlisting.
- `createJpycDailyLimitPolicies` enforces `maxPerTransfer × maxTransfersPerDay`,
  not a cumulative-amount tracker — ZeroDev's policy library does not ship
  a per-token spending-limit policy at this version.

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

[v0.0.0-m2]: https://github.com/k0yote/kawasekit/releases/tag/v0.0.0-m2
[v0.0.0-m1]: https://github.com/k0yote/kawasekit/releases/tag/v0.0.0-m1
