# RFC M5-1 — Reasoning-step Idempotency Layer

| | |
|---|---|
| **RFC** | M5-1 |
| **Title** | Reasoning-step idempotency for x402 / JPYC micropayments |
| **Status** | Draft v2 — revised per `web3-cto-review` pass 1 (findings C1/H1/H2/H3 + M1-3/L1-2 applied); awaiting X-commenter co-author input + user review before Phase B |
| **Author** | k0yote |
| **Reviewers (invited)** | `web3-cto-review` skill (mandatory pass); X commenter `@…` (RFC co-author, Round-1/Round-2 fundamental input) |
| **Milestone** | M5-1 (Must / headline) |
| **Closes** | `docs/THREAT_MODEL.md` §6.1 **gap** (ships the affordance + on-chain backstop). Moves threat 1.8b / 5.5 `🟡 → ⚠️ (with SDK affordance)` — parallel to 1.14; adds a new `✅` row (1.8c) for the SDK-enforced single-process win. **Does NOT claim a bare `✅` on 1.8b** (see §6.1, finding C1 of the review). |
| **Co-blocker for** | `0.1.0` GA fund-correctness gate (with M5-2 `maxAmountPerSign`) |
| **Created** | 2026-05-30 |

> This RFC fixes the design of the reasoning-step idempotency layer **before**
> implementation, per the M5 kickoff (`.claude/m5-kickoff.md` §4 "M5-1 詳細").
> It resolves the nine Open Questions recorded in
> `.claude/m5-features-candidates.md` Candidate 1, and the privacy open question
> recorded in `THREAT_MODEL.md` §6.1. Every file:line citation below was
> verified against the working tree at the time of writing.

---

## 1. Summary (TL;DR)

The x402 wire format guarantees idempotency **only at the level of a single
signed authorization** (the EIP-3009 32-byte nonce) and a single blockchain tx
(viem `nonceManager`). It does **not** prevent *one agent reasoning step* from
producing *two payments* — via retry, "Regenerate", pause-resume, or
multi-agent fan-out. This is `THREAT_MODEL.md` §6.1, the named fund-correctness
gap that — together with M5-2 `maxAmountPerSign` — gates `0.1.0` GA.

This RFC proposes a **layered** fix built on one structural insight: the SDK
*never sees the LLM intent*. The reasoning-step intent (tool id + args) is only
observable at the agent harness's `tool.execute` boundary
(`examples/agent-x402-jpyc/agent/index.ts:98-101`); by the time data reaches
`wrapFetch` / the server / the facilitator, only wire-format
`paymentRequirements` and the EIP-3009 authorization remain. Therefore kawasekit
cannot be a key *generator* — it must be a key **normalizer / derivation
authority** (the Round-2 position), and the harness must feed it a deterministic
identity.

The fix decomposes into **two independent halves**, deployed as **three
defense-in-depth layers**:

- **Half A — server-enforced at-most-once (zero-config, default-on).** A
  dedup store in `createX402Handler`, keyed on the EIP-3009 nonce already
  present in every payload, closes the verify→settle TOCTOU window and
  **replays the cached `200` response** for an identical re-sent request,
  instead of today's behaviour (a second settle attempt that returns a `402`
  "nonce already used"). Covers scenarios **1, 3, 5** (transient retry,
  pause-resume, network duplicate) with **no client cooperation**.

- **Half B — client-opt-in derived nonce (cross-process backstop).** When the
  harness supplies a deterministic idempotency key, the client *derives* the
  EIP-3009 nonce from it (instead of `crypto.getRandomValues`), so a re-signed
  same-intent payment produces the **same** bytes32 nonce. The token contract's
  `authorizationState[from][nonce]` then rejects the second settlement
  **on-chain**, even across independent servers / replicas that share no store.
  Covers scenarios **2, 4** (regenerate, multi-agent fan-out).

- **Layer 3 — shared store (Redis/SQL adapter, optional).** Upgrades Half A's
  *response replay* from single-process to cross-replica.

The wire carrier is the **standard `Idempotency-Key` HTTP header** (IETF
draft, Stripe-compatible), and the **server deduplicates on that header when
present** (falling back to the EIP-3009 nonce otherwise) — so the header is the
*logical* reasoning-step key and the derived nonce is its independent *on-chain*
backstop (finding H1). The **derived EIP-3009 nonce needs no shared secret** —
it is `keccak256(domain-tag ‖ conversationId ‖ stepId ‖ scope)`, so
fund-correctness across replicas depends only on a shared `conversationId`
(inherent to one agent run), **not** on distributing a secret (finding H2). The
optional HMAC client secret is used **only** for the wire header (unforgeability
+ no cross-client correlation); omitting it falls back to a plain identity hash
whose forgery is bounded because a cached response is released only after
re-verification. A parallel **x402 spec extension proposal** (engagement track,
does not gate M5) would formalize the header + derived-nonce binding at protocol
level.

`normalizeIntentText()` deliberately uses **deterministic Unicode
normalization, NOT semantic/embedding hashing** — idempotency requires
*exact logical-request identity*, and a semantic match would either skip a
legitimate payment (false collision) or double-charge (false miss).

---

## 2. Problem statement

### 2.1 The four-layer model (verified)

`THREAT_MODEL.md` §6.1 (lines 445-519) states the gap. Note: the prose at
line 447 says "three levels" but the table at lines 450-455 lists **four** rows
— a documentation bug this RFC's closure must fix.

| Layer | Unit | Status today | This RFC |
|---|---|---|---|
| EIP-3009 nonce | one signed authorization | ✅ 32-byte random, replay-safe at the token contract (`src/tokens/eip3009.ts:114-118`) | reused as the on-chain backstop (Half B) |
| `viem.nonceManager` | one blockchain tx | ✅ mandatory at `createSelfFacilitator` construction (`src/x402/facilitator.ts:330-334`) | unchanged |
| HTTP `Idempotency-Key` | one HTTP request | ❌ not implemented | **Half A** (header + server store) |
| Agent reasoning step | one LLM intent (tool call) | ❌ not implemented | **Half B** (harness key builder + derived nonce) |

