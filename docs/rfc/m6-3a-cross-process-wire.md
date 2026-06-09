# RFC M6-3a — Cross-Process Co-Sign Wire (the agent↔owner network boundary)

| | |
|---|---|
| **RFC** | M6-3a |
| **Title** | The cross-process / cross-runtime co-sign wire — agent-WASM-in-Node ↔ owner-Rust backend over an authenticated, (m)TLS network channel |
| **Status** | Draft v3 — **design-first**; **Slice 1 (cross-runtime wire) + C1 (durable store) implemented** in `kawasekit-mpc-2p`. An external CTO review (2026-06-08, source-verified) found one Critical **C1**: the in-memory ledger + idempotency stores made the "at most one cap-commit per (session, nonce)" invariant **false across a restart / sibling instance** (my web3-cto-review **H3** §4.6 claim under-counted the risk — the nonce store was as ephemeral as the freshness set it contrasted). **C1 remediated** (durable, transactional, single-instance **SQLite** store; restart-replay + cap-persistence + TTL conformance tests; §4.6 / constraint 7 / §4.8 / §6 corrected; roadmap §6 adds it as a third engagement-readiness precondition). The review's other findings are **now applied (RFC text)**: M1 §5/W12 in-policy-drain row + constraint-2 cap backstop; M2 §4.6 response-direction-not-E2E-authenticated bullet; M3 §4.8 host-clock-skew budget + W11; L1 §4.9 per-call-isolation property [verified safe] + §6/test 10 (+ a native concurrency test in mpc-2p); L2 §4.8 transport-deps supply-chain; L3 §4.7 async-cancellation + §6/test 5; L4 §4.9 transfer-vs-receive + griefing. L1′ retracted. **All external-review findings (C1 + M1/M2/M3 + L1/L2/L3/L4) closed.** A `web3-cto-review` **re-run** then confirmed those closed and found 4 issues in the *new* C1 store code (an adversarial self-pass) — **also remediated**: **H1** (`confirm` ignored rows-affected → a reclaimed-mid-ceremony reservation under-counted the cap → over-spend) now errors + the TTL-≫-ceremony rule is stated (constraint 7 / §4.8); **M-rev-1** (confirm+complete non-atomic → stuck retry) now ONE transaction (`AtomicCommit::commit_signed`); **M-rev-2** (O(n)-per-reserve scan) now an O(1) `tally.spent` counter + a small live-pending scan; **L-rev-1** (`static_reason` coupling) guarded by a round-trip test. **(prior:)** `web3-cto-review` **pass 1 done; all findings closed** — Sprint 1 (H1 cross-target serialization claim → "verified by test, not by construction"; H2 nonce-reuse-on-retry adapter invariant + call-vs-intent idempotency scope; H3 A3-freshness reframed, fund-safety on nonce-idempotency+SpendState) + Sprint 2 (M1 ceremony-liveness minimum-window invariant + W11; M2 additive `nonce_reuse_conflict` reason / `intent_digest_mismatch` unreachable-by-A4; M3 agent-side `MAX_FRAME_BYTES` bound; M4 mTLS default-for-remote; M5 conditional H1-closure wording) + Sprint 3 (L1 threat-5.2 anchor; L2 exit-path + monitoring cross-ref). The crypto, the backend gate, and the in-Rust transport are **already proven** (M6-1 spike + `kawasekit-mpc-2p` slices 1–11, self-audited); **the un-built piece is the wire across the Node(WASM)↔Rust process/runtime/network boundary** + the SDK adapter that drives it. This RFC specifies that wire and makes it the threat-model protagonist. |
| **Author** | k0yote |
| **Reviewers (invited)** | `web3-cto-review` skill (mandatory pass — the wire's new attacker model is this RFC's burden) |
| **Milestone** | M6-3a (the next real technical milestone; roadmap §5) — turns the proven backend + the proven seam into a working end-to-end co-sign over a real wire, the first artifact a paying engagement integrates. |
| **Satisfies the contract in** | RFC M6-0 `docs/rfc/policy-gated-signer.md` §4.6 / §4.8 / §4.9 (the `PolicyGatedSigner<"cryptographic">` adapter) and realizes RFC M6-1 `docs/rfc/mpc-2p-cosigner.md` §4.7 (A2 transport — "the largest un-built piece") across the **real** process boundary. |
| **Closes** | the **agent-bypass class** *at runtime* (the RFC-line "H1" shorthand, carried from M6-1; in `docs/THREAT_MODEL.md` this is **threat 5.2** "Budget guard bypassed by direct signer access" — whose verdict already says "agent-bypass closes only with a **cryptographic** adapter (`mpc-2p`)" — with **threat 1.14** the amount-inflation sibling). M6-0 shipped only the *affordance* (the type-gate); M6-1 proved the crypto *in-process*; M6-3a is the first time the agent and owner run as **separate processes over a network**, with a shipped SDK adapter the type-gate accepts — so a bounded x402 flow can no longer be served by an advisory signer. Until this wire ships, the class stays ⚠️/open ("affordance, not closure"). |
| **Crypto foundation** | `0xCarbon/dkls23-secp256k1` (DKLs23 / OT / no-Paillier / wasm32) — **UNAUDITED → audit-before-value** (the standing gate; §8). M6-3a is **testnet-only**; the audit and B5 share-recovery are **out of scope** (§9). |
| **Source of spec** | `.claude/m6-3a-kickoff.md`; roadmap `.claude/m6-roadmap.md` §5/§6; the proven baseline in `kawasekit-mpc-2p` (private) + the M6-1 RFC §4.7/§7. |
| **Created** | 2026-06-08 |

> **What is genuinely new here.** Everything below the wire is proven: the DKLs 2-of-2
> crypto runs in WASM and native (M6-1 Stage 0c), the distributed DKG is non-custodial
> (Stage 2), the backend gate (A3 verify → A4 re-derive → policy → atomic SpendState →
> contribute share) is built and self-audited (`kawasekit-mpc-2p`), and the authenticated
> `transport::Channel` runs over **TCP-loopback between two Rust endpoints** (mpc-2p slices
> 4–5). **The one untrod path is the wire across the Node(WASM)↔Rust boundary on a real
> network** — where a network adversary can now observe, replay, reorder, or MITM the
> exchange that until now lived inside one process or one language. This RFC's center of
> gravity is therefore **the wire**: session-binding/replay across the network (§5/§4.5),
> A3 request-auth under an *adversarial* network (§4.6), retry × idempotency when a
> request/response is lost *mid-ceremony* (§4.7), and TLS/mTLS for the owner-host
> deployment (§4.8). §7 is the honest proven-vs-un-built ledger.

---

## 1. Summary (TL;DR)

**M6-3a is the wire that makes the diagram real.** The agent (Node) holds **one** DKLs23
2-of-2 share in WASM; the owner backend (Rust, self-hosted) holds the **other** share + the
`SpendingPolicy` + the authoritative `SpendState`. To produce a single EIP-3009
authorization, the two run the multi-round DKLs sign ceremony **across a real network** —
but only *after* the owner backend has authenticated the request (A3), re-derived the
EIP-712 digest from the decoded intent (A4), re-evaluated the policy, and atomically
committed the cumulative cap. The agent never holds the owner's share; the owner never
holds the agent's; **neither can sign alone**, so the policy is a guarantee, not a request.

This RFC specifies that wire as a layered channel:

- A **TS-interpreted control envelope** (versioned) carrying ceremony lifecycle, the
  decoded `PaymentIntent`, the A3 authenticator, and typed rejections.
- An **opaque crypto payload** carrying the DKLs round messages — produced and consumed
  **only** by the same crypto-core crate compiled two ways (wasm32 for the agent, native
  for the backend), so the agent's TS is a *dumb pipe* for those bytes. This **removes the
  schema-redeclaration drift class** for the crypto messages (there is no JS re-encoding of
  the DKLs schema), concentrating the cross-language surface onto the small, corpus-covered
  envelope. Byte-identity across the **wasm32↔native** target pair is highly likely (bincode
  + serde normalize length/`usize` widths) but is **verified by §6 test 1, not assumed** —
  the proven mpc-2p round-trip was native↔native, which would not catch a wasm32-only
  divergence (§4.2/H1).
- **TLS (wss) + optional mTLS** for transport confidentiality + endpoint authentication,
  composed with — not replaced by — the end-to-end A3 authenticator.

