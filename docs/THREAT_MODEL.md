# kawasekit Threat Model

> Status: **DRAFT** — pending external security review prior to the `kawasekit@0.1.0`
> npm publish. Comments and counter-examples are welcome via the channels in
> [`SECURITY.md`](../SECURITY.md).

## 0. Scope & reading guide

This document is the security-facing companion to the kawasekit SDK source. It is
written for two audiences:

1. **External security researchers** evaluating whether a given attack surface
   in kawasekit is exploitable, and under what assumptions.
2. **CTOs / tech leads** deciding whether kawasekit is a safe primitive to embed
   in a production product.

It is **not** an introductory document. Reading prerequisites:

- ERC-4337 (Account Abstraction) v0.7
- ZeroDev Kernel v3.1 plugin architecture (sudo / regular validators)
- EIP-3009 `transferWithAuthorization` semantics — in particular that the
  signature scheme uses pure `ecrecover` and does **not** consult ERC-1271,
  so smart-account holders cannot be `from`
- x402 v2 wire format (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE
  headers, exact-EVM scheme)

The scope covered here is the **kawasekit SDK source tree in this repository**.
Out of scope:

- The JPYC contract itself (audited separately by JPYC Inc.)
- The ZeroDev Kernel implementation (audited separately by ZeroDev)
- Bundler / paymaster operator code (operated by third parties or the user)
- The smart-contract repository `kawasekit-contracts` (separate threat model)

Each layer below uses a fixed structure:

- **Surface** — what the SDK exposes or does on this layer
- **Trust assumptions** — what kawasekit takes as given
- **Threats considered** — listed with a verdict, one of:
  - ✅ **Mitigated** — code in the SDK prevents the attack
  - ⚠️ **Operator responsibility** — exploitable unless the integrator
    follows specific documented guidance
  - 🔵 **Out of scope** — the SDK is not the right defence layer; another
    layer (TLS, hardware wallet, agent framework) is
  - 🟡 **Known limitation** — recognised gap, tracked in §6
- **Where the mitigation lives** — file paths into the source

The verdict vocabulary is deliberately small so that a reviewer can scan the
document and find every threat the SDK believes it has not solved.

---

## 1. Layer 1 — EIP-3009 / x402 wire format

### Surface

- Client-side: `createX402PaymentSigner` (`src/x402/client.ts`) produces an
  EIP-3009 `TransferWithAuthorization` signature plus the x402 v2 wire payload
  (`X402PaymentPayload`).
- Server-side: `createX402Handler` (`src/x402/server.ts`) and the Hono adapter
  (`src/x402/hono/index.ts`) parse the inbound `PAYMENT-SIGNATURE` header,
  hand the payload to a `Facilitator.verify`, and on success a
  `Facilitator.settle` broadcasts the authorization on-chain.
- Encoding helpers: `src/x402/encoding.ts` handles base64 + JSON
  conformance for the three x402 headers.

### Trust assumptions

- The transport between client and server is TLS-terminated. kawasekit ships
  no application-layer encryption for the `PAYMENT-SIGNATURE` header.
- The token contract at `paymentRequirements.asset` enforces EIP-3009
  semantics correctly (single-use nonce, monotonic time window). kawasekit
  re-verifies but does not duplicate the contract's invariants.
- The EIP-712 domain `name` / `version` advertised by the server is correct
  or, for JPYC v2, matches the well-known constants in
  `JPYC_EIP712_DOMAIN_HINT`.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 1.1 | Cross-chain replay (same JPYC address, different chain) | ✅ Mitigated | `chainId` is bound into the EIP-712 domain on signing (`src/x402/client.ts`, `signTransferWithAuthorization`) and verified on settle (`facilitator.ts` `recoverTypedDataAddress`). A signature with `chainId=0` would mathematically replay, but the SDK never emits one — `chainId` is always derived from the signer chain. |
