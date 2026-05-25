---
"kawasekit": patch
---

M3 — Externally-callable kawasekit.

**Added (M3-1 — x402 v2 SDK)**
- `createX402PaymentSigner({ account })` — EOA-bound signer that produces
  signed `X402PaymentPayload`s. Wraps M2's `signTransferWithAuthorization`
  and is the first runtime consumer of those helpers. EIP-712 domain
  resolution priority: explicit `domainOverride` → `extra.{name,version}`
  → JPYC fallback (asset address match) → typed error.
- `wrapFetch({ signer, selectRequirements?, onPayment?, fetch? })` — turns
  any WHATWG `fetch` into an x402-aware client. Handles the 402 → sign →
  retry-with-`PAYMENT-SIGNATURE` round-trip in one call. `onPayment` is
  the budget-guard hook (return `false` to abort).
- `createX402Handler({ facilitator, requirementsFor, handler })` —
  framework-agnostic `(Request) => Response` resource-server adapter.
  Routes `requirementsFor(req) === null` straight to the inner handler.
- `x402Middleware(params)` from `kawasekit/x402/hono` — Hono adapter
  (~30 LoC of logic + JSDoc). Hono is a peer dependency (optional).
- `createSelfFacilitator({ walletClient, publicClient })` — local
  verify + broadcast `transferWithAuthorization`. JSDoc now documents
  the `nonceManager` requirement for concurrent settlements (see "Fixes"
  below).
- `createCoinbaseFacilitator({ baseUrl, getAuthHeaders? })` — HTTP-proxy
  facilitator client. Generic against any x402 v2-compliant endpoint
  despite the name.
- `buildPaymentRequirements()` + `buildPaymentRequiredResponse()` —
  server-side builders with JPYC `extra` auto-injection.
- Wire-format codec: `encode/decodePaymentRequiredHeader`,
  `encode/decodePaymentSignatureHeader`, `encode/decodePaymentResponseHeader`,
  plus header-name constants. Standard base64 (not URL-safe) for
  byte-equivalence with `@x402/core`. Conformance tested.
- Full spec-faithful type surface: `X402PaymentRequirements`,
  `X402PaymentPayload`, `X402SettlementResponse`, `X402VerifyRequest`,
  `X402VerifyResponse`, `Facilitator` interface, error codes, and a
  template-literal `X402Network` type that extends automatically when
  `SupportedChainId` adds a chain.

**Added (M3-2 — session-key lifecycle)**
- `issueSessionKey({ publicClient, ownerSigner, sessionKeySigner, policies, ... })`
  — owner-side issuance. Wraps ZeroDev's `serializePermissionAccount`
  output in a typed `KawasekitSessionEnvelope` with chainId, smart-account
  address, optional `expiresAt`, and an advisory `policySummary`.
- `restoreSessionAccount({ publicClient, envelope, sessionKeySigner })` —
  agent-side restore. Fails fast on version / chainId / signer-address
  mismatches before touching ZeroDev's deserialiser.
- `revokeSessionKey({ ownerKernelClient, envelope, sessionKeySigner, policies })`
  — hard revoke via `@zerodev/sdk`'s `uninstallPlugin` action. **Requires
  a sudo-only kernel client** (`createKernelAccount(client, { plugins: { sudo } })`
  with no `regular` plugin) — see "Fixes" below for why.
- `rotateSessionKey({ revoke, issue })` — compositional helper (revoke
  awaited, then issue).
- `serializeSessionEnvelope` / `parseSessionEnvelope` — portable JSON
  envelope wire codec with bigint↔decimal-string boundary.
- Typed errors: `SessionEnvelopeVersionError`,
  `SessionEnvelopeChainMismatchError`, `SessionEnvelopeSignerMismatchError`,
  `SessionEnvelopeParseError`.