And the SDK adapter that drives it: **`createMpc2pPolicyGatedSigner(...) →
PolicyGatedSigner<"cryptographic">`** (the M6-0 §4.6 contract name). Wiring it into the
bounded x402 flow makes `requireNonBypassable` accept it and an advisory `local` signer a
**compile error** — and, crucially, the adapter **never silently degrades to a local
signature** when the wire is down (it throws a typed transient error). That no-fallback
property is what turns the M6-0 affordance into **H1 closed at runtime** — *conditionally*
(M5): closure holds **for the bounded flow that routes through the type-gate** (an integrator
who keeps calling `createX402PaymentSigner({ account })` is unaffected) and **only while the
agent host holds a single share with no alternate signing path**. It is a per-deployment
property the SDK enables, not a global one it can impose; M6-1's "until wired into a bounded
flow, H1 stays open" framing carries forward.

**What M6-3a does NOT do (separate gates, §9):** it does not add B5 share backup/recovery
(the *other* engagement-readiness precondition — a lost share still permanently locks
funds), and it does not clear the **audit** (the mainnet/real-value gate). M6-3a is
testnet-only; the UNAUDITED DKLs premise stands.

---

## 2. Problem statement — why the wire, and why now

### 2.1 The three boundaries, and which one is left

H1 (the agent can bypass owner policy because it holds a unilateral key) is closed only by
splitting the key 2-of-2 and putting one share behind the policy (M6-1 §2.1). Getting there
crossed three boundaries, proven in order:

1. **The crypto boundary** — does a genuine 2-of-2 DKLs sign exist, with the agent share in
   WASM? **Proven** (M6-1 Stage 0c/2: native + wasm32 sign, distributed DKG, kill-one).
2. **The gate boundary** — does the owner backend authorize the *request* (A3) and re-derive
   the *digest* (A4) and *policy* before contributing its share, atomically? **Proven +
   self-audited** (`kawasekit-mpc-2p`: `service.rs` `CoSignBackend.cosign`, atomic
   `SpendState`, audit, revocation, idempotency, settle persistence).
3. **The wire boundary** — do the agent (Node/WASM) and owner (Rust) run as **separate
   processes on a real network**, exchanging the ceremony over an authenticated, encrypted
   channel? **Un-built.** Today both shares meet either in one process (M6-1 Stage 2) or
   across **TCP-loopback between two Rust endpoints** (mpc-2p slices 4–5). The agent has
   never been a *real separate Node host* talking to a *real separate Rust backend* over a
   network.

M6-3a is boundary 3. It is the last structural unknown between "proven legs" and "a
deployable co-signer a client integrates."

### 2.2 Why the wire changes the attacker model

Inside one process (or one language over loopback) the message exchange has no adversary on
the path. On a real network it does:

- A **passive eavesdropper** sees the intent (who pays whom, how much) and the protocol
  messages.