| 1.2 | Cross-chain replay (same chain, attempted nonce reuse) | ✅ Mitigated | `generateAuthorizationNonce()` returns a 32-byte cryptographic random; the on-chain `authorizationState` mapping rejects any reuse at the token contract. The facilitator additionally pre-checks `authorizationState` in `verify` to avoid a wasted gas tx. |
| 1.3 | MITM eavesdrop + race-broadcast of `PAYMENT-SIGNATURE` | ⚠️ Operator responsibility | The signed authorization is bearer-grade until on-chain inclusion. An attacker who reads the header before the legitimate facilitator submits can race-broadcast it on their own. **The x402 spec assumes HTTPS in production.** kawasekit produces no plain-HTTP examples and the Hono adapter does not enforce TLS — the integrator must. |
| 1.4 | Misadvertised EIP-712 domain by a malicious server | ⚠️ Operator responsibility | A server can advertise `extra.name="Evil"` to coerce a signature that recovers against a different domain. kawasekit's `createX402PaymentSigner` accepts a `domainOverride` so a client that knows the right token can pin it. JPYC v2 falls through to the well-known hint automatically. **Recommendation**: callers signing for non-JPYC assets should pass `domainOverride` against a hard-coded whitelist. |
| 1.5 | Time-window manipulation (replay outside `validAfter`/`validBefore`) | ✅ Mitigated | `verify` checks `now ∈ [validAfter, validBefore)` and returns distinct error codes. The default lifetime (`X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS = 300`) bounds the bearer-window. |
| 1.6 | Network / chainId mismatch silently accepted | ✅ Mitigated | M4-1 added a required `network: "mainnet" \| "testnet"` argument to both `createSelfFacilitator` and `createX402PaymentSigner`, and a runtime check throws if it disagrees with the chain identity. This catches the "testnet PK accidentally hitting mainnet RPC" failure mode at construction or sign time, before any broadcast. |
| 1.7 | Header smuggling / base64 malleability | ✅ Mitigated | The encoding layer (`src/x402/encoding.ts`) is byte-equivalence tested against the upstream `@x402/core` reference (`encoding.conformance.test.ts`). |
| 1.8 | Reasoning-step duplicate payment (same agent intent, multiple calls) | 🟡 Known limitation | See §6.1. The x402 wire format guarantees only **call-level** idempotency via the EIP-3009 nonce. A reasoning-step layer is missing. |

### Where the mitigations live

- `src/x402/client.ts` — sign-time network check, time window override
- `src/x402/facilitator.ts` — verify-side replay, network, and balance checks
- `src/x402/encoding.ts` — wire-format encoding/decoding
- `src/tokens/eip3009.ts` — EIP-712 typed-data signer
- `src/x402/encoding.conformance.test.ts` — byte-equivalence with reference

---

## 2. Layer 2 — Self-facilitator EOA

### Surface

`createSelfFacilitator` (`src/x402/facilitator.ts`) is the in-process broadcaster
that turns a verified x402 payload into a `transferWithAuthorization` call on
chain. It is the production-default for kawasekit because the Coinbase CDP
facilitator does not yet support Polygon Amoy and may or may not support
Polygon mainnet at the time this document ships.

The facilitator owns:

- A viem `WalletClient` whose bound `Account` is an EOA that pays gas. **This
  EOA never holds user JPYC** — it is purely the broadcaster.
- A `PublicClient` for balance and authorization-state reads.

### Trust assumptions

- The facilitator EOA private key is held by the operator (the party running
  the paywall server).
- The chain advertised by `walletClient.chain.id` is the chain the operator
  intends to use. The M4-1 `network` argument double-checks the operator's
  intent.
- The RPC endpoint is honest (no eclipsing). Eclipse attacks on a single
  RPC are outside kawasekit's scope — operators are expected to use a
  multi-source endpoint or a node they trust.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 2.1 | Theft of facilitator EOA key | ⚠️ Operator responsibility | Compromise drains the EOA's gas balance (POL). It does **not** drain user JPYC — the EOA never holds JPYC. Impact is denial of service against the paywall, not theft of payer funds. Mitigation lives in operator key custody (HSM / KMS / Vault — `recipes/` chapter, M4). |