### 2.2 The five uncovered scenarios (verified, §6.1 lines 460-469)

| # | Scenario | Same signed payload re-sent? | Covered by |
|---|---|---|---|
| 1 | Transient-failure retry | **yes** (client re-sends identical `PAYMENT-SIGNATURE`) | **Half A** |
| 2 | LLM "Regenerate" | no (re-signed → fresh random nonce today) | **Half B** |
| 3 | Pause-resume | usually yes (cached payload) / sometimes re-signed | Half A (+ B) |
| 4 | Multi-agent fan-out | no (independent signatures) | **Half B** |
| 5 | Network duplicate (server already settled) | **yes** | **Half A** |

The decisive observation: scenarios 1/3/5 re-send the *same bytes*, so a
**server-side store keyed on the EIP-3009 nonce already in the payload** stops
them with zero client cooperation. Scenarios 2/4 produce *different* signatures
for the *same intent*, so only a **client-side deterministic nonce** can make
them collide. The two halves are genuinely independent and must both ship.

### 2.3 Why the existing on-chain nonce check is not enough (verified)

`verifyCore` reads `authorizationState(from, nonce)` and fails a reused nonce
(`src/x402/facilitator.ts:541-550`). But this is insufficient as a
reasoning-step layer for three reasons established by the codebase map:

1. **TOCTOU.** The check is at verify time; `settleCore` re-verifies
   (`facilitator.ts:569`) then broadcasts (`facilitator.ts:593-608`). Two
   concurrent settles for the same payload can both pass re-verify before
   either lands → both broadcast (the second reverts on-chain, wasting gas).
2. **No response replay.** A duplicate returns a `402` "authorization nonce
   already used", **not** the original `200` body. The integrator sees an error
   where they expected the cached result.
3. **Re-signing defeats it entirely.** A fresh random nonce
   (`src/x402/client.ts:362`) is a brand-new authorization; `authorizationState`
   has never seen it, so it settles — a second real JPYC transfer.

### 2.4 Consequence (verified, §6.1 lines 471-474)

> "Duplicate payments are real money … not a security hole in the classical CIA
> sense, but a **correctness** failure that erodes trust in the SDK at the
> integration boundary."

---

## 3. Design constraints (from the codebase, non-negotiable)

These are derived from the understand-phase source map and `CLAUDE.md`; the
design must satisfy all of them.

1. **The SDK cannot see the LLM intent.** Confirmed: intent (tool id + args) is
   visible only at the harness `tool.execute` boundary
   (`examples/agent-x402-jpyc/agent/index.ts:98-101`); `wrapFetch`, the server,
   and the facilitator see only wire data. ⇒ intent normalization and step
   numbering **must live in a harness adapter**, never in `src/x402`. kawasekit
   is the *normalizer*, the harness is the *source*.
2. **`wrapFetch` is the single client integration seam**
   (`examples/agent-x402-jpyc/README.md:216-218`). A harness-agnostic key must
   flow through `wrapFetch`, not Mastra-specific code.
3. **No funds custody, minimal ambient state** (`CLAUDE.md` architectural
   constraints). A dedup record is *metadata, not funds*, but the store must be
   **injected**, never a module-global singleton (mirrors the `hooks` / `Facilitator`
   injection pattern, `facilitator.ts:258/337`).
4. **Backward-compatible / additive.** The public x402 surface is about to be
   frozen for npm. New fields must be **optional**; the wire stays byte-compatible
   (the nonce is already opaque bytes32; `extensions` is already optional). The
   `withIdempotency(facilitator)` decorator and optional params are the
   non-breaking insertion points.
5. **`✅` requires SDK code + tests, not JSDoc** (`THREAT_MODEL.md` §0 citation
   discipline, lines 57-68; precedent: threat 2.2 was demoted ✅→⚠️ for being
   JSDoc-only). A bare `✅` is therefore claimable only for the SDK-enforced,
   no-cooperation win (new threat 1.8c — Half A, with a colocated adversarial
   test); the harness-dependent half stays `⚠️` (with affordance), per §6.1 / C1.
6. **Conventions** (verified): named exports only; one barrel per subsystem +
   root `src/index.ts`; `create<Noun>` factories; `<Verb><Noun>Params` /
   `<Verb><Noun>Result`; error classes `extends Error` with `this.name` +
   readonly fields + `{cause}`; string `kawasekitVersion` + dedicated
   `…VersionError`; public bigint/Address type + private `…Json` wire shape with
   decimal-string bigints + `assert*` validators; optional external-dep adapters
   in a subdir as optional peer deps; no `console.log` in `src/`; never log
   nonces/secrets; `getAddress()` for address comparison; decimal strings for
   amounts; tsup `entry` + `package.json#exports` triple per subpath.

---

## 4. Architecture

### 4.1 Module layout

```
src/idempotency/
├── key.ts        # normalizeIntentText, canonicalRequestIdentity,
│                 #   deriveIdempotencyKey (HMAC), createIdempotencyKeyBuilder
├── store.ts      # IdempotencyStore interface, IdempotencyRecord,
│                 #   IdempotencyLookupResult, createInMemoryIdempotencyStore
├── record.ts     # serializeIdempotencyRecord / parseIdempotencyRecord
│                 #   (envelope-style, KAWASEKIT_IDEMPOTENCY_RECORD_VERSION)
├── errors.ts     # IdempotencyConfigError, IdempotencyRecordParseError,
│                 #   IdempotencyRecordVersionError
├── redis/index.ts# createRedisIdempotencyStore (optional peer dep; M5-stretch/M6)
└── index.ts      # barrel

src/tokens/eip3009.ts   # + deriveAuthorizationNonce(input, scope)  (sibling of
                        #   generateAuthorizationNonce:114)
```