- An **active MITM** can drop, reorder, replay, or attempt to **impersonate the backend**
  (a fake owner endpoint harvesting the agent's ceremony) or **impersonate the agent**
  (soliciting a co-sign).
- A **request or response can be lost mid-ceremony** — a partition during the rounds, not a
  clean abort — re-opening the retry × idempotency interaction that the in-process abort
  path never stressed.

The mpc-2p backend already has an authenticated channel (A3 HMAC) and idempotency-by-nonce
— but both were exercised in-process / over loopback, where the threat model is benign. The
RFC's job is to re-state those mechanisms **under an adversarial network** and add the
transport layer (TLS/mTLS) and the wire-level conformance tests they now need.

### 2.3 Why now

The roadmap (§5) makes M6-3a the **next real technical milestone**: the SDK adapter + the
cross-process wire are what a build-for-client engagement actually integrates, and the
DKG-on-client-infra delivery (where k0yote never holds a share) provisions the A3 key /
mTLS certs during that ceremony. M6-3a + B5 together are the **engagement-readiness gate**
(roadmap §6); the audit is the separate mainnet gate. Building the wire now, testnet-only,
is the correct posture — it de-risks the integration surface before any real value, and
before the audit spend.

---

## 3. Design constraints (non-negotiable)

Inherited from the M6-0 contract, the M6-1 RFC, the proven backend, and `CLAUDE.md`.

1. **Satisfy the M6-0 §4.6 `mpc-2p` contract verbatim** — the adapter returns
   `PolicyGatedSigner<"cryptographic">`; the *gate logic stays on the backend* (A3 verify,
   A4 re-derive, policy re-eval, atomic `SpendState`, idempotency, revoke). M6-3a wires the
   transport to that gate; it does **not** move any authorization decision onto the agent.
2. **The agent is untrusted; the wire does not change that.** The backend trusts nothing the
   agent says or sends; it re-derives the digest and re-evaluates the policy itself (M6-0
   S1; M6-1 constraint 7). The control envelope is *input to be validated*, never trusted. An
   *authenticated* but compromised/prompt-injected agent is therefore bounded **not** by
   authentication but by the **atomic cumulative `SpendState` cap** (the load-bearing backstop
   for in-policy drain, §5/W12); prompt-injection defence is layered (policy caps + a tight
   per-deployment cap + agent-framework guardrails).
3. **No silent advisory fallback.** When the co-signer is unreachable, the adapter returns a
   typed **transient/internal error** — it MUST NEVER produce an `{ok:true}` signature by
   any local path. A policy *denial* (`{ok:false, rejection}`) is distinct from a transport
   *failure*; conflating them would re-open H1. (§4.4, §5/W8.)
4. **Crypto messages are opaque to TS.** Only the same crypto-core crate (wasm32 + native)
   serializes/deserializes DKLs round messages. The TS layer carries them as opaque bytes;
   it never re-encodes the DKLs schema in JS. This **removes the schema-redeclaration drift
   class** (M6-1 §4.7/M3); cross-target *byte-identity* (wasm32↔native) is then **verified by
   §6 test 1**, not assumed. (§4.2.)
5. **A4 binds to the SDK's exported EIP-712 single source of truth.** The backend re-derives
   the digest from the decoded intent + the trusted `(token, chainId) → (name, version)`
   domain registry, and that derivation is held byte-identical to the SDK's exported
   `transferWithAuthorizationTypes` (`src/tokens/eip3009.ts:87`) +
   `resolvedAssetToEip3009Domain` (`src/tokens/asset-domain.ts:148`) by the shared B8
   digest-conformance corpus (`src/tokens/__fixtures__/eip3009-digest.vectors.json`). The
   wire does not re-declare types. (§4.5.)
6. **Authenticated + encrypted, three distinct layers.** TLS authenticates the *channel* and
   encrypts the bytes; A3 authenticates the *request to this share+policy session*; the
   DKLs **ssid** binds each *protocol message* to its ceremony. Three layers, three threats
   (fake server / forged requester / replayed protocol message); none subsumes another.
   (§4.6, §4.8.)
7. **At most one cap-commit per (session, nonce) — under arbitrary wire loss AND across a
   restart / sibling instance.** The atomic `SpendState` (H3) + idempotency-by-nonce (B7) must
   compose so that any number of mid-ceremony drops and retries collapse to a single committed
   spend. **(C1) This requires the `{nonce, SpendState}` store to be durable, transactional, and
   single-writer (one instance) — or shared-transactional with a unique `(session, nonce)`
   constraint for HA — with a reservation TTL so a crashed mid-ceremony reservation does not leak
   budget.** Two coupled rules the store MUST hold (re-review): **the success-path commit
   finalizes the reservation AND caches the outcome in ONE transaction** (so a confirm can't land
   without the cache, or vice-versa); and **a confirm of a vanished reservation is an error, never
   a silent success** — which means **the reservation TTL MUST exceed the worst-case ceremony
   budget** (§4.8), so a reclaim sweep never deletes an in-flight reservation and under-counts the
   cap. An in-memory, per-process store satisfies the invariant only within one continuous run (a
   restart re-admits a replayed nonce as fresh and re-commits the cap; N instances ⇒ N× the cap).
   M6-3a exercises this over a lossy wire **and** across a restart (§4.7, §4.8, §6).
8. **SDK stays TypeScript; backend stays a self-hostable Rust binary.** The SDK talks to the
   adapter through the M6-0 `PolicyGatedSigner` interface (mechanism-independent). M6-3a adds
   one new export (`createMpc2pPolicyGatedSigner`) — additive, a `0.2.x`/minor, never a
   breaking change to the GA line (roadmap §8).
9. **Testnet-only; UNAUDITED premise documented.** No mainnet, no real value. The wire does
   not reduce the value-at-risk gate — it sits *above* the crypto, which is still UNAUDITED
   (T1/T2 unchanged; §8).

---

## 4. Architecture

### 4.1 Topology — two processes, two runtimes, one wire

```
┌──────────────────── Agent host (Node) ─────────────────────┐        ┌────────────── Owner host (Rust, self-hosted) ──────────────┐
│  kawasekit SDK (TS)                                         │        │  kawasekit-mpc-2p backend (private, proven)                 │
│   └─ createMpc2pPolicyGatedSigner(...) :                    │        │   └─ CoSignBackend.cosign:                                  │
│        PolicyGatedSigner<"cryptographic">                   │        │        A3 verify → A4 re-derive digest →                    │
│         ├─ builds CoSignRequest envelope from PaymentIntent │        │        policy re-eval → atomic SpendState commit →          │
│         ├─ A3 authenticator over canonical intent + ssid    │ ══════ │        run_sign_over_channel (owner share)                  │
│         └─ drives the WASM share (ONE share) through        │  wss   │   ├─ owner DKLs share + SpendingPolicy + SpendState ledger  │
│            run_sign_over_channel (agent endpoint)           │ (m)TLS │   ├─ audit log + RevocationRegistry + idempotency(by nonce) │
│   crypto-core (wasm32)  ── opaque DKLs round bytes ──┐      │        │   └─ crypto-core (native) ── SAME crate, opaque bytes ──┘   │
└──────────────────────────────────────────────────────┼─────┘        └────────────────────────────────────────────────────────────┘
                                                        └── identical (de)serialization ── never re-encoded in TS ──┘
                        funds live in the agent 2-of-2 EOA; neither host holds funds; neither share signs alone
```

The crypto-core crate is compiled **two ways** (wasm32 for the agent, native for the
backend) so both ends run bit-identical DKLs23 — the only way a genuine 2-of-2 works (M6-1
§2.3/§4.1). The wire carries (a) a small TS-interpreted **control envelope** and (b)
**opaque crypto payloads** the TS never interprets (§4.2).

### 4.2 The two-layer wire — control envelope vs. opaque crypto payload

The single most load-bearing design decision: **split the wire so the only cross-language
content is a small, versioned envelope, and the DKLs messages stay opaque to TS.**

**Control envelope (TS-interpreted, versioned, JSON or CBOR):**

```jsonc
// CoSignFrame v1 — illustrative shape; the normative schema is pinned + versioned (§6)
{
  "wireVersion": 1,                 // explicit; mismatch → handshake reject (W7)
  "ceremonyId": "…",                // routes rounds; distinct from the DKLs ssid
  "kind": "request" | "round" | "result" | "rejection" | "error",
  // kind=request only:
  "intent": { token, chainId, from, to, value, validAfter, validBefore, nonce },  // decoded PaymentIntent (NEVER a digest)
  "ssid": "…",                      // session id bound into the DKLs transcript
  "auth": "…",                      // A3 authenticator over (wireVersion‖ceremonyId‖ssid‖canonical(intent)‖freshness)
  // kind=round only:
  "round": 1,                       // DKLs phase index
  "payload": "<opaque bytes>",      // DKLs message — produced/consumed ONLY by crypto-core (wasm32/native)
  // kind=rejection only:
  "rejection": { "reason": "…", "detail": "…" }   // the M6-0 PolicyRejection union
}
```

- The **`intent`** is the decoded `PaymentIntent` (`src/signer/types.ts:57`), **never a
  digest** (A4). The backend re-derives the digest from it (§4.5).
- The **`payload`** is an opaque DKLs round message. The agent's TS moves it between the
  WASM module and the wire **without interpreting it**; the WASM (same crate as native)
  serializes/deserializes it. **There is no JS re-declaration of the DKLs message schema**,
  so the M6-1 §4.7/M3 cross-language-serialization risk is reduced to the small `CoSignFrame`
  envelope, which is pinned, versioned, and in the B8 corpus (§6/W7). **Note (H1): the
  same-crate design removes the *schema-redeclaration* drift class, but it does not by itself
  guarantee byte-identity across the wasm32↔native target pair** — that depends on identical
  bincode config (fixint vs varint), serde/bincode normalizing `usize`/length widths (the
  bincode default normalizes lengths to `u64`, so it likely holds, but it is a property of
  the *config*, not of "same crate"), no platform-dependent fields, and matched crate
  version + features. The proven mpc-2p TCP round-trip was **native↔native** (same `usize`
  width), so it would not have caught a wasm32-only divergence. Byte-identity is therefore
  **verified by §6 test 1** (run on the wasm32↔native pair), not claimed by construction.
- **Agent-side inbound frame bound (M3).** The backend already bounds inbound frames
  (`MAX_FRAME_BYTES`, mpc-2p Sprint-2 M2). The agent applies the **same bound** on every
  inbound `round`/opaque-`payload` frame **before allocation/deserialization**, symmetric to
  the backend — so a fake/MITM backend (W2) cannot OOM the Node agent with an over-large
  payload. An over-bound frame aborts the ceremony with a typed transport/abort error (no
  silent retry into the same peer).
- Encoding: the envelope is CBOR (compact, canonical) or JSON; the `payload` is a raw byte
  field (CBOR bytestring) or base64 (JSON). The choice is an open question (§10 Q6); the
  *property* that matters — opaque crypto bytes, versioned envelope — holds either way.

### 4.3 Ceremony flow — authorize first, then sign

The owner backend authorizes the **structured request** before it engages any DKLs round —
so the rounds are pure crypto that only ever run on an already-authorized intent:

1. **Agent → owner: `request`.** The adapter builds a fresh `ceremonyId` + `ssid`, the
   `CoSignRequest` from the `PaymentIntent`, and the A3 `auth` authenticator (§4.6). Sends
   it over the authenticated (m)TLS wss channel.
2. **Owner gate (no rounds yet).** `CoSignBackend.cosign`:
   (a) **A3 verify** the authenticator → fail ⇒ `unauthenticated`, no rounds;
   (b) check **revocation** → revoked ⇒ `revoked`, no rounds;
   (c) **A4 re-derive** the EIP-712 digest from `intent` + the trusted domain registry →
   token absent ⇒ `token_not_allowed`; (the request carries no digest to disagree with —
   blind signing is impossible by construction);
   (d) **idempotency-by-nonce**: if this `nonce` was already committed with the *same*
   intent → return the cached terminal result (safe-retry, §4.7); with *different* fields →
   the B7 anomaly `nonce_reuse_conflict`, deny + audit (M2 — see §4.4 on the typed reason);
   (e) **policy re-eval** (Rust port, B8-conformant) → on deny return the typed rejection,
   **no rounds, no share**;
   (f) **atomic SpendState check-and-commit** of the cumulative cap (H3) — past this point
   the spend is committed exactly once for this (session, nonce).
3. **Rounds.** Only on full pass does the backend enter `run_sign_over_channel` (owner
   endpoint) against the agent's `run_sign_over_channel` (agent endpoint, WASM share). They
   exchange `round` frames carrying opaque DKLs payloads until phase 4
   (`normalize = true` → low-S `(r, s, recovery_id)`).
4. **Owner → agent: `result`** (the owner's contribution completes the joint signature) **or
   `rejection`** (if a check at step 2 failed).
5. **Agent assembles + self-checks.** The adapter assembles `(r, s, v)` (`v = recovery_id +
   27`), and as defense-in-depth **locally verifies `ecrecover == from`** and **low-S**
   before returning `{ok:true, signature, intent}`. A failed self-check ⇒ typed internal
   error (never an `{ok:true}` with a bad signature).

The authorization decision is on the **structured request**, never on raw protocol bytes —
which is exactly why A4 (no blind signing) survives the move to a wire.

### 4.4 The SDK adapter — `createMpc2pPolicyGatedSigner`

The new public export (sketch; final API in Appendix A). It satisfies the M6-0 §4.6 /
§4.9 contract:

```ts
// kawasekit/signer — additive; the M6-0 contract name (§4.6). The roadmap's loose
// "createCryptographic…" phrasing maps to this.
export interface Mpc2pSignerParams {
  /** The owner backend wss endpoint (e.g. "wss://cosigner.example.com"). */
  readonly endpoint: string;
  /** A3 material: pre-shared key and/or mTLS client identity (the §4.6 carrier). */
  readonly auth: CoSignAuth;
  /** TLS trust: pinned CA / server cert, optional mTLS client cert (§4.8). */
  readonly tls: CoSignTls;
  /** The agent's ONE DKLs share handle (encrypted-at-rest store; provisioned at DKG). */
  readonly agentShare: AgentShareHandle;
  /** Construction-time pinned EIP-712 asset domain (the A4 source of truth, §4.5). */
  readonly asset: X402AssetParam;       // src/tokens/asset-domain.ts
  /** The group 2-of-2 EOA; every intent.from must equal this. */
  readonly from: Address;
}

export function createMpc2pPolicyGatedSigner(
  p: Mpc2pSignerParams,
): PolicyGatedSigner<"cryptographic">;
```

`sign(intent)` runs §4.3 and maps the outcome onto `SignResult`
(`src/signer/types.ts:105`):

- backend `result` ⇒ `{ ok: true, signature, intent }` (after the local `ecrecover`/low-S
  self-check);
- backend `rejection` ⇒ `{ ok: false, rejection }` with the backend's typed reason
  (`revoked` / `expired` / `token_not_allowed` / `recipient_not_allowed` /
  `amount_exceeds_*` / `unauthenticated` / `nonce_reuse_conflict`);
  - **Rejection-reason note (M2).** `nonce_reuse_conflict` is the one **additive** change
    M6-3a makes to the M6-0 `PolicyRejection` union (`src/signer/types.ts:86`) — the typed
    surface for the B7 same-nonce/different-fields anomaly (§4.3 step 2(d)), which the union
    did not previously name. It is additive (a `0.2.x` minor, §3 constraint 8) and is the
    **sole M6-0-seam delta** M6-3a requires. Conversely, **`intent_digest_mismatch` is
    unreachable in M6-3a by construction**: the wire carries the decoded intent and never a
    digest (A4, §4.2), so there is nothing for the re-derived digest to disagree with — the
    reason stays in the union for the seam but is **not** a live mapped outcome here.
- **transport / availability failure** (endpoint unreachable, TLS failure, ceremony timeout,
  self-check failure) ⇒ a **thrown typed `CoSignUnavailableError`** (internal-error channel,
  per M6-0 "throws are reserved for internal/config errors"). **It is never an `{ok:true}`
  and never a `rejection`** — a rejection means "the owner decided no" (audit-meaningful);
  an unavailable wire means "the owner did not decide." This separation is the no-silent-
  fallback property (constraint 3; §5/W8). The adapter exposes no local-signing path at all.

Because the return type is `PolicyGatedSigner<"cryptographic">`, `requireNonBypassable`
(`src/signer/gate.ts:28`) accepts it and rejects `local` (advisory) at compile time. Wiring
this into `createX402PaymentSigner`'s `signer` path (M6-0 §4.7) makes a bounded x402 flow
**non-bypassable on an EOA** — **H1 closes at runtime, conditionally** (M5): the closure holds
**only** (a) for call sites routed through the type-gate (`requireNonBypassable`) — an
integrator using the raw `account` path is unaffected — and (b) when the **agent host holds a
single share with no alternate signing path** (no stray whole key, no advisory signer reused
in the bounded flow). The SDK *enables* closure per-deployment; it cannot impose it globally
(front-matter; THREAT_MODEL.md; M6-1's "until wired … H1 stays open").

### 4.5 (A4) Digest ↔ intent binding over the wire — binds to the SDK's exported SoT

The wire carries the **decoded intent**, never a digest (§4.2). The backend re-derives the
EIP-712 `TransferWithAuthorization` digest from `intent` + a trusted, pinned `(token,
chainId) → (name, version)` domain registry — the backend analog of the SDK's
`resolveAssetParam` → `resolvedAssetToEip3009Domain` (`src/tokens/asset-domain.ts:86,148`).
M6-2 slice 1 already made the SDK side the **single source of truth**
(`transferWithAuthorizationTypes`, `src/tokens/eip3009.ts:87`) and froze a shared
**digest-conformance corpus** (`src/tokens/__fixtures__/eip3009-digest.vectors.json`,
asserted SDK-side by `eip3009-digest.conformance.test.ts`) that the Rust backend consumes
cross-language. **The wire's A4 derivation binds to THIS corpus** — the M6-3a CI runs the
*same* corpus against the *backend reached over the wire* (§6/test 8), so any Rust-side
EIP-712 re-encoding drift is caught against the SDK's **exported** types, not a
re-declaration. "The bytes the policy gates on == the bytes `ecrecover` verifies" stays
*enforced*, now across the process boundary.

### 4.6 (A3) Request authentication under an *adversarial* network

A3 answers "who is asking," bound to a specific key-share + policy session — and on a real
network it must hold against an active adversary. The mpc-2p backend's A3 authenticator (an
HMAC over the canonical request) is proven in-process / over loopback; M6-3a re-states it
for the wire:

- **Authenticator.** `auth = HMAC_k(wireVersion ‖ ceremonyId ‖ ssid ‖ canonical(intent) ‖
  freshness)`, where `k` is the per-deployment pre-shared key provisioned at the DKG
  ceremony (on the client's infra for build-for-client; k0yote never holds it), and
  `freshness` is a timestamp + a per-request nonce **distinct from the EIP-3009 nonce**. The
  HMAC binds the request to *this* share+policy session, *this* ceremony, and *this* exact
  intent (so a captured request cannot have its `to`/`value` altered without breaking it).
- **Where fund-safety-under-replay actually rests (H3 + C1).** It rests on **idempotency-by-nonce
  + atomic SpendState** (§4.7) **persisted in a durable, transactional store** — **not** on the
  freshness element. A replayed `request` carrying the same EIP-3009 nonce collapses to the
  idempotent committed result; the HMAC prevents tampering with the amount/recipient. The
  `freshness` element is therefore a **best-effort DoS/dedup + ceremony-start guard**, *not* a
  fund boundary (it is bounded by a clock-skew acceptance window). **Critical (C1): the nonce
  store + SpendState themselves must be durable, transactional, and single-writer (one instance)
  — or shared-transactional with a unique `(session, nonce)` constraint for HA — for the
  replay-after-restart / sibling-instance bound to hold.** An in-memory, per-process store is
  empty after a restart, so a replayed nonce is re-admitted as `Fresh` and the cap re-committed
  (and N instances ⇒ N× the cap); that is exactly as ephemeral as the freshness set. v1 ships a
  durable single-instance store (SQLite); §3 constraint 7 states the invariant, §4.8 the
  deployment topology, and §6 the restart-replay conformance test.
- **Canonical intent bytes.** `canonical(intent)` uses the **same pinned encoding** as the
  B8 corpus (decimal-string `uint256`, EIP-55 addresses, fixed field order;
  `src/tokens/__fixtures__`), so the agent and backend HMAC the same bytes — no
  encoding-drift forgery gap.
- **A3 ≠ TLS.** The A3 authenticator is **end-to-end agent↔backend**, independent of TLS. If
  TLS terminates at a load balancer / reverse proxy in front of the backend (a realistic
  owner-host deployment), A3 still authenticates the request to the backend itself; TLS
  authenticates only the channel up to the proxy. (§4.8.)
- **auth ≠ authz.** A valid authenticator never substitutes for the policy evaluation — an
  authenticated caller still passes the full §4.3 gate. Failure ⇒ `unauthenticated`, no
  rounds. (M6-0 §4.9; M6-1 §4.8.)
- **Response-direction integrity (M2).** A3 authenticates the **agent→backend** request
  end-to-end; the **backend→agent** frames (`round`/`result`/`rejection`) have **no
  application-layer authenticator** — their integrity rests on **TLS**. Under a TLS-terminating
  proxy this leaves the proxy↔backend hop unauthenticated for responses, but it is **contained
  to DoS, never forgery**: a tampered `round` trips the DKLs ssid/transcript integrity (abort), a
  tampered `result` is caught by the agent's **`ecrecover == from` + low-S self-check** (§4.3
  step 5), and a tampered `rejection` is a self-inflicted DoS. An integrator who cannot trust the
  proxy↔backend segment should **terminate TLS at the backend** (§4.8). The asymmetry (request
  A3-authenticated, response crypto-self-verified) is deliberate, not an oversight.

### 4.7 Retry × idempotency when the wire drops *mid-ceremony*

The genuinely-new failure mode: a request or response lost **during the rounds**, not on a
clean abort. The invariant (constraint 7): **at most one cap-commit per (session, nonce),
under arbitrary loss + retry.** How the proven mechanisms compose over the wire:

- **Loss before step 2(f) commit** — agent retries; the backend sees no committed spend for
  this nonce; a fresh ceremony runs; exactly one commit. Safe.
- **Loss after commit, before the agent gets the `result`** — the cap is already committed.
  The agent retries with the **same EIP-3009 nonce** (deterministic via M5
  `deriveAuthorizationNonce`, or the caller re-presents the same intent). The backend's
  **idempotency-by-nonce** store recognizes the committed nonce + matching intent and
  returns the **cached terminal result** (the signature, if persisted; otherwise a safe
  terminal state) **without re-committing the cap** (step 2(d)). One commit, idempotent
  result. Safe.
- **Same nonce, different intent fields** (a tampered/confused retry) ⇒ deny + audit (B7;
  §4.3 step 2(d)). Never a second commit.

**Restart, not resume (recommended v1).** A dropped ceremony is **abandoned**, not resumed
mid-round. Resuming a half-finished DKLs ceremony would require persisting partial-round
state — a bigger attack surface and a worse failure mode — for little benefit, since DKLs
sign rounds are cheap and idempotency-by-nonce already collapses a restart on a committed
nonce to the cached result. So: **on any mid-ceremony loss, abandon and restart; the
nonce-idempotency + atomic SpendState are the safety net.** Mid-ceremony resumption is an
explicit non-goal for v1 (§10 Q2). The backend's `ban → permanent-revoke` (DKLs self-audit
H2, already shipped) still applies: an *identifiable-abort/ban* condition is terminal (no
retry), distinct from a transient transport loss (retry-safe) — the adapter must classify
the two and only retry the transient class.

**Async cancellation safety (L3).** Restart-not-resume covers the *protocol* state; the wss
ceremony handler is new **async** code on the hostile-network boundary, so it must also be
**cancellation-safe at the task level**: a connection dropped mid-round must cancel the
ceremony task cleanly — no leaked task, no half-committed `SpendState` (the RAII reservation +
the atomic confirm guarantee this), and no resource growth under repeated drops. A
fault-injection assertion (§6/test 5) checks that repeated mid-ceremony drops do not grow the
backend's task count or memory.

**Adapter invariant — retry reuses the identical intent (H2).** The whole retry-safety
argument rests on a behaviour the adapter MUST enforce: **on the transient-transport retry
path, the adapter re-presents the *byte-identical* prior `PaymentIntent`, nonce included — it
MUST NOT regenerate the nonce.** Regenerating the nonce on retry defeats idempotency-by-nonce
(each attempt becomes a *new* authorized payment) and leaves the cumulative cap as the **only**
backstop — i.e. up to `cap/value` duplicate settlements before the cap stops them. The adapter
therefore caches the in-flight intent and replays it verbatim; it retries **only** the
transient transport class (never a delivered `rejection`, never a `ban`/identifiable-abort).

**Call-level vs intent-level idempotency — scope (H2).** M6-3a enforces **call/nonce-level**
idempotency only (one signed authorization ⇒ one settlement, via the deterministic EIP-3009
nonce + the backend's nonce store). It does **not** provide **intent-level / reasoning-step**
idempotency — "the same agent *intent*, retried/regenerated/resumed, must not pay twice,"
especially across a Mastra→OpenAI→custom-agent **harness boundary** (the thinnest layer of the
guarantee). That layer is **M5's concern** (`deriveAuthorizationNonce`, `src/tokens/eip3009.ts`;
`docs/rfc/m5-1-reasoning-step-idempotency.md`) and is **out of M6-3a scope** — named here so
the wire does not silently conflate call-level with intent-level safety.

M6-3a's deliverable here is **fault injection over the wire** (§6/test 5): kill the
response/connection at each step and assert the invariant holds — the first time this is
exercised on a real lossy channel rather than a clean in-process abort.

### 4.8 (A2/transport) TLS / mTLS for the owner-host deployment

The owner self-hosts the backend, so transport security is part of the deliverable:

- **Floor: wss with server TLS + CA/cert pinning.** The agent pins the owner backend's
  CA/cert, giving **confidentiality** (the intent and DKLs payloads are not in cleartext —
  W1) and **server authentication** (the agent knows it reached the real owner backend, not
  a harvesting impostor — W2). Plain `ws://` is rejected by the adapter.
- **mTLS — default for remote endpoints (M4).** A client certificate lets the backend
  authenticate the agent *host* at the transport layer too — a second, transport-level lock
  complementing the application-level A3 authenticator. Consistent with the SDK's
  fail-safe-by-default ethos (the asset whitelist is default-on with a loud `unsafeOverride`,
  `src/tokens/asset-domain.ts`; `local` requires `acknowledgeAdvisory: true`), **mTLS is the
  default for any non-loopback `endpoint`** — server-TLS-only is permitted **only** for
  loopback/dev and requires a loud, greppable opt-out (Appendix A `CoSignTls`), never the
  silent path of least resistance. The HMAC A3 remains the floor that also survives
  TLS-terminating proxies.
- **Provisioning.** The A3 pre-shared key and the (m)TLS material are provisioned during the
  **DKG ceremony on the client's infrastructure** (build-for-client delivery; roadmap §7).
  k0yote never holds a share *nor* the A3 key. The provisioning ceremony's own threat
  surface is flagged for M6-3b/M6-4 (§10 Q5) — M6-3a assumes keys are already in place.
- **Transport dependencies + supply chain (L2).** The new SDK-side transport stack (the wss /
  WebSocket client, the TLS stack, and the CBOR codec if chosen, §10 Q6) is **exact-pinned**,
  covered by the repo's `minimumReleaseAge` hold + the postinstall-script allowlist (`CLAUDE.md`
  Supply Chain Policy), and reviewed as **security-relevant** — the wss/TLS client in particular
  (it is the hostile-network boundary). The backend already bounds inbound frames via
  `MAX_FRAME_BYTES` (mpc-2p self-audit M2). Verify against `package.json` when the deps land.