| 2.2 | Concurrent settle nonce race | ✅ Mitigated | Documented in `createSelfFacilitator` JSDoc and enforced by example: the facilitator account MUST be constructed with viem's `nonceManager` to serialise nonces under concurrency. Without it, parallel settles race and only one lands — a correctness failure caught in M3-3 testing and now an example invariant. |
| 2.3 | DoS via repeated invalid `/verify` calls | ⚠️ Operator responsibility | An attacker can feed crafted payloads that fail at simulation, costing the facilitator no gas but consuming RPC reads. kawasekit does no rate-limiting. **Recommendation**: rate-limit at the HTTP layer (the Hono adapter exposes `/verify` and `/settle` for the operator to wrap). |
| 2.4 | MEV sandwich on settle | 🔵 Out of scope | `transferWithAuthorization` is a fixed-amount, fixed-recipient transfer with no slippage. There is no profitable sandwich. The only MEV available is censorship (reorder to delay), which the time window upper-bounds. |
| 2.5 | Gas grief — pushing receiptTimeoutMs past completion | ⚠️ Operator responsibility | Default `receiptTimeoutMs = 60_000`. If the bundler / chain is congested, settle may return `unexpected_settle_error` even though the tx eventually lands. The operator should not double-broadcast on this error — the nonce will already be marked used. **Recommendation**: surface `txHash` in error path (already done in `failSettle`) and let the operator probe the chain rather than retry blindly. |
| 2.6 | facilitator EOA signing data not in its intended scope | ✅ Mitigated | The facilitator only signs `transferWithAuthorization` calls on tokens specified by the verified payload. It does not expose a generic signing endpoint. There is no path from a malicious payload to a non-transfer call from this EOA. |
| 2.7 | Misconfigured `network`/`chain.id` (mainnet broadcast on testnet config) | ✅ Mitigated | M4-1 required `network` argument fails fast at construction if the chain identity disagrees. Without this check (M3 behaviour), an operator could have silently broadcast against the wrong network. |

### Where the mitigations live

- `src/x402/facilitator.ts` — `createSelfFacilitator`, including network check
- `src/x402/facilitator.self.test.ts` — concurrent settle invariant
- `examples/agent-x402-jpyc/server/index.ts` — nonceManager usage in practice
- `docs/recipes/` (planned M4) — HSM / KMS / Vault key custody patterns

---

## 3. Layer 3 — Session-key envelope

### Surface

`src/session/` exposes the lifecycle of a session key — a regular Kernel
validator installed by the owner that permits a bounded set of operations
(usually `transfer` on JPYC up to a daily limit). The lifecycle operations are:

- `issueSessionKey` — owner installs the validator + policy
- `restoreSessionKey` — agent rebuilds the kernel client from a saved envelope
- `revokeSessionKey` — owner uninstalls the validator (sudo-only)
- `rotateSessionKey` — issue a new + revoke the old

The artefact passed between owner and agent is a `KawasekitSessionEnvelope`
(opaque JSON containing the validator address, install data, policy summary,
and an advisory `expiresAt`).

### Trust assumptions

- The owner's wallet remains uncompromised. There is no recovery layer at
  the Kernel v3.1 level: loss of owner key is unrecoverable.
- The agent's environment can hold the session-key private key with at
  least the security of an OS-level secret store. The example app puts it
  in `.env` for demonstration purposes; this is **not** the production
  posture.
- The envelope is transported via a channel the operator considers secure
  (typically owner → agent within the same operator). kawasekit does not
  encrypt the envelope itself.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 3.1 | Envelope theft alone | ✅ Mitigated | The envelope is useless without the matching session-key private key. The PK is distributed out-of-band and never embedded in the envelope. |
| 3.2 | Envelope + session-key PK theft | ⚠️ Operator responsibility | The combined pair is bearer-grade up to the on-chain policy limits. The owner can revoke at any time (see 3.4). Loss of the agent secret is functionally equivalent to a stolen-card scenario, bounded by the daily limit. |
| 3.3 | Policy circumvention via direct validator install | ✅ Mitigated | Only the owner can install validators. The session key's permission validator cannot install a sibling validator — `uninstallValidation` and `installValidation` are gated to sudo authority by Kernel itself. |
| 3.4 | Revoke race (session key submits work between owner revoke broadcast and inclusion) | 🟡 Known limitation | `revokeSessionKey` submits a single sudo UserOp. UserOps the session key issued **before** that UserOp lands can still mine. Documented in SECURITY.md M3-2 bullet 3 and unchanged in M4. A soft-revoke via nonce-key invalidation is tracked for M5. Until then, an operator MUST NOT assume an in-flight attack stops the moment `revokeSessionKey` returns. |
| 3.5 | Revoke fails closed due to misconfigured client | ✅ Mitigated | `revokeSessionKey` requires a sudo-only kernel client. A client with both sudo + regular plugins would let ZeroDev sign with the session-key validator, which the spending policy then rejects. The function documents this requirement and the failure is loud (an error), not silent (a fake success). |
| 3.6 | Envelope policy fingerprinting | ⚠️ Operator responsibility | The envelope contains `policySummary` in plain text — an observer learns the daily-limit shape. This is acceptable for most use cases (the limit is itself public on-chain). Operators handling unusual policy shapes (e.g. covering a specific user identity) should treat the envelope as confidential and consider envelope encryption (planned M5, see §6.2). |
| 3.7 | Expiry not enforced on-chain | ⚠️ Operator responsibility | The envelope's `expiresAt` is advisory metadata. A `TimestampPolicy` must be installed alongside the spending policy for the chain to enforce the cut-off. Documented in M3-2 SECURITY.md bullet 1. The CLI (`kawasekit session-key issue`, M4-4) will surface this requirement at issuance time. |

