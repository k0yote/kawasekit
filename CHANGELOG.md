# Changelog

## 0.1.0-beta.3

### Minor Changes

- ce853ab: # M5-1 — Reasoning-step idempotency layer

  Closes the `THREAT_MODEL.md` §6.1 fund-correctness gap (one of the two named
  `0.1.0` GA gates): an AI agent's _single reasoning step_ can no longer produce
  _two payments_ via retry, "Regenerate", pause-resume, or multi-agent fan-out.

  The fix is layered (the SDK cannot see the LLM intent, only the harness can):
  - **Half A — server-enforced at-most-once (default-on).** `createX402Handler`
    now deduplicates re-sent / concurrent paid requests: it replays the cached
    response and closes the verify→settle TOCTOU, keyed on the client
    `Idempotency-Key` header when present (the logical reasoning-step key, working
    even for signers that cannot derive a nonce) and falling back to the EIP-3009
    nonce otherwise — both namespaced by `(network, payTo, asset)` for
    cross-tenant isolation. Fund-correctness never depends on this store.
  - **Half B — client-opt-in derived nonce (on-chain backstop).** When an
    idempotency key is supplied, the EIP-3009 nonce is derived deterministically
    from it (no shared secret — `keccak256(key ‖ from ‖ verifyingContract ‖
chainId)`), so a re-signed same-intent payment produces the same nonce and the
    token contract's `authorizationState` rejects the duplicate settlement across
    any number of replicas.

  ## New public API (`kawasekit/idempotency` subpath + root)
  - `normalizeIntentText`, `deriveIdempotencyKey`, `createIdempotencyKeyBuilder`,
    `CanonicalRequestIdentity` — the key authority (deterministic, non-semantic).
  - `IdempotencyStore`, `IdempotencyLease`, `IdempotencyLookupResult`,
    `createInMemoryIdempotencyStore` — injectable store + the default in-memory
    bounded-LRU implementation (leased crash-recovery, `validBefore`-anchored TTL,
    one-time multi-replica warning).
  - `IdempotencyRecord`, `serializeIdempotencyRecord`, `parseIdempotencyRecord`,
    `KAWASEKIT_IDEMPOTENCY_RECORD_VERSION` — the persisted record.
  - `IdempotencyConfigError`, `IdempotencyRecordParseError`,
    `IdempotencyRecordVersionError`.
  - `deriveAuthorizationNonce` (on `kawasekit`), `X402_HEADER_IDEMPOTENCY_KEY`.

  ## Wire-up (all additive / backward-compatible)
  - `SignX402PaymentParams.idempotencyKey?` — derive the nonce deterministically.
  - `WrapFetchParams.idempotencyKeyFor?` — attach the `Idempotency-Key` header and
    forward the key into the signer.
  - `CreateX402HandlerParams.idempotency?` (`IdempotencyServerConfig`) — the
    server dedup gate. **Default-on** (in-memory); pass `{ store: "none" }` to
    disable or a shared store for multi-replica deployments.

  ## Notes
  - The in-memory default is **single-process** and emits a one-time
    `KAWASEKIT_IDEMPOTENCY_001` warning; multi-replica deployments require a
    shared store (Layer 3) or the derived nonce (Layer 2) for the guarantee.
  - Replayed responses carry an `Idempotency-Replayed: true` header; snapshots use
    a credential-safe header allowlist and a 64 KiB body cap.

  ## Tests

  45 new cases (296 total): key authority, record (de)serialization, store state
  machine (lease crash-recovery, LRU eviction, TTL), `deriveAuthorizationNonce`
  scoping, and the §6.1 scenario matrix (identical re-send replay, disable,
  header-keyed dedup across differing signatures, cross-tenant isolation,
  concurrent TOCTOU, derived-nonce determinism, `wrapFetch` header propagation).

  Design: `docs/rfc/m5-1-reasoning-step-idempotency.md` (RFC + `web3-cto-review`
  pass). The `THREAT_MODEL.md` §6.1 verdict closure (1.8b/5.5 → ⚠️ with affordance,
  new 1.8c → ✅) lands separately once this code is in.