- **Why three layers, not one.** TLS server-auth (fake-server) ≠ A3 request-auth
  (forged-requester) ≠ DKLs ssid binding (replayed-protocol-message). A MITM who somehow
  breaks one layer still faces the others; and even a perfect MITM cannot produce a valid
  signature (it lacks the owner share) — the worst case degrades to DoS or an
  audit-gated attempt to extract share information (T1/T2, unchanged, §8).
- **Durable-store topology (C1).** The owner backend persists the `{nonce, SpendState}` store so
  the at-most-one-cap-commit invariant survives a restart (§3 constraint 7). **v1 = a single
  owner-hosted instance + a durable embedded store** (SQLite, single-writer) — the realistic
  owner-hosted topology, and the form M6-3a ships/tests. **Multi-instance HA** (several backend
  instances behind a load balancer) instead requires a **shared-transactional** store with a
  unique `(session, nonce)` constraint; it is a stated deployment **precondition** — not
  value-gated, since testnet must validate the full restart/HA risk surface — satisfied by a
  shared-store impl behind the same store trait (no gate-path change). Note an LB/reverse-proxy
  in front of *one* backend instance (TLS termination) is the single-instance case, not HA.
  **Operational constraint (re-review H1):** the reservation/lease **TTL MUST be set well above
  the worst-case ceremony budget** (a sweep must never reclaim an in-flight reservation — the
  store treats a confirm of a vanished reservation as an *error*, not a silent success, so the
  cap cannot be under-counted), and the owner runs the reclaim sweep on startup + periodically.

