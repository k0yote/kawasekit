# Changelog

All notable changes to kawasekit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the `0.1.0` npm release (M4), milestone tags (`v0.0.0-mN`) mark progress.

## [v0.0.0-m3] - 2026-05-26

Third milestone (M3): kawasekit is now externally callable. An AI agent
talks to a paywalled HTTP service in JPYC over x402 v2, the smart account
behind it has a session key the owner can revoke or rotate on-chain, and
the whole flow runs from a runnable example app.

### Added (M3-1 — x402 v2 SDK)

- `src/x402/client.ts` — `createX402PaymentSigner({ account })` produces
  `X402PaymentPayload`s from an EOA payer. First runtime consumer of
  M2's EIP-3009 signing helpers. EIP-712 domain resolution priority:
  `domainOverride` → `paymentRequirements.extra.{name,version}` →
  JPYC fallback by asset address → typed error.
- `src/x402/fetch.ts` — `wrapFetch({ signer, selectRequirements?, onPayment? })`
  turns any WHATWG `fetch` into an x402-aware client. Handles 402 → sign →
  retry-with-`PAYMENT-SIGNATURE` in one call. `onPayment` is the budget
  guard hook (return `false` to abort).
- `src/x402/server.ts` — `createX402Handler({ facilitator, requirementsFor, handler })`
  is a framework-agnostic `(Request) => Response` resource-server adapter.
  Returns 402 with `PAYMENT-REQUIRED` on missing / invalid / verify-fail /
  settle-fail; forwards to the inner handler with `PAYMENT-RESPONSE`
  attached on success.
- `src/x402/hono/index.ts` — `x402Middleware()` (~30 LoC of logic) bridges
  `createX402Handler` to Hono's `(c, next)` shape. `X402HonoEnv` typed
  helper exported. `hono` is an OPTIONAL peer dependency; subpath imports
  cost zero runtime if unused.
- `src/x402/facilitator.ts` — `createSelfFacilitator({ walletClient, publicClient })`
  verifies (signature, balance, nonce-not-used, time window, parameter
  match) then broadcasts `transferWithAuthorization` from the bound EOA.
  `createCoinbaseFacilitator({ baseUrl, getAuthHeaders? })` is the
  HTTP-proxy variant, generic against any x402 v2-compliant endpoint
  despite the name. Error codes match spec section 9 verbatim.
- `src/x402/payment-requirements.ts` — `buildPaymentRequirements({...})`
  and `buildPaymentRequiredResponse({ resource, accepts, error? })`
  server-side builders. JPYC `extra` auto-injection
  (`{ assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" }`).