**Added (M3-3 — integration example)**
- `examples/agent-x402-jpyc/` — a Hono paywall + Mastra-driven Anthropic
  Claude agent that calls `fetch_weather` tools, paying 0.001 JPYC per
  call via x402 on Polygon Amoy. Mastra is intentionally only used for
  Agent/Tool primitives; the LLM drives orchestration. Includes a
  session-key sidecar (`scripts/session-demo.ts`) that exercises the
  M3-2 issue → serialize → parse → restore round-trip end-to-end.
- pnpm workspace setup (`pnpm-workspace.yaml`) so the example links to
  kawasekit via `workspace:*`.
- Subpath exports `kawasekit/x402`, `kawasekit/x402/hono`,
  `kawasekit/session`. tsup now builds four entry points.

**Verified live on Polygon Amoy**
- scripts/07 (x402 self-settle): tx 0x593d13502ea9a40a910d241d5b66ea4e1b0c0094bf7a8bdf516bc275e8f66063
- scripts/09 (session issue → restore → transfer): tx 0x4f340d5fed1957f5af000f92a9c8ecf719ecd8436b39b240c0bcaea7ede994e1
- scripts/10 (revoke flow): pre 0x2ce2f7efb0f1343828a8bc6f011627b24b9779a69a003607db34d15ca70b7db9, revoke 0x9c919a0ca5120ff45d0f8f8a8efdd220b85a3ee9a18e1b7a407ceb83cd4adf87
- example app (3 parallel agent tool calls): Tokyo 0x4d80b237..., Osaka 0x05ffcb6c..., Kyoto 0xb31c7a41...

**Test fixtures**
- 200 vitest cases across 15 files. Adds in-process HTTP listener helper
  (`test/helpers/http-listener.ts`) for the x402 server / Hono adapter
  tests; the existing anvil + MockJPYC harness covers the self-facilitator
  on chain ID 80002.
- Wire-format conformance tests roundtrip kawasekit payloads through
  `@x402/core@2.13.0` (devDep only). All three header types,
  three fixtures each — byte-equivalent in both directions.

**Dependencies**
- Added `hono` as an OPTIONAL peerDependency (`>=4.10.0`) and `hono@4.12.22`
  as a devDependency. Users who never touch `kawasekit/x402/hono` pay
  zero runtime cost.
- Added `@x402/core@2.13.0` as a devDependency (conformance tests only;
  not bundled).

**Fixes**
- `revokeSessionKey` requires a **sudo-only** owner kernel client. With
  both `sudo` + `regular` plugins on the account, ZeroDev defaults to
  signing UserOps with the `regular` (session-key permission) validator
  and the installed callPolicy rejects `uninstallValidation` as "not
  JPYC.transfer" — AA23 reverted. Documented + sample @example updated.
- `createSelfFacilitator`'s gas-payer EOA needs viem's `nonceManager`
  whenever concurrent settlements are possible (LLM agent fan-out
  guarantees this). Three parallel `writeContract` calls without it all
  read the same on-chain nonce and only one lands. Documented + sample
  @example updated.

**Naming**
- Renamed scripts/07's env var `OWNER_PRIVATE_KEY` →
  `X402_PAYER_PRIVATE_KEY` to disambiguate from the smart-account sudo
  signer used by M1/M2/M3-2 scripts.

**Known limitations**
- `revokeSessionKey({ invalidateInFlightNonces: true })` is not
  implemented (deliberate throw to lock in the API shape). In-flight
  UserOps submitted to the bundler before the uninstall lands can still
  mine — M4 will add nonce-key invalidation as the soft revoke.
- Coinbase CDP facilitator's Polygon Amoy support is not asserted by
  upstream docs. The M3 demo uses `createSelfFacilitator` exclusively;
  `createCoinbaseFacilitator` is generic and works with any v2-compliant
  HTTP endpoint when one is available.
- Bare anvil cannot exercise issue/restore in full (no ERC-4337
  EntryPoint pre-deployed). The corresponding tests are pure-unit;
  scripts/09 + scripts/10 cover the on-chain flow against Amoy.