**Ceremony-liveness minimum-window invariant (M1).** The multi-round DKLs ceremony + the TLS
handshake(s) + the bounded transient-retry budget all elapse **inside** the EIP-3009
`validAfter`/`validBefore` window and the x402 request's own timeout. Therefore: the issued
`validBefore − validAfter` window **MUST be ≥ the worst-case ceremony budget** (round-trips +
handshake + bounded retry), and the adapter's **ceremony timeout MUST fire *before*
`validBefore`** — surfacing `CoSignUnavailableError` (§4.4) rather than emitting a signature
that is born expired. This matters because an active adversary who **delays** (rather than
drops) the wire can otherwise push completion past `validBefore`, producing a doomed signature
that wastes the facilitator's gas on a failed settle and triggers a retry (cap pressure) —
see W11. Measuring the real round-trip to size this window is §10 Q1.

**Benign agent-host clock skew (M3).** The adapter sets `validAfter`/`validBefore` from the
**agent host's clock**, but validity is judged against **chain time at settle** — and M6-3a
makes the agent a *separate host*, so its clock is now a deployment variable (like W10's RNG).
A skewed host issues born-expired / not-yet-valid authorizations **with no adversary at all**
(same wasted-gas + retry/cap-pressure outcome as W11). Therefore the window sizing **MUST also
budget the maximum tolerated host clock skew** when issuing `validAfter`/`validBefore` (or
derive them from a trusted time source), and **agent-host clock / NTP integrity** joins the
deployment checklist next to W10's CSPRNG requirement.

### 4.9 Revocation, multi-session, settle — unchanged, reused over the wire

These are proven in the backend and need no new design — only to keep working across the
wire:

- **Revocation** = the owner stops contributing its share ⇒ immediate `revoked` rejection,
  no rounds (M6-1 §4.12). Note: from the agent's side, *revocation* and a *transport outage*
  both manifest as "no co-signature" — but they are distinct outcomes: revocation is a
  delivered `{ok:false, revoked}` verdict; an outage is a thrown `CoSignUnavailableError`
  (§4.4). DoS/availability is the practical cost of negative control (§5/W9).
- **Multi-session keying** (proven) lets one backend serve multiple agent sessions; each
  ceremony's `ssid` + A3 session binding keeps them isolated (§5/W6).
- **On-chain settle persistence** (proven) is unchanged; the signature produced over the
  wire settles a real EIP-3009 `transferWithAuthorization` exactly as M6-1 Stage 4 did — now
  with the **distributed-DKG key + the full cross-process topology** (the DoD bar, §8/§6
  test 9).
- **`transfer*` vs `receive*` + front-run griefing (L4).** The wire produces a
  `transferWithAuthorization` authorization (the backend re-derives that EIP-712 digest, §4.5),
  submitted by a **non-recipient facilitator** — so `transferWithAuthorization` is structurally
  required (`receiveWithAuthorization` needs `msg.sender == to`). `transfer*` carries the EIP-3009
  **front-run nonce-griefing** surface (a third party burns the nonce, failing the legit settle);
  the **fixed `to`** means a captured signature can only *grief*, not *redirect* funds. The
  griefing treatment is carried from M6-1 / `docs/THREAT_MODEL.md` (threat 1.3), not new here.
- **Per-call concurrency isolation (L1 — verified safe by construction).** Parallel `sign()`
  calls on the agent's one WASM share are isolated **by construction**: the share is borrowed
  **immutably**, each call builds a **fresh `SignSession`/`SignStepper`** with its **own
  channel**, and the crypto-core has **no shared mutable signing state** (no `static mut` /
  `Mutex` / `thread_local`; `agent-wasm` has no module-global state). So concurrent ceremonies
  share only the immutable key — the catastrophic nonce/`k`-reuse class **does not exist**, and
  no per-share mutex is needed (adding one would be over-building). The un-built TS adapter MUST
  **preserve** this — drive each `sign()` through its own channel + ceremony, never a shared WASM
  session — and a concurrency conformance test guards it (§6/test 10).

---

## 5. Threat model — the wire as protagonist

The new surface is over-the-wire. This table is the M6-3a-specific addendum; the crypto
threats **T1 (key extraction)** and **T2 (unaudited DKLs)** from M6-1 §5 are **unchanged and
remain the standing gate** — M6-3a does not touch them (testnet-only, §8). Where a wire
threat sharpens an M6-1 threat, the cross-reference is noted.

| # | Threat (over the wire) | Treatment |
|---|---|---|
| **W1** | **Passive eavesdropper** reads the intent (payer/payee/amount) and DKLs payloads | **TLS (wss)** confidentiality + cert pinning (§4.8). The intent is payment metadata; DKLs payloads are ssid-bound but still encrypted. (Sharpens M6-1 T5.) |
| **W2** | **Active MITM / fake backend** impersonates the owner endpoint to harvest the ceremony or feed forged rounds | **TLS server-auth + CA/cert pinning** (+ **mTLS default for remote endpoints**, M4 §4.8) → the agent authenticates the real backend; **DKLs ssid** binding makes cross-session injection fail; the **agent-side `MAX_FRAME_BYTES` bound** (M3 §4.2) blocks an OOM via over-large payload; and a fake backend **cannot produce a valid signature** (no owner share) — worst case = DoS or an audit-gated share-info-extraction attempt (T1/T2). (Sharpens M6-1 T5.) |
| **W3** | **Replay of a captured `request`** to trigger a duplicate co-sign (incl. after a restart) | Fund-safety rests on idempotency-by-nonce + atomic SpendState (§4.7) **persisted in a durable, single-writer/shared-transactional store** — a replay with the same EIP-3009 nonce collapses to the one committed result *only because that store survives a restart* (C1, §4.6 / constraint 7); the HMAC fixes `to`/`value`. A3 freshness + ssid is a *best-effort* DoS/dedup guard (not a fund boundary). |
| **W4** | **Mid-flight loss → double-commit of the cumulative cap** (TOCTOU re-opened by the wire) | Atomic `SpendState` check-and-commit (H3) **keyed to nonce-idempotency** (B7) + **restart-not-resume** + the **adapter retry-reuses-identical-intent invariant** (§4.7/H2 — the adapter must never regenerate the nonce on retry): at most one commit per (session, nonce) under arbitrary loss/retry. **Exercised by fault injection** (§6/test 5). (Sharpens M6-1 T7.) |
| **W5** | **Forged requester** on the wire solicits a co-sign | **A3** HMAC over canonical request (+ optional mTLS) → `unauthenticated`; **auth ≠ authz** (still full policy eval). (Sharpens M6-1 T6.) |
| **W6** | **Cross-session message injection** — a round message from ceremony A injected into ceremony B | **DKLs ssid** binds each protocol message to its ceremony (crypto-level); envelope `ceremonyId` routing; the counterparty's phase checks reject a mis-bound message. (Sharpens M6-1 T5.) |
| **W7** | **Control-envelope schema confusion / version drift** between the TS agent and Rust backend | The `CoSignFrame` envelope is **explicitly versioned** (`wireVersion`) with a handshake reject on mismatch, and is in the **B8 corpus**; the **crypto payload is opaque** (same-crate WASM/native), so only the small envelope is cross-language — drift is caught by the corpus + version handshake. (Removes the *schema-redeclaration* drift class for crypto messages; wasm32↔native byte-identity is **verified by §6 test 1**, not assumed — H1.) |
| **W8** | **Silent advisory fallback** when the co-signer is unreachable → a `local` signature smuggled into a bounded flow | The adapter has **no local-signing path**; a transport/availability failure **throws `CoSignUnavailableError`**, never `{ok:true}`, never a `rejection` (§4.4). This no-fallback property + the type-gate is precisely what makes **H1 closed at runtime** (conditionally — §4.4/M5). |
| **W9** | **DoS on the co-sign endpoint** — agent can't reach the gate, so it can't pay | Availability, not theft. It is the *same mechanism* as revoke (negative control), so it cannot be designed away — it is documented. Mitigations: HTTP-layer rate-limiting (operator, mirroring THREAT_MODEL 2.3), the agent's typed-transient-error handling + bounded retry. **Share-availability (a lost share) is a different problem — B5, out of scope (§9).** |
| **W10** | **Agent-side RNG failure / bias** now on a real separate host | Unchanged from M6-1 **T12**: the agent host MUST provide a CSPRNG (Web Crypto in Node ✓); flag bundlers that don't. Now that the agent is a genuinely separate host, this is a deployment checklist item; nonce-generation integrity stays in the **audit (T2)** scope. |
| **W11** | **Selective delay (not drop)** — or **benign agent-host clock skew (M3)** — pushes the ceremony / the issued `validBefore` out of sync with chain time → a born-expired (or not-yet-valid) signature wastes facilitator gas + forces a retry (griefing, distinct from outright DoS W9) | The **minimum-window invariant** (§4.8/M1+M3): `validBefore − validAfter` ≥ worst-case ceremony budget **+ max tolerated host clock skew**, the adapter's ceremony timeout fires **before** `validBefore` (surfacing `CoSignUnavailableError`), and **clock/NTP integrity** is on the deployment checklist (next to W10). Availability-class, not theft; bounded by the same retry handling as W9. |
| **W12** | **Authenticated agent compromised / prompt-injected → in-policy drain (M1)** | The agent is the named untrusted party (constraint 2) and the most-likely-compromised component; an authenticated agent that passes A3/mTLS can still stream **in-policy** payments. Bounded **not** by authentication but by the **atomic cumulative `SpendState` cap** (the backstop — the ledger commits it atomically, §4.3 step 2(f), durably §4.6/C1). M6-1 **T3** covers the *out-of-policy* request (deny-closed, no share); this is the *in-policy* residual. Distinct from **W5** (forged requester) and the bypass threats (`THREAT_MODEL` 5.2 / 1.14). Defence is layered: a tight per-deployment cap + agent-framework guardrails. |

**Carried, unchanged (the standing gate):** **T1 key extraction** and **T2 unaudited
crypto** (M6-1 §5) — no wire mechanism saves the key-extraction class; the audit (or a swap
to audited DKLs) is **MANDATORY before mainnet/real value** (§8). M6-3a keeps value-at-risk
≈0 (testnet).

**Negative-control acceptance (kill-one) over the wire:** with the owner absent/revoked, no
signature exists — the same invariant as M6-1, now demonstrated with the agent share in a
*separate Node process* (§6/test 2 negative arm).

---

## 6. Conformance & tests (B8 — extended for the wire)

The M6-1 §6 regressions (kill-one, digest-parity against **exported** types, policy parity,
all-proof-verify) carry forward and now run **with the agent share in Node over the wire**.
M6-3a adds the wire-specific suite:

1. **Cross-runtime serialization round-trip — the wasm32↔native pair specifically** (H1).
   The **wasm32**(agent) crypto-core produces DKLs round bytes the **native**(backend)
   deserializes, and vice-versa, over the **real Node↔Rust path** — **not** native↔native
   (the proven mpc-2p TCP test was native↔native and would not catch a wasm32-only
   divergence). The test pins the hazards "same crate" does not cover: length-prefix/`usize`
   width, bincode config parity (fixint vs varint), and crate version + feature parity.
   Closes M6-1 §4.7/M3 over the actual boundary. Also asserts the **agent-side
   `MAX_FRAME_BYTES` inbound bound** (M3): an over-bound frame is rejected pre-allocation.
2. **End-to-end co-sign over wss** — agent-WASM-in-Node holding **one** share + owner-Rust
   backend → a valid EIP-3009 signature, `ecrecover == group EOA`, low-S. **The first time
   the two shares live in separate processes/runtimes.** Negative arm: owner absent/revoked
   ⇒ no signature (kill-one over the wire).
3. **Policy denial over the wire** — an out-of-policy intent ⇒ backend returns the typed
   rejection, **no DKLs rounds entered, no share contributed** (assert via the backend audit
   log + a wire capture showing zero `round` frames).
4. **A3 negative** — forged / absent / stale authenticator ⇒ `unauthenticated`, no rounds.
   Replayed authenticator (W3) ⇒ rejected on freshness.
5. **Retry × idempotency fault injection + restart durability** (W4 / C1) — kill the
   connection/response at each step of §4.3; assert **exactly one cap-commit** per (session,
   nonce), the idempotent signature returned on retry, and same-nonce/different-fields ⇒ deny +
   audit. **AND across a restart**: complete a co-sign for nonce N, **restart the backend (drop +
   re-open the durable store)**, replay N → still exactly **one** cap-commit, the cached signature
   returned (not a re-run), the cumulative cap reflects the prior commit (not reset); a crashed
   mid-ceremony reservation is reclaimed by the TTL. (Proven at the store level in
   `kawasekit-mpc-2p tests/durable_store.rs`.) **AND (L3) repeated mid-ceremony connection drops
   MUST NOT grow the backend's task count / memory** (async cancellation-safety of the wss
   ceremony handler). The headline wire + durability test.