### Where the mitigations live

- `src/session/issue.ts`, `src/session/revoke.ts`, `src/session/restore.ts`
- `src/policy/jpyc-daily-limit.ts` — daily-limit policy installed under the
  session-key validator
- `src/account/kernel-client.ts` — sudo-only client construction
- `scripts/09-session-issue-restore.ts`, `scripts/10-session-revoke.ts` —
  on-chain verified flows on Polygon Amoy

---

## 4. Layer 4 — Smart account boundary

### Surface

`src/account/` constructs a ZeroDev Kernel v3.1 smart account for the agent.
The account holds JPYC and signs UserOps via one of two validator chains:

- **sudo** — owner-signed (ECDSA Validator on the owner EOA)
- **regular** — session-key signed (permission validator + policies)

`transferJpyc` (`src/tokens/jpyc.ts`) is the canonical operation — a UserOp
that calls `JPYC.transfer()`. EIP-3009 is **not** used here because JPYC v2's
`transferWithAuthorization` is pure-`ecrecover` and rejects contract `from`.

### Trust assumptions

- The Kernel v3.1 + EntryPoint v0.7 implementation is correct. kawasekit's
  defence ends at the boundary; we trust the AA framework to enforce
  validator routing.
- Validator addresses installed on the account are the canonical ZeroDev
  ones, not adversary forks. kawasekit hard-codes the validator addresses
  from `@zerodev/permissions` / `@zerodev/ecdsa-validator` releases.
- The paymaster is the operator's chosen provider (default: ZeroDev's
  built-in). A malicious paymaster cannot drain user JPYC; it can refuse
  to sponsor (DoS).

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 4.1 | Validator privilege escalation (session key → sudo) | ✅ Mitigated | Kernel v3.1 routes UserOps to validators based on the operation's nonce key. A session-key UserOp cannot reach sudo-flagged paths (`installValidation`, `uninstallValidation`). Confirmed in `scripts/10-session-revoke.ts` — attempts to revoke from the session key fail at the policy check. |
| 4.2 | UserOp signature replay across accounts | ✅ Mitigated | EntryPoint v0.7 binds the UserOp hash to the account address plus the chain id. A signature for account A on chain X cannot replay against account A on chain Y nor against account B on chain X. |
| 4.3 | Paymaster sponsorship exploited to drain JPYC | 🔵 Out of scope | The paymaster pays gas in chain-native currency; it does not touch JPYC. A compromised paymaster results in stuck UserOps (no sponsorship), not JPYC loss. |
| 4.4 | Default signer assumption in mixed-plugin clients | ⚠️ Operator responsibility | If the operator constructs a `KernelAccountClient` with both sudo and regular plugins, the "default" signer is determined by the construction order. kawasekit's helpers (`buildKernelAccountClient`, `buildSessionKernelClient`) hide this — third-party constructors are responsible for matching signer to operation. Documented in SECURITY.md M2 bullet 1. |
| 4.5 | Daily-limit accounting reset by reissuing session key | ✅ Mitigated | The on-chain policy state is bound to the validator instance, not the address. Issuing a new validator does not "reset" anything because each new validator is a distinct instance. Revoking and reissuing is the explicit operator-authorised path. |
| 4.6 | Malicious paymaster targeting account-level metadata | 🔵 Out of scope | Paymasters see UserOp metadata (sender, target, calldata). For a JPYC `transfer`, this means: who paid whom, when, how much. This is **on-chain public** after inclusion; the paymaster sees it at most a few seconds early. kawasekit does not consider this a confidentiality breach because the data is public. Operators wanting confidential payments need a different primitive. |
| 4.7 | EIP-3009 attempted from smart-account `from` | ✅ Mitigated | JPYC v2's `transferWithAuthorization` uses pure `ecrecover`. Any signature whose `from` is a smart account address recovers to a *different* EOA address (or fails), so `verify` rejects it with `invalid_exact_evm_payload_signature`. kawasekit's facilitator does not need a separate guard — the token contract is the source of truth. |