Wire-up (all additive, all optional fields):

| File | Change |
|---|---|
| `src/x402/encoding.ts` | `export const X402_HEADER_IDEMPOTENCY_KEY = "Idempotency-Key" as const` (alongside `X402_HEADER_PAYMENT_SIGNATURE:57`) |
| `src/x402/client.ts` | `SignX402PaymentParams.idempotencyKey?: string` → derive nonce at `:362` |
| `src/x402/fetch.ts` | `WrapFetchParams.idempotencyKeyFor?: (input, chosen, paymentRequired) => string \| undefined` → set header + forward into `signer.sign` |
| `src/x402/server.ts` | `CreateX402HandlerParams.idempotency?: IdempotencyServerConfig` → dedup gate before settle (`:288`), record after settle (`:319-325`) |

### 4.2 Three layers, defense-in-depth

```
                   re-sent identical payload        re-signed same intent
                   (scenarios 1, 3, 5)              (scenarios 2, 4)
                         │                                  │
  Layer 1 (Half A)   server in-memory store ───► replay cached 200      ─ (miss: fresh nonce)
  default-on         keyed on EIP-3009 nonce       + close TOCTOU
                         │                                  │
  Layer 2 (Half B)   derived EIP-3009 nonce ──────────────► same nonce ──► on-chain
  client opt-in      (HMAC over identity)                   authorizationState rejects
                         │                                  │
  Layer 3 (opt)      shared Redis/SQL store ───► cross-replica response replay
```

- **Layer 1** is fund-correct *and* response-correct for re-sent payloads,
  single process, zero config.
- **Layer 2** is fund-correct for re-signed payloads, across *any* number of
  uncoordinated servers/replicas, because enforcement is the token contract.
- **Layer 3** makes response replay correct across replicas; **fund**-correctness
  for re-signed payloads never depends on it (Layer 2 already guarantees it
  on-chain). This is why a cold/missing external store is **not** a double-spend
  risk — it only degrades response-replay convenience.

This separation is the crux: **the SDK's fund-correctness guarantee does not
rest on an out-of-scope component** (Redis), satisfying §0 citation discipline —
it rests on SDK code (the derived nonce) + the token contract (cited).

### 4.3 Half A — server store (`createX402Handler`)

Insert between verify-success (`server.ts:286`) and settle (`server.ts:288`):

1. Compute the **server dedup key** (finding H1):
   - **if the client sent an `Idempotency-Key` header → use it** (this is the
     *logical* reasoning-step key; it deduplicates re-signed-same-intent even
     for signers that cannot accept a derived nonce, e.g. hardware/KMS);
   - **else fall back to the EIP-3009 nonce** in the payload (covers identical
     re-sends only).
   In both cases namespace by `(network, payTo, asset)` → **cross-tenant
   isolation** (one merchant's keys can never collide with another's). *Impl
   note (L2): `server.ts` does not currently narrow the payload — Phase B must
   export/extract `narrowExactEvmPayload` (`facilitator.ts:97-126`) to read the
   nonce, or rely on the header path, which needs no narrowing.*
2. **The lookup runs *after* `verify` (`server.ts:286`), never before** — so a
   cached response is released only against a re-presented, re-verified
   authorization. The `Idempotency-Key` header is therefore **not** a standalone
   bearer token (finding M2 / T-I8).
3. `await store.begin(key)` acquires a **lease** and returns one of (finding H3):
   - `{ status: "fresh", lease }` → proceed to settle; on success,
     `store.complete(key, record, lease)` where `record` holds
     `{ txHash, payer, amount, network, responseSnapshot, expiresAt }`.
   - `{ status: "completed", record }` → **replay**: rebuild the `200` from
     `record.responseSnapshot` + re-attach `PAYMENT-RESPONSE` from
     `record.txHash`. **Skip settle and skip the inner handler.**
   - `{ status: "in_flight" }` → a concurrent identical request holds an
     unexpired lease → single-flight: await its completion (bounded) or return a
     `payment_in_progress` result (configurable). This closes the TOCTOU.