6. **TLS/mTLS negative** — wrong server cert / missing-required client cert ⇒ connection
   refused; **assert no plaintext intent on the wire** via a packet capture (confidentiality,
   W1); `ws://` rejected by the adapter.
7. **No-silent-fallback** (W8) — backend unreachable ⇒ adapter **throws
   `CoSignUnavailableError`**, **never returns `{ok:true}`**; a type-level test asserts the
   adapter exposes no local-signing path and `requireNonBypassable` accepts it.
8. **A4 digest-conformance over the wire** — the shared
   `eip3009-digest.vectors.json` corpus is asserted against the backend **reached over the
   wire** (not just the in-Rust unit test): for each vector the backend's re-derived digest
   equals the SDK's exported-types digest (§4.5).
9. **Testnet real-bullet settle** (the empirical bar) — a 2-of-2 signature produced **over
   the wss wire**, from a **distributed-DKG** key (not `re_key`) with the **full
   cross-process topology**, settles a real EIP-3009 `transferWithAuthorization` on Polygon
   Amoy; `from == group EOA`; JPYC moves. This is M6-1 §8's "now with distributed-DKG key +
   full topology" finally exercised end-to-end.
10. **Agent-side concurrency isolation** (L1) — N parallel `sign()` / `run_sign_over_channel`
   on **one** shared key share → **every** signature verifies (`ecrecover == group EOA`, low-S)
   and **no two ceremonies share a nonce** (the per-call isolation of §4.9 is real, not
   incidental; guards the un-built TS adapter against introducing a shared WASM session).
   Proven natively in `kawasekit-mpc-2p crypto-core`.