- 1809b61: # M5-2 — `maxAmountPerSign` signer ceiling

  Closes the second `THREAT_MODEL.md` `0.1.0` GA fund-correctness gate (with §6.1):
  the **amount** a signer will authorize is now pinnable at the primitive, the way
  the **asset** already is (threat 1.4).

  `createX402PaymentSigner` gains an optional `maxAmountPerSign?: bigint`:
  - `sign()` throws `X402InvalidPayloadError` when `requirements.amount` exceeds
    the ceiling (equal is allowed); a non-positive ceiling is rejected at
    construction.
  - Covers the **direct-signer path**, which bypasses the `wrapFetch` `onPayment`
    guard, and the **EOA-payer x402 flow**, which is not bounded by the Layer-4
    session-key daily limit (threat 1.14).
  - **Optional / backward-compatible.** Omit it for no ceiling (the payer EOA
    balance remains the only bound). Production posture is to set it — the verdict
    on threat 1.14 stays `⚠️ Operator responsibility`, exactly parallel to 1.4.

  Threat 1.14 is updated from a future affordance to a shipped one. Tests:
  `src/x402/client.test.ts` (over-ceiling throw / at-ceiling pass / under-ceiling /
  unset = no ceiling / non-positive construction reject).

## 0.1.0-beta.2

### Patch Changes

- ff50f78: # External-review + source-verification closures (beta line)

  Promotes the alpha line to beta after closing a full CTO-class review of
  `docs/THREAT_MODEL.md` (19 findings + 5 follow-ups) and a second,
  source-verification pass (3 new findings) against the actual SDK source.
  Two of the closures are **breaking changes to the public API** vs
  `0.1.0-alpha.0` / `0.1.0-alpha.1` — see the breaking-notes section below.

  ## Breaking API changes (vs alpha.0 / alpha.1)
  - **`wrapFetch`'s `onPayment` is now required at the type level** (review
    item C1). It was optional in alpha; omitting it silently defaulted to
    "always pay". It is now a non-optional field on `WrapFetchParams`
    (`src/x402/fetch.ts`) — omission is a compile-time error. Existing
    callers that relied on the default must add an explicit budget gate, or
    `onPayment: () => true` to opt in deliberately.
  - **`createX402PaymentSigner`'s `asset` is now a required discriminated
    union** (review item H2). The optional `domainOverride` field is
    **removed**; `CreateX402PaymentSignerParams.asset` is now
    `{ kind: "known"; id: KnownAssetId } | { kind: "unsafeOverride"; domain }`.
    The signer pins the EIP-712 domain at construction and cross-checks
    `paymentRequirements.asset` at every sign call, so a malicious server's
    advertised `extra.name` / `extra.version` are no longer consulted (Threat
    1.4). For JPYC v2 pass `{ kind: "known", id: "jpyc-v2" }`; for any other
    asset, `{ kind: "unsafeOverride", domain }` is the deliberately-loud
    escape hatch. New error `X402InvalidConfigError` is thrown on unknown
    `kind` / unknown id / malformed override.

  ## New public API surface
  - `X402AssetParam`, `KnownAssetId`, `KnownAssetDomain`, `getKnownAssetDomain`,
    `listKnownAssetIds`, `X402InvalidConfigError` — exported from the root and
    the `kawasekit/x402` subpath (`src/tokens/known-assets.ts`,
    `src/x402/errors.ts`).

  ## Security posture (no code change, documented)
  - **New Layer 1 threat 1.14 — server-advertised amount inflation** (source-
    verification finding H1-A): the signer bounds the requested `amount` only
    by `uint256` shape — no ceiling. The `wrapFetch` `onPayment` guard is the
    operator's required ceiling, and the public direct-signer path bypasses
    it; the EOA-payer x402 path is **not** bounded by the Layer-4 session-key
    daily-limit. A `maxAmountPerSign` affordance is planned for M5 (H1 Part B).
  - Threat 1.8 split into 1.8a (✅ API-surface, the required `onPayment`) and
    1.8b (🟡 wire-format reasoning-step gap) so the verdict matches the §0
    vocabulary (no hybrid labels).
  - Threats 1.3 (MITM) and 2.3 (DoS via `/verify`) moved ⚠️ → 🔵 (the SDK is
    genuinely not the defence layer). New threats 1.12 (clock skew), 1.13
    (JSON payload DoS), 2.9 (revoke reorg), 4.8 (Kernel nonce-key collision).
  - The JPYC v2 contract citations behind the 1.1 / 1.11 / 4.7 ✅ verdicts are
    now independently resolvable (commit-pinned upstream `jcam1/JPYCv2@e06edf5`
    permalinks + the Polygonscan-verified deployed implementation
    `0xafAc17FC…`), instead of the gitignored local `fiat/` tree (finding H2).
  - New operator runbook `docs/recipes/revoke-race-mitigation.md` (review item
    H3); example PK loading abstracted behind `createPkProvider` (`env://`
    demo vs `kms://` production, item H5); new informative §8 "Regulatory
    affordances".

  ## Tests / tooling
  - 251 vitest cases (alpha.1 had 247). Added: asset-whitelist (Threat 1.4)
    cases, the `onPayment`-required `expectTypeOf` type test, and a
    `fast-check` property-based test for BASE64 regex / decoder agreement.
  - `fast-check` added as a devDependency.
  - The supply-chain-policy CI assertion is now a shared composite action
    (`.github/actions/assert-supply-chain-policy`) invoked by both `ci.yml`
    and `release.yml` (item F5).

  The full per-item trail (C1–C3 / H1–H5 / M1–M6 / L1–L5 / F1–F5 + the
  source-verification Sprint 1+2 items) is recorded in `docs/THREAT_MODEL.md`
  Appendix A.

  ## Publish

  Publishes under the `beta` dist-tag (`pnpm add kawasekit@beta`). The
  prerelease counter is monotonic across the pre-release window and does not
  reset on the alpha→beta tag change, so this lands as `0.1.0-beta.2`
  (continuing alpha.0 / alpha.1). The `0.0.1` placeholder remains on the
  `latest` tag until v0.1.0 GA (planned for M5 after the external human formal
  review).