### Where the mitigations live

- `src/account/kernel-client.ts` — sudo-only and session-key client builders
- `src/tokens/jpyc.ts` — `transferJpyc` via UserOp (the smart-account-safe path)
- `src/x402/facilitator.ts` — signature recovery catches EIP-3009 abuse
- `scripts/05-verify-eip3009-smart-account.ts` — end-to-end test of 4.7

---

## 5. Layer 5 — Agent runtime

### Surface

`examples/agent-x402-jpyc/agent/index.ts` is a reference integration showing
how an LLM agent (Mastra + Anthropic Claude) consumes paywalled APIs through
`wrapFetch` + `createX402PaymentSigner`. This layer is **outside the SDK
boundary** — kawasekit does not ship a runtime — but the SDK's API design
shapes what's enforceable here.

### Trust assumptions

- The agent framework (Mastra, LangChain, …) routes tool calls correctly.
  kawasekit does not adjudicate which tool an LLM "should" have called.
- The LLM provider is honest. Prompt injection from an upstream API
  response, however, is a realistic threat treated below.
- The agent runs in an environment where the operator controls the
  process boundary (process isolation, secret store, network egress).

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 5.1 | LLM prompt injection → unbounded paywall spend | ⚠️ Operator responsibility | A poisoned tool-call response can instruct the LLM to call expensive endpoints repeatedly. kawasekit's `wrapFetch` exposes an `onPayment(requirements)` callback that the operator MUST implement as a budget guard — the example does so (`onPayment` returns `false` past `AGENT_BUDGET_JPYC`). The guard is **advisory**: a misbehaving tool that bypasses `wrapFetch` and signs directly can ignore it. Multi-layer enforcement (on-chain policy + off-chain guard + framework approval gate) is the documented recommendation. |
| 5.2 | Budget guard bypassed by direct signer access | ⚠️ Operator responsibility | If the operator's tool implementation exposes `signer.sign(…)` directly, the `onPayment` guard does not see the call. **Recommendation**: tools should only have access to `wrapFetch`, not to the underlying signer. |
| 5.3 | Tool input forgery (other tool feeds the paywall tool bogus params) | 🔵 Out of scope | This is a property of the agent framework's tool dispatcher (e.g. Mastra's `tools` schema validation). kawasekit cannot reach into the framework to validate. |
| 5.4 | Agent runtime leaks the signer PK via logs | ⚠️ Operator responsibility | kawasekit's logger module (`src/logger/`) does not log signatures or private keys. The example app does not log them either. A third-party tool or framework that logs request bodies could inadvertently capture `PAYMENT-SIGNATURE`. **Recommendation**: redact `PAYMENT-SIGNATURE` and `Authorization` headers in any HTTP logger. |
| 5.5 | Reasoning-step duplicate payment | 🟡 Known limitation | See §6.1. Mitigation is **agent-side**: pair tool calls with idempotency keys at the framework layer. kawasekit cannot enforce this from the SDK boundary because the SDK does not see the reasoning graph. |
| 5.6 | Holding the agent payer EOA PK in `.env` | ⚠️ Operator responsibility | Acceptable for local Polygon Amoy demo; **not** production posture. Production deployments should derive a session-scoped key from a hardware-backed root and keep the long-lived owner key offline. The example explicitly notes this in its `README.md`. |

### Where the mitigations live

- `src/x402/fetch.ts` — `wrapFetch` and the `onPayment` budget hook
- `src/logger/` — secret-redacting logger (M3)
- `examples/agent-x402-jpyc/README.md` — production-vs-demo posture notes

---

## 6. Known limitations

These are gaps that kawasekit acknowledges and chooses **not** to close in the
0.1.0 release. Each entry records the gap, the consequence, and the planned
mitigation path.

### 6.1. Reasoning-step idempotency gap

**Gap.** kawasekit and the x402 v2 specification guarantee idempotency at three
levels:

| Layer | Unit | Status |
|---|---|---|
| EIP-3009 nonce | One signed authorization | ✅ 32-byte random, replay-safe at the token contract |
| `viem.nonceManager` | One blockchain tx | ✅ Required in `createSelfFacilitator` JSDoc, used in M3-3 example |
| HTTP `Idempotency-Key` | One HTTP request | ❌ **Not implemented** |
| Agent reasoning step | One LLM intent (tool call) | ❌ **Not implemented** |