---

## 7. Empirical foundation — proven (reuse) vs. what M6-3a builds

The honest ledger, so the RFC does not overclaim. (Mirrors M6-1 §7.)

### 7.1 Proven — do NOT re-litigate (reuse)

| Layer | Proven | Where |
|---|---|---|
| crypto | DKLs23 2-of-2 sign in **native + wasm32**; distributed DKG (no dealer); kill-one abort; low-S `(r,s,v)`; `ecrecover == group EOA`; real EIP-3009 settle on Amoy | M6-1 Stages 0–4 |
| transport (in-Rust) | `transport::Channel` (in-mem duplex **+ TCP-loopback**); `run_sign_over_channel` / `run_keygen_over_channel` per-endpoint drivers; bincode DKLs-schema round-trip (`MAX_FRAME_BYTES`-bounded) | `kawasekit-mpc-2p` slices 4–5 |
| gate | `CoSignBackend.cosign` = A3 verify → A4 re-derive → policy → **atomic SpendState** → contribute; audit; `RevocationRegistry`; **idempotency-by-nonce**; multi-session; ban→permanent-revoke; settle persistence; encrypted-at-rest shares — **self-audited, fully remediated** | `kawasekit-mpc-2p` (`docs/SELF-AUDIT.md`) |
| SDK seam | `PolicyGatedSigner<E>`, `requireNonBypassable`, `PaymentIntent`, `SpendingPolicy`, x402 wiring; **EIP-712 single source of truth** + `resolvedAssetToEip3009Domain` + the **digest-conformance corpus** the backend consumes | M6-0 (on main) + M6-2 slice 1 (`7285cc4`) |

### 7.2 NOT yet built — what M6-3a closes (do not overclaim)

1. **A real agent share in Node/WASM holding ONE share**, driving the ceremony over a
   network — today's `agent-wasm` is the **in-process demo** (`demo_sign_digest`, both
   shares in one process).
2. **The cross-process / cross-runtime wire** — the `Channel` is proven over in-mem + TCP
   *within Rust*; M6-3a needs it across the **Node(WASM)↔Rust** boundary, authenticated +
   (m)TLS, on a real network. This is M6-1 §4.7 (A2) over the *real* boundary, with the new
   wire threat model (§5).
3. **The SDK adapter** — `createMpc2pPolicyGatedSigner` wrapping the wire and satisfying the
   M6-0 `PolicyGatedSigner<"cryptographic">` contract, so the type-gate makes advisory a
   compile error in bounded flows — **closing H1 at runtime** (conditionally — §4.4/M5).

### 7.3 Explicitly OUT of M6-3a (separate gates — see §9)

- **B5 share backup/recovery** — the *other* engagement-readiness precondition. A 2-of-2
  with no recovery means a lost share permanently locks funds; encrypted-at-rest ≠ durable.
- **The 3rd-party crypto audit** — the mainnet/real-value gate. M6-3a is testnet-only; the
  UNAUDITED DKLs premise stands (T1/T2).

---

## 8. Standing gate (unchanged) — the audit

M6-3a does not move the value gate. `0xCarbon/dkls23-secp256k1` is **UNAUDITED**; **key
extraction defeats the entire policy layer** (M6-1 T1) and no wire mechanism saves that
class. A **third-party crypto audit (or a swap to an audited DKLs) is MANDATORY before
mainnet/real value** (M6-1 §4.11/T2; roadmap §6). The crypto self-audit
(`mpc-rust-crypto-review`, fully remediated) hardened *our orchestration* and the
*pre-paid-audit DKLs sprint* hardened the crate, but **neither clears this gate.** M6-3a
keeps value-at-risk ≈0 (testnet) precisely so the wire can be built and exercised *before*
the audit spend — which a client who needs mainnet then funds (roadmap §6).

