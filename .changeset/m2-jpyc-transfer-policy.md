---
"kawasekit": patch
---

M2 — Agent-payable JPYC.

**Added**
- `transferJpyc(kernelClient, { to, amount })` sends `JPYC.transfer()` as a
  sponsored Kernel UserOp. Smart-account `from` is the canonical agent
  payment path; EIP-3009 cannot be used here because JPYC's signature check
  is pure `ecrecover`.
- EIP-3009 signing helpers (`signTransferWithAuthorization`,
  `signReceiveWithAuthorization`, `signCancelAuthorization`,
  `generateAuthorizationNonce`, `authorizationDeadlineFromNow`) — pure
  off-chain typed-data builders for the EOA-payer / x402 flow being built in
  M3.
- JPYC token metadata module: `getJpycAddress`, `jpycDeployments`,
  `JPYC_DECIMALS`, `JPYC_V2_ADDRESS`, `JPYC_EIP712_DOMAIN_HINT`, and a
  minimal ERC-20 + EIP-3009 ABI (`jpycAbi`). Polygon mainnet + Amoy both
  live at `0xE7C3D8C9...c29`.
- `createJpycDailyLimitPolicies({ jpycAddress, maxPerTransfer,
  maxTransfersPerDay })` composes ZeroDev's `callPolicy` (per-tx value cap)
  and `rateLimitPolicy` (24h tx count) into a daily-limit bundle.
  `ONE_DAY_SECONDS` constant exposed.
- `createAgentSmartAccount({ publicClient, ownerSigner, sessionKeySigner,
  policies })` wires sudo (owner ECDSA) + regular (session-key permission
  validator) into a Kernel v3.1 smart account. Policy violations revert at
  the ERC-4337 validation phase.
- `scripts/03-transfer-jpyc.ts` (`pnpm m2:transfer-jpyc`) and
  `scripts/04-transfer-with-policy.ts` (`pnpm m2:transfer-with-policy`) —
  Polygon Amoy end-to-end demos.

**Test fixtures**
- prool-based vitest harness boots anvil for the EIP-3009 integration
  tests.
- `MockJPYC` test fixture (test-only, EIP-3009 compatible, free mint, no
  Pausable/Blocklist/Minter) lives in the
  [kawasekit-contracts](https://github.com/k0yote/kawasekit-contracts) repo;
  its compiled bytecode is committed under `test/fixtures/MockJPYC.json`
  and refreshed by `script/sync-sdk-fixtures.sh` in that repo.
- 16 vitest cases (EIP-3009 happy/expired/nonce-reuse/frontrun/cancel,
  transfer encoding + input validation, daily-limit policy shape).

**Changed**
- `KawaseChain` no longer carries a `jpycAddress` field. Token deployment
  data lives in `src/tokens/jpyc.ts` (single source of truth). Existing
  consumers of `polygon.jpycAddress` should switch to
  `getJpycAddress(polygon.id)`.

**Dependencies**
- Added `@zerodev/permissions@5.5.14` (production).
- Added `prool@^0.2.4` (devDependency, anvil lifecycle for tests).

**Known limitations**
- The Amoy E2E scripts cannot run end-to-end until the agent's smart
  account holds JPYC on Amoy — JPYC on Amoy is mint-controlled and there
  is no public testnet faucet today.
- Recipient allowlisting is not part of the M2 spending policy. Each
  transfer is capped by amount and frequency, but `to` is unrestricted.
  Allowlisting is planned for M3.
- `createJpycDailyLimitPolicies` enforces `maxPerTransfer × maxTransfersPerDay`,
  not a cumulative-amount tracker. ZeroDev's policy library does not ship
  a per-token spending-limit policy.