The bottom two layers are absent, which leaves a class of duplicate-payment
scenarios uncovered:

1. **Transient-failure retry**: client times out, retries; both calls succeed
   → one intent, two payments.
2. **LLM regeneration**: user clicks "Regenerate" in the UI; the same tool call
   fires twice → two payments for one intended action.
3. **Pause-resume**: a conversation pauses and resumes; the agent re-decides
   that the data needs to be fetched again.
4. **Multi-agent fan-out**: two agents independently fetch the same data
   without coordination.
5. **Network duplicate**: client auto-retries on transient failure; the server
   already settled the prior attempt.

**Consequence.** Duplicate payments are real money. On Polygon mainnet with
JPYC, a duplicate is a duplicate transfer of JPY — not a security hole in the
classical CIA sense, but a **correctness** failure that erodes trust in the
SDK at the integration boundary.

**Mitigation path (M5).** A reasoning-step idempotency layer is captured as a
candidate for the M5 milestone (see `.claude/m5-features-candidates.md`,
Candidate 1). The proposed direction follows Stripe's `Idempotency-Key`
header model extended to the x402 wire format:

1. The agent derives a deterministic idempotency key per reasoning step
   (e.g. `${conversationId}:${toolCallId}`).
2. The key propagates through the SDK to the HTTP header.
3. The facilitator deduplicates against a TTL store (24h default).
4. Optionally, the EIP-3009 nonce is itself derived from the idempotency key
   so the on-chain contract becomes the last line of defence.

External feedback that surfaced this gap (Twitter, 2026-05-26) suggested an
extension proposal to the upstream x402 spec; that pathway is open and being
evaluated alongside the in-SDK implementation.

**Operator mitigation today.** Until M5 lands:

- Implement idempotency keys at the agent framework layer (Mastra tool wrappers,
  LangChain callbacks, Vercel AI SDK middleware).
- Cap `wrapFetch`'s budget guard tightly so duplicate payments hit a hard ceiling.
- Treat duplicate payment as a known-quantity refund scenario in the
  business logic, not as a fatal incident.

### 6.2. Session-envelope encryption

**Gap.** `KawasekitSessionEnvelope` is plain JSON. Whoever can read the JSON
learns the policy summary and the validator address (both also derivable
on-chain, so this is not new information once the validator is installed).

**Consequence.** Low. The PK is the credential; the envelope is metadata.

**Mitigation path (M5).** JWE-wrapped envelopes (`envelope.jwe`) tracked in
`m5-features-candidates.md` if envelopes start carrying operator-private
information beyond what's on-chain.

### 6.3. Soft revoke (nonce-key invalidation) for session keys

**Gap.** Revoke is a single sudo UserOp; a session-key UserOp issued before
that UserOp lands can still mine. See threat 3.4.

**Consequence.** Bounded by the policy daily limit. Worst case is one
extra cycle of policy-limited transfers between revoke broadcast and
inclusion (typically a few seconds on Polygon).

**Mitigation path (M5).** Pre-invalidate the session key's nonce key in the
same revoke UserOp so any pending session-key UserOp fails simulation.

### 6.4. No on-chain budget telemetry

**Gap.** kawasekit ships no contract-level escrow or budget oracle. The
daily-limit policy enforces transaction count and per-transfer amount, not a
cumulative JPYC value cap.

**Consequence.** A session key bound to `maxPerTransfer = 10 JPYC` × `maxTransfersPerDay = 100`
can move 1000 JPYC/day. Operators wanting a true cumulative cap need to
combine the policy with off-chain tracking, or build a custom policy
contract.

**Mitigation path.** Custom policy contract (M5+). The composition of
existing policies covers the M3/M4 use cases.

---

## 7. Reporting

Please follow the vulnerability disclosure process in [`SECURITY.md`](../SECURITY.md):

- Do not open a public GitHub issue.
- Email `security@k0yote.dev`.
- Acknowledgement within 72 hours.

The author will credit reporters in the release notes for `kawasekit@0.1.0`
and later, unless the reporter prefers anonymity.

---

## Appendix A — Revision history

| Date | Author | Change |
|---|---|---|
| 2026-05-27 | k0yote | Initial draft (M4-3.1 — M4-3.6). Pending external review. |