- `src/x402/encoding.ts` + `src/x402/errors.ts` — standard-base64 codec
  for the three v2 headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`,
  `PAYMENT-RESPONSE`). BigInt-safe `JSON.stringify` replacer. Byte-
  identical with `@x402/core@2.13.0` (asserted by conformance tests).
- `src/x402/types.ts` — full spec-faithful type surface. Template-
  literal `X402Network` derives `eip155:${SupportedChainId}` so adding
  a chain extends the type automatically.

### Added (M3-2 — session-key lifecycle)

- `src/session/envelope.ts` — `KawasekitSessionEnvelope` wraps ZeroDev's
  opaque `serializePermissionAccount` blob with typed metadata
  (`chainId`, `smartAccountAddress`, `sessionKeyAddress`, optional
  `expiresAt`, optional advisory `policySummary`). Version pinned via
  `KAWASEKIT_SESSION_ENVELOPE_VERSION = "1"`. Bigint↔decimal-string
  conversion at the JSON wire boundary so the format travels through
  env vars / HTTP headers / files unmodified.
- `src/session/issue.ts` — `issueSessionKey({ publicClient, ownerSigner,
  sessionKeySigner, policies, expiresAt?, policySummary? })` reuses
  `createAgentSmartAccount`, calls `serializePermissionAccount`, wraps
  in the envelope. Session-key private key is NOT embedded — distributed
  out-of-band.
- `src/session/restore.ts` — `restoreSessionAccount({ publicClient,
  envelope, sessionKeySigner })` fails fast on version / chainId /
  signer mismatches before touching ZeroDev's deserialiser.
- `src/session/revoke.ts` — `revokeSessionKey({ ownerKernelClient,
  envelope, sessionKeySigner, policies })` reconstructs the
  `PermissionPlugin` from envelope + policies, then submits a sudo
  UserOp via `@zerodev/sdk`'s `uninstallPlugin` action. The owner kernel
  client MUST be sudo-only (see Fixes below).
- `src/session/rotate.ts` — `rotateSessionKey({ revoke, issue })`
  composes revoke (awaited) + issue.
- `src/session/errors.ts` — `SessionEnvelopeVersionError`,
  `SessionEnvelopeChainMismatchError`, `SessionEnvelopeSignerMismatchError`,
  `SessionEnvelopeParseError`.

### Added (M3-3 — integration example)

- `examples/agent-x402-jpyc/` — Mastra Agent backed by Anthropic Claude
  Sonnet 4.5 pays a Hono paywall in JPYC on Polygon Amoy. Three files:
  `server/index.ts` (Hono + `x402Middleware` + `createSelfFacilitator`),
  `agent/index.ts` (Mastra Agent with one `fetch_weather` tool wrapping
  `wrapFetch`), `scripts/session-demo.ts` (M3-2 issue → serialize →
  parse → restore sidecar).
- `examples/agent-x402-jpyc/README.md` — Zenn-tier walkthrough:
  architecture, prerequisites + faucet URLs + cost estimate, two-
  terminal run, expected output, troubleshooting cheat-sheet, symbol
  table of what kawasekit gives you.

### Added (build / packaging)

- `pnpm-workspace.yaml` declares root + `examples/*` as workspace
  packages so the example links kawasekit via `workspace:*`.
- `package.json` exports map adds `kawasekit/x402`,
  `kawasekit/x402/hono`, and `kawasekit/session` subpaths.
- `tsup.config.ts` now ships four build entries (root + the three
  subpath barrels) with d.ts for each.
- `pnpm m3:x402-self-settle`, `pnpm m3:session-issue-restore`,
  `pnpm m3:session-revoke` scripts wired into root `package.json`.

### Verified live on Polygon Amoy

| Script / flow | Tx hash |
|---|---|
| `pnpm m3:x402-self-settle` | `0x593d13502ea9a40a910d241d5b66ea4e1b0c0094bf7a8bdf516bc275e8f66063` |
| `pnpm m3:session-issue-restore` | `0x4f340d5fed1957f5af000f92a9c8ecf719ecd8436b39b240c0bcaea7ede994e1` |
| `pnpm m3:session-revoke` pre-revoke | `0x2ce2f7efb0f1343828a8bc6f011627b24b9779a69a003607db34d15ca70b7db9` |
| `pnpm m3:session-revoke` uninstall | `0x9c919a0ca5120ff45d0f8f8a8efdd220b85a3ee9a18e1b7a407ceb83cd4adf87` |
| example app — Tokyo | `0x4d80b237455459686283fd3935ea2795908c1eed869f584da7ecbaf2204cefe9` |
| example app — Osaka | `0x05ffcb6c4551bcb2f4866c9888ad76603f690e45c19eb38edf8a48f7fcd31826` |
| example app — Kyoto | `0xb31c7a414f323786f7ab3169628cd060e73528b27bae2da604575497025116bf` |

### Test fixtures

- 200 vitest cases across 15 files (up from 16 at M2). In-process HTTP
  listener helper for the x402 server + Hono adapter tests; reuses the
  existing anvil + MockJPYC harness (now also on chain ID 80002 so
  `eip155:80002` is exercised end-to-end at the encoding boundary).
- Wire-format conformance tests roundtrip kawasekit payloads through
  `@x402/core@2.13.0`'s parser in both directions for three fixtures
  per header type. Byte-equivalent.

### Fixed

- `revokeSessionKey` requires a **sudo-only** owner kernel client. With
  both `sudo` + `regular` plugins on the account, ZeroDev defaults to
  signing UserOps with the `regular` (session-key permission) validator
  and the installed callPolicy rejects `uninstallValidation` as "not
  JPYC.transfer" — surfaces as `AA23 reverted` at paymaster simulation.
  Documented + `@example` updated.
- `createSelfFacilitator`'s gas-payer EOA needs viem's `nonceManager`
  whenever concurrent settlements are possible. Three parallel
  `writeContract` calls without it all read the same on-chain nonce
  and only one lands. The agent example fan-out makes this guaranteed.
  Documented + `@example` updated.

### Changed

- Renamed `scripts/07-x402-self-settle.ts`'s env var
  `OWNER_PRIVATE_KEY` → `X402_PAYER_PRIVATE_KEY` to disambiguate from
  the smart-account sudo signer used by M1/M2/M3-2 scripts. The two
  EOAs play opposite roles (payer holds JPYC, never broadcasts;
  facilitator holds POL, broadcasts but doesn't hold JPYC).

### Dependencies

- Added `hono` as an OPTIONAL peerDependency (`>=4.10.0`) and
  `hono@4.12.22` as a devDependency.
- Added `@x402/core@2.13.0` as a devDependency (conformance tests only;
  not bundled into the kawasekit dist).

### Known limitations

- `revokeSessionKey({ invalidateInFlightNonces: true })` is not
  implemented (deliberate throw to lock in the API shape). In-flight
  UserOps submitted to the bundler before the uninstall lands can still
  mine; M4 adds nonce-key invalidation as the soft revoke.
- Coinbase CDP facilitator's Polygon Amoy support is not asserted by
  upstream docs. The M3 demo uses `createSelfFacilitator` exclusively;
  `createCoinbaseFacilitator` works with any v2-compliant HTTP endpoint
  when available.
- Bare anvil can't exercise issue/restore in full (no ERC-4337
  EntryPoint pre-deployed). Pure-unit tests cover the fail-fast paths;
  `scripts/09` + `scripts/10` cover the on-chain flow against Amoy.

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