The two adjacent TSS-domain disciplines are **inherited, not new M6-3a work** (L2): the
**documented exit path** to an audited/Paillier-free DKLs is M6-1 §4.11 (protocol-swap
migration — fork-and-audit or swap to an audited DKLs, new keys only), and the **continuous
advisory-monitoring runbook** (OSV / GitHub Security Advisories for the exact
`dkls23-secp256k1` crate + version, treated as a top-severity dependency with an immediate
patch path) is owned by the backend/M6-1 line. A point-in-time review is insufficient for
this domain; both are named here so the testnet-only scoping does not read as omission.

---

## 9. Out of scope (M6-3a) / the two-gate model

Per roadmap §6, fund protection in a 2-of-2 with no recovery has **two independent
preconditions** that gate at different points. M6-3a closes one structural unknown but does
**not** fold in the others:

- **B5 backup/recovery** (share-loss durability) — a *separate* engagement-readiness
  precondition. **M6-3a + B5 together = the engagement-readiness gate.** Out of scope here.
- **The audit** (key-extraction / unaudited) — the **mainnet/real-value gate** (§8). Out of
  scope here.
- **Mid-ceremony resumption** — explicit non-goal for v1 (§4.7; restart-not-resume).
- **DKG ceremony operations / key provisioning UX / rotation** — M6-3b/M6-4 (§10 Q5).
- **USDC-general + the full B8 adversarial suite + backend threat-model sign-off** — M6-5.

M6-3a's scope is exactly: **the wire + the SDK adapter + the wire threat model + the
wire conformance suite + a testnet end-to-end settle.**

---

## 10. Open questions for reviewers

1. **Transport substrate — wss vs. raw-TCP-bincode vs. gRPC.** Recommend **wss** (framing +
   TLS + proxy/LB-friendly + Node-native; the opaque-payload split makes the body
   substrate-agnostic). Confirm against the x402 latency budget (carries M6-1 Q1: does the
   real round-trip need DKLs **presign**? Measure LAN then WAN — and if presign is adopted,
   the §4.5 A4 binding is a **hard constraint**: no raw-hash signing under presign).
2. **Restart vs. resume on mid-ceremony loss.** Recommend **restart + nonce-idempotency**
   (§4.7); resume would add partial-round persisted state + attack surface for little gain.
   Is resume ever worth it? (lean **no** for v1.)
3. **A3 = HMAC pre-shared key vs. mTLS-only vs. both.** Recommend **both** (HMAC floor that
   survives TLS-terminating proxies + binds to the share/policy *session*; mTLS for
   transport-level agent auth in production). Is the HMAC redundant under mTLS? (no —
   end-to-end vs. hop-by-hop, and session-binding vs. channel-binding.)
4. **Connection model — one wss per ceremony vs. a long-lived multiplexed channel.** The
   backend already supports multi-session keying; multiplexing trades simplicity for latency
   (avoids per-ceremony TLS handshakes). Which for v1?
5. **A3 key / mTLS provisioning ceremony.** Provisioned at the DKG on client infra
   (build-for-client; k0yote never holds it). Is the provisioning ceremony's threat surface
   in M6-3a, or deferred to M6-3b/M6-4? (lean **deferred**; M6-3a assumes keys in place.)
6. **Envelope encoding — CBOR vs. JSON** for `CoSignFrame`, and binary vs. base64 for the
   opaque `payload`. The opaque-crypto / versioned-envelope property holds either way;
   pick for compactness + canonical-form determinism.
7. **`validBefore` narrowing on the backend** (carried from M6-1 Q4 / M6-0 §9 Q3): may the
   backend *narrow* the expiry as a policy output (smaller replay/reorg window over the
   wire), reflected in `SignResult.intent`? Leaning yes (narrow only, never widen).

---

## Appendix A — public API sketch (for review; not final)

```ts
// kawasekit/signer — additive export; satisfies M6-0 §4.6 / §4.9.

/** A3 material: a pre-shared key and/or an mTLS client identity (§4.6 / §4.8). */
export type CoSignAuth =
  | { readonly kind: "hmac"; readonly keyRef: string /* opaque ref; never the raw key in logs */ }
  | { readonly kind: "mtls"; readonly clientCertRef: string }
  | { readonly kind: "hmac+mtls"; readonly keyRef: string; readonly clientCertRef: string };

/** TLS trust config for the wss endpoint (§4.8). `ws://` is rejected. */
export interface CoSignTls {
  /** Pinned CA / server cert the agent trusts. */
  readonly caRef: string;
  /**
   * mTLS client cert — REQUIRED for any non-loopback endpoint (M4, the default).
   * Omitting it for a remote endpoint is a construction error; server-TLS-only is
   * allowed only for loopback/dev via the loud opt-out below.
   */
  readonly clientCertRef?: string;
  /**
   * Loud, greppable opt-out to run a non-loopback endpoint WITHOUT mTLS
   * (dev/testing only). Named like `unsafeOverride` so it survives code review.
   */
  readonly unsafeAllowServerTlsOnly?: true;
}

/** Handle to the agent's ONE DKLs share (encrypted-at-rest; provisioned at DKG). */
export interface AgentShareHandle {
  readonly storeRef: string;
}

export interface Mpc2pSignerParams {
  readonly endpoint: string;          // wss://…
  readonly auth: CoSignAuth;
  readonly tls: CoSignTls;
  readonly agentShare: AgentShareHandle;
  readonly asset: X402AssetParam;     // src/tokens/asset-domain.ts (the A4 SoT, §4.5)
  readonly from: Address;             // the group 2-of-2 EOA
  /** Bounded retry for the transient transport class only (§4.7); never retries a ban/abort. */
  readonly retry?: { readonly maxAttempts: number; readonly timeoutMs: number };
}

/** Thrown (internal-error channel) when the co-signer is unreachable — NEVER a silent local sign (§4.4 / W8). */
export class CoSignUnavailableError extends Error {
  readonly kind: "transport" | "tls" | "timeout" | "self_check";
}

export function createMpc2pPolicyGatedSigner(
  p: Mpc2pSignerParams,
): PolicyGatedSigner<"cryptographic">;
```

## Appendix B — verified anchors

| Claim | Anchor |
|---|---|
| the contract this RFC satisfies (`mpc-2p` adapter, factory name, A3 carrier) | `docs/rfc/policy-gated-signer.md` §4.6 / §4.8 / §4.9 |
| `PolicyGatedSigner<"cryptographic">`, `PaymentIntent`, `SignResult`, `PolicyRejection` reasons | `src/signer/types.ts:36,57,86,105,147` |
| `requireNonBypassable` / `assertNonBypassable` type-gate (this adapter satisfies it) | `src/signer/gate.ts:28,40` |
| `local` (advisory) adapter the type-gate rejects in bounded flows | `src/signer/local.ts:65` |
| EIP-712 **single source of truth** (A4 over the wire binds to this) | `src/tokens/eip3009.ts:79,87`; `signTransferWithAuthorization` `:259` |
| `(pinned asset, chainId) → domain` resolver (backend analog) | `src/tokens/asset-domain.ts:86,148` |
| B8 digest-conformance corpus (asserted over the wire, §6/test 8) | `src/tokens/__fixtures__/eip3009-digest.vectors.json`; `src/tokens/eip3009-digest.conformance.test.ts` |
| agent-bypass class ("H1" RFC shorthand) — closed *at runtime* by a shipped, wired cryptographic adapter | `docs/THREAT_MODEL.md` **threat 5.2** (direct-signer bypass; verdict names the `mpc-2p` cryptographic adapter as the closer) + **threat 1.14** (amount sibling); `docs/rfc/policy-gated-signer.md` §2.3, §4.6 |
| A2 transport "the largest un-built piece" — realized over the real boundary here | `docs/rfc/mpc-2p-cosigner.md` §4.7 |
| proven-vs-un-built ledger this RFC builds from | `docs/rfc/mpc-2p-cosigner.md` §7 |
| crypto foundation + the standing audit gate (T1/T2) | `docs/rfc/mpc-2p-cosigner.md` §4.11 / §5; `.claude/m6-kickoff.md` §8 |
| proven backend (private): `CoSignBackend.cosign`, `run_sign_over_channel`, `transport::Channel`, atomic `SpendState`, idempotency, `RevocationRegistry`, `agent-wasm` `demo_sign_digest`, self-audit | `kawasekit-mpc-2p` (private repo; `docs/SELF-AUDIT.md`) |
| roadmap: §5 staging (M6-3a = next), §6 two-gate model, §7 monetization / build-for-client provisioning | `.claude/m6-roadmap.md` |
| kickoff: wire = threat-model protagonist; this RFC is the first action | `.claude/m6-3a-kickoff.md` |