## 0.1.0-alpha.1

### Patch Changes

- 564d00f: # 0.1.0-alpha.1 — pre-external-review hardening

  Three SDK-level threat-model gaps surfaced in the M4 self-review are now
  closed with code, not just docs. The pre-fix mitigations were JSDoc /
  example-only; this release moves them behind runtime checks so external
  reviewers can confirm `✅ Mitigated` in source.

  ## SDK behaviour changes
  - **`createSelfFacilitator` requires `nonceManager`** (closes threat 2.2 /
    §6.5). The bound walletClient's account must carry viem's
    `nonceManager`; construction throws otherwise with a copy-pasteable
    fix message. The pre-fix code silently dropped settlements under
    parallel-fan-out load (typical LLM agent tool calling).
  - **Canonical base64 enforced** (closes threat 1.7 / §6.7). The decoder
    `BASE64_REGEX` is tightened to RFC 4648 §4: length must be a multiple
    of 4 and only the legal trailing forms `XX==` / `XXX=` / `XXXX` are
    accepted. Non-canonical inputs (overlong padding, embedded
    whitespace / newlines / tabs, misplaced padding, impossible lengths)
    are rejected upfront instead of slipping through to the JSON parser
    where cross-runtime behaviour differs between Node's `Buffer` and
    browser `atob`.
  - **Chain-aware `confirmations` for settle finality** (closes threat 2.8
    / §6.6). `CreateSelfFacilitatorParams` gains a `confirmations?: number`
    option threaded into viem's `waitForTransactionReceipt({ confirmations })`.
    Chain-aware default: `1` on testnet, **`4` on mainnet** (~8 s of soft
    finality at Polygon's ~2 s block time). High-value merchants raise to
    32+ and bump `receiptTimeoutMs` to match.

  ## Breaking notes for alpha.0 consumers
  - Constructing a facilitator without `nonceManager` now throws at boot.
    The fix is a one-line `{ nonceManager }` addition to `privateKeyToAccount`.
  - A handful of non-canonical base64 inputs that previously failed at the
    JSON parse step now fail at the base64 regex with a clearer error.
    Inputs that decode to valid JSON were never produced by kawasekit's
    encoder, so legitimate clients are unaffected.
  - The default `confirmations` on mainnet (`4`) adds ~8 s to each
    settle's wall-clock time. Operators who prefer the old single-receipt
    wait pass `confirmations: 1` explicitly.

  ## Documentation

  `docs/THREAT_MODEL.md` gains a Layer 0 (Supply chain & build integrity)
  section with 5 threats backed by actual config citations (pnpm
  `minimumReleaseAge`, `allowBuilds`, npm provenance attestation, exact-
  pinned production deps). §6.5 / §6.6 / §6.7 are marked **closed** with
  the pre-fix gap preserved as historical record. Verdict tally:
  27 ✅ Mitigated / 19 ⚠️ Operator responsibility / 4 🔵 Out of scope /
  3 🟡 Known limitation, with 0 split verdicts remaining.

  ## Tests

  247 vitest cases (alpha.0 had 228). Added: 2 nonceManager enforcement
  cases, 15 RFC 4648 adversarial cases, 2 confirmation depth cases.

  ## Publish

  Publishes as `kawasekit@0.1.0-alpha.1` under the `alpha` dist-tag. The
  `0.0.1` placeholder remains on the `latest` tag until v0.1.0 GA.

## 0.1.0-alpha.0

### Minor Changes

- e01d138: # M4 — Mainnet support, observability, threat model, CLI, docs site, first npm publish

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

### Patch Changes

- bae0b1b: M2 — Agent-payable JPYC.

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

- 3efef34: M3 — Externally-callable kawasekit.

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

  **Verified live on Polygon mainnet (M4-1.8 + M4-1.9)**

  The two on-chain deliverables required by M4's Definition of Done. Both
  ran from a clean-room mainnet wallet provisioned with 1 JPYC per payer
  address (payer EOA + smart account) and 1 POL for the facilitator EOA.
  - **M4-1.8 / scripts/11 — self-facilitator settle**: an EOA payer signs
    EIP-3009 off-chain; the facilitator EOA broadcasts
    `transferWithAuthorization` and 0.001 JPYC moves end-to-end in 3.0 s.
    Facilitator gas spend: 0.0308 POL.
    Settlement tx: [0x6feacc719785c0fd8be0d8eeb1aff6b766abfb9c3acce6a79b00d4bdb2536502](https://polygonscan.com/tx/0x6feacc719785c0fd8be0d8eeb1aff6b766abfb9c3acce6a79b00d4bdb2536502).
  - **M4-1.9 / scripts/12 — session-key full lifecycle**: owner issues a
    fresh ephemeral session key with a daily-limit policy, the agent
    transfers 0.001 JPYC from the smart account through the session-key
    permission validator, the owner revokes the validator, and a final
    post-revoke transfer attempt is asserted to revert at the AA
    validation phase. ZeroDev paymaster sponsored all UserOps.
    - Pre-revoke transfer (the deliverable tx): [0x44a914331fc8ba78e2ad5a13da73535e45b4d89aba318effd5cf8a2bd89e1c8c](https://polygonscan.com/tx/0x44a914331fc8ba78e2ad5a13da73535e45b4d89aba318effd5cf8a2bd89e1c8c).
    - Revoke (uninstallValidation, owner sudo client): [0x8017f71190bc4e7cb78d2ce5356e2a54282a9bb0616142fcf505ac64be3e8945](https://polygonscan.com/tx/0x8017f71190bc4e7cb78d2ce5356e2a54282a9bb0616142fcf505ac64be3e8945).
    - Post-revoke transfer attempt: reverted by Kernel's permission
      validator before any on-chain settlement, as expected. No
      broadcast tx.

  The same scripts are reusable for future alpha / beta / GA verification
  via `KAWASEKIT_X402_CHAIN=polygon KAWASEKIT_ALLOW_MAINNET=1`.

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

| Script / flow                       | Tx hash                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `pnpm m3:x402-self-settle`          | `0x593d13502ea9a40a910d241d5b66ea4e1b0c0094bf7a8bdf516bc275e8f66063` |
| `pnpm m3:session-issue-restore`     | `0x4f340d5fed1957f5af000f92a9c8ecf719ecd8436b39b240c0bcaea7ede994e1` |
| `pnpm m3:session-revoke` pre-revoke | `0x2ce2f7efb0f1343828a8bc6f011627b24b9779a69a003607db34d15ca70b7db9` |
| `pnpm m3:session-revoke` uninstall  | `0x9c919a0ca5120ff45d0f8f8a8efdd220b85a3ee9a18e1b7a407ceb83cd4adf87` |
| example app — Tokyo                 | `0x4d80b237455459686283fd3935ea2795908c1eed869f584da7ecbaf2204cefe9` |
| example app — Osaka                 | `0x05ffcb6c4551bcb2f4866c9888ad76603f690e45c19eb38edf8a48f7fcd31826` |
| example app — Kyoto                 | `0xb31c7a414f323786f7ab3169628cd060e73528b27bae2da604575497025116bf` |

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
  - Amoy both at `0xE7C3D8C9...c29`), `JPYC_DECIMALS`, `JPYC_V2_ADDRESS`,
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