4. **Lease crash-recovery (H3).** The `in_flight` lease has a TTL bounded by the
   facilitator `receiptTimeoutMs` (default 60 s, `facilitator.ts:296`) + the
   confirmations window. A `begin` that finds an **expired** lease treats it as
   `fresh` — the prior holder is presumed dead (crash, OOM, deploy, or an
   inner-handler throw: note `server.ts:318` "errors propagate — settlement has
   already happened"). This is safe because the on-chain nonce backstop still
   prevents a double *spend* if the dead holder did broadcast. Without the lease
   a crashed process would strand the key `in_flight` forever = permanent denial
   of a legitimate retry. Lease acquisition is atomic CAS; long settles renew it;
   `abandon` (settle failed) is idempotent.
5. `store.complete` is reached only after `facilitator.settle` returns success,
   which **already waits for `confirmations`** internally
   (`facilitator.ts:616-621`) — so a reorged settlement (threat 2.8 / §6.6) is
   never cached as "done".

The store is **default-on** (`createInMemoryIdempotencyStore()` when
`idempotency` is omitted) — `idempotency: { store: "none" }` is an explicit
opt-out. Default-on is the §1.8a-style "unsafe default forbidden" posture applied
to the server. **But default-on is single-process (finding M1):** the in-memory
store is a **bounded LRU** (size cap + `validBefore`-anchored TTL eviction — an
unbounded `Map` would be a memory-exhaustion DoS, T-I9) and emits a **one-time
`warn`** (internal logger, never `console`) that it does not dedup across
replicas. **Multi-replica deployments REQUIRE a shared store (Layer 3) or the
derived nonce (Layer 2)** for the guarantee — documented in the recipe and
surfaced via an `idempotency` telemetry event (`hit`/`miss`/`replay`).

> **Response snapshotting (finding M3).** `Response` bodies are single-use. The
> store records a *snapshot* whose headers are an **allowlist**
> (`Content-Type`, `Content-Length`, the x402 `PAYMENT-RESPONSE`; hop-by-hop,
> `Set-Cookie`, and any auth headers are stripped) plus the body bytes, so a
> replay is byte-identical and never leaks a prior request's credentials.
> Snapshots are size-capped (default 64 KiB); over-cap responses record metadata
> only. **All** replays (not only the degraded over-cap path) carry an
> `Idempotency-Replayed: true` marker. Idempotent replay is correct **only for
> resources whose representation is a pure function of the paid request**; the
> inner handler must have no non-settlement side effects on the replay path.

### 4.4 Half B — derived nonce (`src/tokens/eip3009.ts` + signer)

New sibling of `generateAuthorizationNonce` (`eip3009.ts:114`):

New sibling of `generateAuthorizationNonce` (`eip3009.ts:114`). **No shared
secret** (finding H2): the nonce is a domain-separated `keccak256` of the
idempotency key + scope, so determinism across replicas/devices needs only a
shared `conversationId` (inherent to one agent run), not a distributed secret.

```ts
/**
 * Derives a deterministic EIP-3009 nonce from an idempotency key, scoped to
 * (from, verifyingContract, chainId) so the same key never collides across
 * tokens or chains. No secret: nonce = keccak256(DOMAIN_TAG ‖ key ‖ from ‖
 * verifyingContract ‖ chainId). A replayed key ⇒ identical bytes32 ⇒ the token
 * contract's authorizationState rejects the 2nd settle — fund-correctness with
 * zero secret distribution. (The wire Idempotency-Key header, §4.5, MAY add an
 * HMAC secret for unforgeability; the on-chain nonce does not need it.)
 *
 * Replaces crypto.getRandomValues ONLY when the caller supplies a key.
 */
export function deriveAuthorizationNonce(
  input: { readonly idempotencyKey: string },
  scope: { readonly from: Address; readonly verifyingContract: Address; readonly chainId: number },
): Hex
```

At `client.ts:362`:

```ts
const nonce =
  signParams.idempotencyKey !== undefined
    ? deriveAuthorizationNonce(
        { idempotencyKey: signParams.idempotencyKey },
        { from: account.address, verifyingContract: pinnedDomain.verifyingContract, chainId },
      )
    : generateAuthorizationNonce();
```

For a *fully byte-identical* re-sign (so the cached `PAYMENT-SIGNATURE` matches),
`validBefore` must also be pinned. `SignX402PaymentParams` already exposes
`validAfter?` / `validBefore?` (`client.ts:142-148`); the key builder pins
`validBefore` deterministically (e.g. bucketed to the authorization lifetime).
With pinned `validBefore` + derived nonce + RFC-6979 deterministic ECDSA (viem
`privateKeyToAccount`), the entire `X402ExactEvmPayload` is reproducible —
client-side idempotency, not only on-chain.

> **Cross-chain (threat 1.1 / Kaia).** `chainId` is in the nonce preimage, so the
> same JPYC address on Polygon / Avalanche / Kaia / Ethereum yields *distinct*
> nonces. A derived nonce never weakens the chain-aware uniqueness the contract's
> domain separator relies on. This constraint binds the moment Kaia (M5-3) lands.
>
> **Front-running (finding L1, threat 1.10).** A derived (more predictable) nonce
> does **not** worsen the front-running griefing surface of `transferWithAuthorization`
> (`facilitator.ts:596`): a griefer still needs the *signature*, not just the
> nonce, to broadcast — and a broadcast still pays the merchant `to`. The 1.10
> surface (a captured signature racing the legitimate facilitator) is unchanged.

### 4.5 The key authority (`src/idempotency/key.ts`)

```ts
/** Deterministic, NON-semantic normalization. NFC + trim + collapse internal
 *  whitespace. NOT lowercased (case can be meaning-bearing). */
export function normalizeIntentText(intent: string): string

/** The authoritative logical-request identity. The harness supplies these. */
export interface CanonicalRequestIdentity {
  readonly conversationId: string;   // stable per agent run / session
  readonly stepId: string;           // harness-assigned; monotonic per conversation
  readonly intent?: string;          // optional human-meaningful label (normalized)
  readonly namespace?: string;       // sub-agent / orchestrator partition
}

/** Wire key. With a clientSecret: HMAC-SHA-256(secret, version ‖ canonical(identity))
 *  — unforgeable + no cross-client correlation. Without: keccak256(version ‖
 *  canonical(identity)) — forgery bounded because a cached response is released
 *  only post-verify (T-I8). The clientSecret is OPTIONAL (finding H2): the
 *  on-chain fund backstop (derived nonce, §4.4) never depends on it. */
export function deriveIdempotencyKey(
  identity: CanonicalRequestIdentity,
  clientSecret?: Hex,
): string

/** Hands out keys + monotonic stepIds for one conversation. The harness adapter
 *  calls .next(intent) per tool execution. See §4.6 for clientSecret sourcing. */
export function createIdempotencyKeyBuilder(params: {
  readonly conversationId: string;
  readonly clientSecret?: Hex;
  readonly namespace?: string;
}): { next(intent?: string): string }
```

The SDK is the **derivation authority** (deterministic HMAC), not a
*semantic-equivalence judge*. It does not decide whether two intents "mean the
same thing" — the harness decides identity via `(conversationId, stepId)`;
`intent` is an optional label folded into the preimage to make collisions
human-debuggable.

### 4.6 Key material & the shared-secret invariant (finding H2)

The original draft folded a per-client `clientSecret` into *both* the wire key
and the derived nonce — which silently made fund-correctness depend on
distributing that secret to every signer of one logical payer (diverging secrets
→ different nonces → double payment). The review (H2) flagged this as the primary
operational hazard. Resolution: **move the secret off the fund path.**

- **Load-bearing invariant is now a shared `conversationId`, not a shared
  secret.** The derived nonce (§4.4) is `keccak256(…conversationId…)` with no
  secret, so two replicas/sub-agents acting for the same agent run derive the
  **same** nonce as long as they share the `conversationId` — which is inherent
  to one run and trivially propagated, unlike a secret. Diverging `conversationId`
  (or undisciplined `stepId` numbering across uncoordinated orchestrators, Q4) is
  the remaining double-payment hazard (T-I1) and is documented as such.
- **The HMAC `clientSecret` is optional and off the fund path.** It hardens
  *only* the wire `Idempotency-Key` header (unforgeability + no cross-client
  correlation, §7). If two signers hold *different* secrets, wire-key dedup
  simply **misses and falls back to nonce dedup** (which still works) — it does
  **not** cause a double payment. So secret divergence degrades response-replay,
  never fund-correctness.
- **Sourcing.** When used, the secret comes through the same URI-scheme provider
  seam as the payment key (`examples/agent-x402-jpyc/lib/pk-provider.ts` —
  `env://` demo / `kms://` production) but is a **separate, independently
  rotatable credential** (checklist §5 credential separation: the LLM key, the
  payment key, and the idempotency secret rotate independently).
- **Rotation.** The secret is epoch-bucketed and the epoch is recorded in the
  idempotency record, so a rotation does not strand in-flight keys (old-epoch
  lookups still resolve until their `validBefore` TTL expires).

### 4.7 Harness adapters

The adapter computes the identity at the only place it is observable and threads
the key through `wrapFetch`:

```ts
// Mastra (examples/agent-x402-jpyc/agent/index.ts:98-101 boundary)
const keys = createIdempotencyKeyBuilder({ conversationId, clientSecret });
const fetch402 = wrapFetch({
  signer, onPayment,
  idempotencyKeyFor: () => currentKey,   // set per tool.execute
});
const tool = createTool({ /* … */ execute: async ({ city }) => {
  currentKey = keys.next(`fetch_weather:${city}`);
  return fetch402(url);
}});
```

M5 ships the generic builder in `src/idempotency` + a **worked Mastra example**.
OpenAI / LangChain / Vercel AI SDK adapters are documented patterns (same seam);
a dedicated subpath adapter (`src/x402/mastra/`, mirroring `src/x402/hono/`) is a
fast-follow if demand warrants — not an M5 gate.

**Legacy-harness fallback.** A harness that exposes only `tool_call_id` (no
durable conversationId) uses `identity = { conversationId: runId, stepId:
tool_call_id }`. Best-effort within one harness; the cross-harness guarantee
requires the orchestrator to supply a stable `conversationId`. Documented.

---

## 5. Resolved open questions

Candidate 1 (`m5-features-candidates.md`) + §6.1 left ten questions open. Each is
resolved here with rationale; web3-cto-review and the co-author are invited to
contest any of them.

| # | Open question | **Decision** | Rationale |
|---|---|---|---|
| Q1 | **TTL window** (24h? 7d?) | **Anchor to `validBefore`**, not a flat 24h. Record TTL = `validBefore + reorgMargin(confirmations)`. Default upper bound 24h for response-replay convenience only. | Fund-correctness is guaranteed *forever* by the on-chain nonce (Layer 2), so the store TTL governs only response replay. After `validBefore` the authorization is dead (`facilitator.ts:490-496`); no replay window can reopen. Short TTL is safe. |
| Q2 | **Storage abstraction** | `IdempotencyStore` interface; `createInMemoryIdempotencyStore()` default in core; Redis/SQL adapters as optional peer-dep subpaths (mirror `src/observability/prometheus`). | Exactly the existing DI + optional-adapter precedent. Durable backends are operator territory (the `pk-provider.ts` "SDK ships demo, you ship production" pattern). |
| Q3 | **intent_text normalization algorithm** | **Deterministic Unicode (NFC + trim + whitespace-collapse). Explicitly REJECT embedding/semantic hashing.** | Idempotency needs *exact logical-request identity*. A semantic hash causes **false collisions** (two different intents → one key → a legitimate payment silently skipped, merchant under-paid) and **false misses** (same intent reworded → double charge). For money, determinism beats cleverness. Also: semantic embedding is non-reproducible across model versions. |
| Q4 | **step_idx / stepId numbering** | Harness-owned monotonic counter scoped to `conversationId`; parallel sub-agents partition via `namespace`. SDK provides `createIdempotencyKeyBuilder`. | The SDK can't number steps it can't see. The builder makes the common single-harness case trivial; uncoordinated parallel orchestrators reusing `(conversationId, stepId)` for *different* intents is a documented hazard (T-I1). |
| Q5 | **Mandatory vs recommended** | **Layered.** Server store **default-on** (Half A, unsafe-default-forbidden, like §1.8a). Client derived-nonce + key builder **opt-in** (Half B — the SDK literally cannot derive a key without harness cooperation). Mandatory-by-type for the client key is a road-to-`1.0` consideration. | Closes §6.1 with real SDK enforcement for the no-cooperation scenarios *now*, while honestly scoping the part that requires the harness. |
| Q6 | **Backward-compat** | All additive optional fields + `withIdempotency(facilitator)` decorator + default-on in-memory store. Wire byte-compatible. | Public surface is freezing for npm; deprecated-alias pattern (`facilitator.ts:807-845`) is the escape hatch if anything renames. |
| Q7 | **Wire carrier (candidate Option A/B/C)** | **Reframe into two axes.** *Transport*: adopt the **standard `Idempotency-Key` header** (candidate Option B — IETF draft / Stripe), reject the kawasekit-custom header (Option A). *Cryptographic binding*: the **derived EIP-3009 nonce** (orthogonal to A/B/C — works under any carrier). Pursue the **x402 spec extension (Option C)** as a parallel engagement-track proposal. | The candidate conflated "where the string travels" with "what enforces it". Separating them clarifies that on-chain enforcement (the nonce) is independent of the header standard. |
| Q8 | **x402 spec extension** | Engagement track, **does not gate M5** (Coinbase response time unknown, per kickoff §3). Draft an issue/PR to `coinbase/x402` proposing the `Idempotency-Key` header + optional derived-nonce binding; kawasekit is first implementer. | The in-SDK implementation stands alone; the spec proposal amplifies it without blocking GA. |
| Q9 | **Legacy harness compat** | Best-effort fallback via `{ conversationId: runId, stepId: tool_call_id }`. Documented limitation, not silent. | Round-2's core point: `tool_call_id` works within one harness, breaks across. The fallback is honest about its boundary. |
| Q10 | **Privacy / linkability** (the §6.1 recorded open question) | **Hybrid.** Wire key = optional `HMAC(clientSecret, identity)` — opaque, no plaintext intent, no cross-client correlation (no-secret fallback = `keccak256(identity)`). Derived nonce = `keccak256(identity ‖ scope)` (no secret, finding H2): opaque to any *external* chain observer who does not know the app-internal `(conversationId, stepId)` preimage. Residual (irreducible): a server/facilitator can observe *that* a given client repeated reasoning-step N, never *what* it was. | Any idempotency scheme needs a stable per-(client,intent) token — that linkability is irreducible. Keeping the secret off the nonce (H2) trades a marginal on-chain-linkability increase (only to a party that already knows the conversation structure) for eliminating the secret-distribution double-payment hazard — the right trade for JPYC micropayments. See §7. |

---

## 6. Threat-model impact

### 6.1 Closing the §6.1 gap (finding C1 — corrected closure)

> **Correction (web3-cto-review C1).** The original draft proposed promoting
> threat 1.8b to a `✅` with a per-scenario ✅/⚠️ split. That violates the §0
> single-verdict vocabulary (`THREAT_MODEL.md:45-52`) and contradicts the
> document's own F1 precedent — threat 1.8 was *split into 1.8a/1.8b precisely so
> each ID carries one verdict* (`:224-225`). A mixed `✅`-but-`⚠️` verdict is the
> same error that demoted threat 2.2 (`:65-68`). Below is the honest closure.

The GA gate is "closure of the fund-correctness **gap**" (`:92-98`), not a bare
`✅` — exactly how 1.14 closes its gap by *shipping an affordance* while staying
`⚠️`. The §6.1 gap closes by shipping the affordance (key builder + derived
nonce + server store) **plus** the on-chain backstop. The verdicts then read:

- **Threat 1.8b** (re-signed same intent — scenarios 2/4): **`🟡 → ⚠️ Operator
  responsibility (with SDK affordance)`**, exactly parallel to 1.14. The SDK now
  ships the mechanism; preventing the duplicate requires the harness to wire the
  key builder (the SDK cannot do this — it cannot see intent, constraint §3.1).
  Cite the on-chain backstop (`facilitator.ts:541-550`) per citation discipline.
- **Threat 5.5** (reasoning-step duplicate payment): same trajectory `🟡 → ⚠️`.
- **New threat 1.8c** (re-sent identical request — scenarios 1/3/5): **`✅
  Mitigated`**, SDK-enforced. The default-on server store delivers at-most-once
  settle + response replay + verify→settle TOCTOU closure with **no harness
  cooperation**. Scope is bounded and stated: **single-process, or shared store
  (Layer 3)**; cite the new module + its colocated test. (Across replicas without
  a shared store this degrades to the pre-existing on-chain `402` rejection of
  threat 1.2 — not a regression, but not the `✅` win either; finding M1.)
- **§6.1 section**: rewrite to the §6.5/§6.6/§6.7 closure format — `**Status.**`
  + `**Historical record (pre-fix gap).**`, **fix the "three levels"→"four
  levels" prose bug** (`:447` vs `:450-455`), and cite the new module + tests.

Net: the §6.1 *gap* is closed (SDK ships every mechanism needed; a correct
integration prevents every scenario), satisfying the GA gate — **without** a
false `✅` on 1.8b.

### 6.2 New attack surface introduced by idempotency (must be in THREAT_MODEL)

A CTO reviewer will ask "what does caching open up?" These are designed-against:

| ID | Threat | Mitigation in this design |
|---|---|---|
| T-I1 | **Key collision → skipped payment** (grief / under-billing). Forged/guessed key pre-seeds the store so a real payment is treated as duplicate. | HMAC(clientSecret) ⇒ unforgeable. Records are written **only after a successful settle**, so a forged key is a *miss*, never a false *hit*. Cross-tenant namespacing by `(network, payTo, asset)`. |
| T-I2 | **Store poisoning → content without payment.** A "settled" record that never settled. | Write **after confirmations clear** only; record stores the real `txHash`; paranoid operators can re-check on-chain. Never fail-open into a cached `200` without a recorded txHash. |
| T-I3 | **TTL-expiry replay.** | Irrelevant to funds: the on-chain nonce is consumed permanently (Layer 2). TTL governs only response-replay convenience. |
| T-I4 | **Privacy linkability.** | §7. HMAC opacity; irreducible residual documented. |
| T-I5 | **Store as availability dependency.** External store down → fail-open (double-spend risk) vs fail-closed (deny). | In-memory default never "down". External-store failure policy configurable; **fund-correctness survives fail-open** because Layer 2 (derived nonce) still blocks double-spend on-chain. Default = fail-closed on response-replay. |
| T-I6 | **Cross-chain nonce reuse** (Kaia same address). | `chainId` in nonce preimage (§4.4). |
| T-I7 | **Derived-nonce predictability / on-chain linkability.** A deterministic (no-secret) nonce is computable by anyone who knows the `(conversationId, stepId, scope)` preimage. | Those inputs are app-internal, not on-chain — opaque to an *external* observer. A party that already knows the conversation structure (the merchant/facilitator) gains marginal linkability only; accepted trade for eliminating the secret-distribution hazard (H2, §7). Griefing unaffected (L1). |
| T-I8 | **Captured `Idempotency-Key` as a bearer token** for cached paid content (confidentiality). | The dedup lookup runs **after** `verify` (§4.3 step 2), so a cached response is released only against a re-presented, re-verified authorization. The key alone is not a credential. |
| T-I9 | **In-memory store memory-exhaustion DoS** (unbounded key retention). | Bounded LRU (size cap + `validBefore`-anchored TTL eviction), §4.3 / finding M1. |
| T-I10 | **Crash-stuck `in_flight` → permanent denial** of a legitimate retry. | `in_flight` lease with TTL (≤ `receiptTimeoutMs` + confirmations); expired lease → `fresh`; on-chain nonce backstops a double-spend if the dead holder broadcast (H3, §4.3 step 4). |
| T-I11 | **Signer clock skew × `validBefore`-anchored TTL** (threat 1.12, `:229`) silently extends the dedup window. | Record TTL **must never exceed `validBefore`**; clock skew is a deployment-health alarm per 1.12, cross-referenced here. |

---

## 7. Privacy / linkability (resolving §6.1's recorded open question)

§6.1 (lines 509-519) declined to settle intent-derived vs opaque-random vs
hybrid. Resolution:

- **The tension is real but bounded.** Deduplication *requires* a wire token that
  is stable for the same (client, intent). That is the minimum linkability any
  idempotency scheme must expose — it is not avoidable while still deduping.
- **The optional HMAC closes everything beyond the minimum on the wire.** With
  the wire key = `HMAC(clientSecret, identity)`:
  - the server **cannot read the intent** (no plaintext on the wire);
  - the server **cannot correlate across clients** (distinct secrets → unrelated
    key spaces);
  - the server **can** observe "client X repeated reasoning-step N" — which is
    exactly what dedup needs and nothing more.
  Without a secret, the wire key is `keccak256(identity)`: still no plaintext
  intent, but forgeable by a party that can guess the identity (bounded — a
  cached response is released only post-verify, T-I8).
- **Opt-out for maximum privacy.** A client that values unlinkability over
  cross-process dedup omits the key entirely → today's random-nonce behaviour →
  Half A (server store) still dedups *identical re-sends* with no extra leak.
- **On-chain (finding H2).** The derived nonce is `keccak256(identity ‖ scope)`
  with **no secret**, so the on-chain bytes32 is opaque to any *external* chain
  observer (who cannot know the app-internal `conversationId`/`stepId`). A party
  that already knows the conversation structure could correlate — a marginal,
  accepted increase over a random nonce, traded for eliminating the
  secret-distribution double-payment hazard (T-I7). A client needing on-chain
  unlinkability against even the merchant uses the random-nonce opt-out above.

This is a documented, defensible position, not a punt.

---

## 8. Implementation plan (Phase B → C)

### Phase B — core (no chain required; unit-testable)
1. `src/idempotency/key.ts`, `store.ts`, `record.ts`, `errors.ts`, `index.ts`.
2. `deriveAuthorizationNonce` in `src/tokens/eip3009.ts` + tests
   (determinism, scope separation, chainId separation).
3. `X402_HEADER_IDEMPOTENCY_KEY` in `encoding.ts`.
4. Wire-up: `SignX402PaymentParams.idempotencyKey?`,
   `WrapFetchParams.idempotencyKeyFor?`, `CreateX402HandlerParams.idempotency?`.
5. Root + subsystem barrels, `tsup.config.ts` entry, `package.json#exports`.

### Phase C — integration + the five-scenario test matrix

Built on existing harnesses (no real Amoy in CI): `vi.fn()` stub facilitator
(`server.test.ts:54-61`) + `withHttpListener` + `paywallHandler`
(`fetch.test.ts:48-76`) + local anvil/MockJPYC (`facilitator.self.test.ts`).

| §6.1 scenario | Test |
|---|---|
| 1 Transient retry | re-send identical `PAYMENT-SIGNATURE` → assert settle called **once**, second request replays the cached `200` |
| 2 Regenerate | re-sign with the same idempotency key → assert **identical bytes32 nonce** → second on-chain settle reverts via `authorizationState` (anvil) |
| 3 Pause-resume | cached payload re-sent after delay (within `validBefore`) → replay; after `validBefore` → fresh (and nonce backstop holds) |
| 4 Multi-agent fan-out | two signers, same `(conversationId, stepId)` (no shared secret needed, H2) → same derived nonce → at most one settles (anvil); **negative**: divergent `conversationId` → different nonces (documents the T-I1 hazard) |
| 5 Network duplicate | server already settled, client auto-retries → in-flight single-flight / completed-replay path |
| TOCTOU | two concurrent identical settles → `in_flight` single-flight → one broadcast |
| Cross-tenant | same key, different `payTo` → **no** false dedup |
| Privacy | wire key is HMAC (no plaintext intent); distinct secrets → distinct keys for identical intent |

Plus a standalone `scripts/14-x402-idempotency-demo.ts` (modeled on
`scripts/07`) demonstrating retry+regenerate dedup end-to-end on Amoy.

### Definition of Done (M5-1 slice of the kickoff DoD)
- §6.1 closed with the layered closure above; 1.8b/5.5 promoted.
- `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build` all exit 0
  (the pre-push 4-point gate).
- THREAT_MODEL §6.1 rewritten + T-I1…T-I7 added.

---

## 9. Out of scope (M5-1) / future

- **Redis/SQL store adapters** — interface ships in M5; the in-memory default
  satisfies the GA gate. Durable adapter is M5-stretch or M6.
- **Cumulative budget cap (Candidate 5)** — the `IdempotencyStore` abstraction is
  deliberately shaped so a future budget store can share it (both track
  cross-step state). Not built here.
- **x402 spec extension PR (Option C)** — engagement track.
- **Mandatory-by-type client key** — road-to-`1.0` (breaking change).

---

## 10. Questions for reviewers / co-author

*Resolved in this revision (pass-1 `web3-cto-review`): the default-on store →
single-process scope made explicit + bounded-LRU (M1); `clientSecret` moved off
the fund path, sourcing via the `pk-provider` seam (H2, §4.6); single-flight →
leased `in_flight` with crash-recovery (H3). The genuinely open ones remain:*

1. **x402 spec proposal shape** — header-only, or header + a normative
   derived-nonce binding? (The latter makes non-kawasekit facilitators enforce
   fund-correctness, but is a heavier ask of Coinbase.)
2. **No-secret nonce vs on-chain linkability (H2 trade)** — is the marginal
   on-chain linkability of a `keccak256(identity)` nonce (only to a party that
   already knows the conversation structure) acceptable for the target users, or
   do any users need the HMAC-secret nonce despite the distribution cost?
3. **Round-2 framing check (for the co-author)** — does the "normalizer authority,
   not propagator" position survive? The harness still *sources* identity
   (`conversationId` + monotonic `stepId`); kawasekit *normalizes + binds* it into
   the derived nonce. Is the harness-boundary concern fully addressed by
   `createIdempotencyKeyBuilder` + the legacy `tool_call_id` fallback — or does
   the cross-orchestrator `stepId` numbering hazard (Q4 / T-I1) need a stronger
   answer than "documented operator responsibility"?

### Engagement status (kickoff §7 — co-author invitation)

- The X commenter (Round-1/Round-2 fundamental input) is invited to co-author /
  review this RFC. Findings **H1** (header is the logical key vs the nonce
  backstop) and the **harness-boundary** treatment (§4.7 + legacy fallback) are
  the direct technical descendants of their Round-2 "harness boundary is the
  thinnest layer" point — Q3 above is addressed to them specifically.
- This RFC does **not** wait on their response to proceed to Phase B; their input
  is incorporated if/when it arrives (per kickoff: GA runs on an open channel).

---

## Appendix A — public API sketch (for review; not final)

```ts
// src/idempotency/store.ts
export interface IdempotencyRecord {
  readonly kawasekitVersion: KawasekitIdempotencyRecordVersion; // "1"
  readonly key: string;
  readonly txHash: Hex;
  readonly payer: Address;
  readonly amount: string;          // decimal-string, uint256-safe
  readonly network: X402Network;
  readonly responseSnapshot?: IdempotencyResponseSnapshot;
  readonly expiresAt: bigint;       // unix-seconds; serialized as decimal string
}

/** Fence token proving lease ownership; carries the lease expiry (H3). */
export interface IdempotencyLease { readonly token: string; readonly expiresAt: bigint }

export type IdempotencyLookupResult =
  | { readonly status: "fresh"; readonly lease: IdempotencyLease }   // leased; caller must complete/abandon
  | { readonly status: "in_flight" }                                 // another holder's lease is unexpired
  | { readonly status: "completed"; readonly record: IdempotencyRecord };

export interface IdempotencyStore {
  // Atomic CAS: leases a fresh slot, or returns in_flight/completed.
  // An EXPIRED in_flight lease is reclaimed as fresh (H3 crash-recovery).
  begin(key: string): Promise<IdempotencyLookupResult>;
  renew(key: string, lease: IdempotencyLease): Promise<IdempotencyLease>;   // long settles
  complete(key: string, record: IdempotencyRecord, lease: IdempotencyLease): Promise<void>;
  abandon(key: string, lease: IdempotencyLease): Promise<void>;   // settle failed → release for retry (idempotent)
}

export function createInMemoryIdempotencyStore(
  params?: CreateInMemoryIdempotencyStoreParams,
): IdempotencyStore;

// src/x402/server.ts (additive)
export interface IdempotencyServerConfig {
  readonly store?: IdempotencyStore | "none";
  readonly inFlight?: "await" | "reject";
  readonly maxSnapshotBytes?: number;
}
// CreateX402HandlerParams.idempotency?: IdempotencyServerConfig

// src/x402/client.ts (additive) — SignX402PaymentParams.idempotencyKey?: string
// src/x402/fetch.ts (additive)  — WrapFetchParams.idempotencyKeyFor?: (...) => string | undefined
```

## Appendix B — verified source anchors

| Claim | Anchor |
|---|---|
| 7-step handler; settle hook between verify-pass and settle | `src/x402/server.ts:284-301` |
| record after settle | `src/x402/server.ts:319-325` |
| EIP-3009 nonce chosen randomly | `src/x402/client.ts:362` |
| CSPRNG nonce, "unique per (authorizer, contract)" | `src/tokens/eip3009.ts:114-118` |
| `validBefore` from `Date.now()` | `src/x402/client.ts:354` → `eip3009.ts:133-136` |
| on-chain replay check (verify-time only) | `src/x402/facilitator.ts:541-550` |
| settle re-verifies then broadcasts (TOCTOU) | `src/x402/facilitator.ts:569,593-608` |
| confirmations wait (mainnet=4/testnet=1) | `src/x402/facilitator.ts:301-302,616-621` |
| nonceManager mandatory at construction | `src/x402/facilitator.ts:330-334` |
| payload narrowing helper | `src/x402/facilitator.ts:97-126` |
| `onPayment` required at type level (1.8a precedent) | `src/x402/fetch.ts:84-87` |
| `extensions` optional, unsigned | `src/x402/types.ts:206` |
| header constants | `src/x402/encoding.ts:57` |
| intent visible only at harness boundary | `examples/agent-x402-jpyc/agent/index.ts:98-101` |
| wrapFetch is the single client seam | `examples/agent-x402-jpyc/README.md:216-218` |
| §6.1 gap + "three levels" prose bug | `docs/THREAT_MODEL.md:445-519` |
| §0 citation discipline (✅ needs code+cite) | `docs/THREAT_MODEL.md:57-68` |
| §6 closure format precedent | `docs/THREAT_MODEL.md` §6.5/§6.6/§6.7 |
