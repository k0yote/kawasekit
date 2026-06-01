# RFC M6-1 — mpc-2p Co-Signer (the cryptographic-enforcement adapter)

| | |
|---|---|
| **RFC** | M6-1 |
| **Title** | mpc-2p — a self-hostable 2-of-2 ECDSA co-signer that makes owner policy *cryptographically* non-bypassable |
| **Status** | Draft v3 — **the M6-1 spike is COMPLETE and empirically proven** (Stages 0–4; the on-chain leg is a real EIP-3009 settle on Polygon Amoy — see §7 for the honest per-leg ledger). This RFC is **design-first for the un-built M6-2…M6-5 integration**. `web3-cto-review` pass 1 done; **all findings closed** — Sprint 1 (C1 §1/banner recalibration + H1 digest source-of-truth + H2 presign×raw-signing guard + M2 §7.1 row) + Sprint 2/3 (M1 kill-one scope + M3 A2 serialization + M4 RNG threat + L1 Go→Rust + L2 low-S). The §8 TSS section applies **here**, not to M6-0. |
| **Author** | k0yote |
| **Reviewers (invited)** | `web3-cto-review` skill (mandatory pass — kickoff §8 TSS hardening is this RFC's burden) |
| **Milestone** | M6-1 (spike — **done**) → fixes the design for M6-2…M6-5 (Must) |
| **Satisfies the contract in** | RFC M6-0 `docs/rfc/policy-gated-signer.md` §4.6 / §4.8 / §4.9 — this RFC realizes the `PolicyGatedSigner<"cryptographic">` the seam declared. |
| **Closes** | `docs/THREAT_MODEL.md` **H1** (the agent-bypass threat). M6-0 shipped only the *affordance* (the type-gate); a shipped, wired **cryptographic** adapter is what actually closes H1 — this is that adapter. Until it is wired into a bounded flow, H1 stays ⚠️/open (M6-0 front-matter, "affordance, not closure"). |
| **Crypto foundation** | `0xCarbon/dkls23-secp256k1` (DKLs23 / OT / no-Paillier / Apache-MIT / wasm32), kickoff §8 — **UNAUDITED → audit-before-value** (the standing gate). |
| **Source of spec** | `.claude/m6-kickoff.md` §3–§8 (architecture, scope, the eight system gaps A1–A4 / B5–B8, TSS hardening) + the empirical spike `.claude/m6-1-slice-design.md` + `.claude/m6-1-a1-cross-language-findings.md`. |
| **Created** | 2026-06-02 |

> **This RFC is unusual: its core feasibility claims are EMPIRICALLY PROVEN, not
> hypothesized.** The M6-1 spike (a throwaway scratch repo, `kawasekit-cosigner/`)
> demonstrated **each leg as running code, proven individually** (not yet combined): a
> 2-of-2 DKLs23 signature settled a **real EIP-3009 `transferWithAuthorization` on
> Polygon Amoy** — using a trusted-dealer key (`re_key`) for funding convenience, which
> §4.3 **forbids in production**; **separately and off-chain**, a genuine **distributed
> DKG + kill-one** proved the non-custodial invariant; the **agent share runs in
> WASM/Node**; and the **EIP-3009 digest** matches the EIP-712 typed data. Combining the
> distributed-DKG key *with* an on-chain settle is an M6-2 step (needs share
> persistence). §7 is the authoritative per-leg record of **what the spike proved and —
> just as important — what it did *not* yet integrate.** Design-first (kickoff §10: "RFC
> → web3-cto-review → 実装") applies to the *un-built* M6-2…M6-5 integration; the crypto
> / cross-language / non-custodial / EIP-3009 / settle legs are *individually* green.

---

## 1. Summary (TL;DR)

**mpc-2p is the adapter that actually makes owner policy non-bypassable.** M6-0 built
the `PolicyGatedSigner` seam and shipped `local` (`enforcement: "advisory"`) — whose
policy a key-holder can always step around (H1). mpc-2p is
`PolicyGatedSigner<"cryptographic">`: the payer EOA's key is **split 2-of-2** between
the **agent** (one share, in-process via WASM) and the **owner backend** (the other
share + the `SpendingPolicy`). The backend re-derives the EIP-3009 digest from the
decoded intent, re-evaluates the policy, and **only then** contributes its share. No
party can produce a valid signature alone — so the policy is a *guarantee*, not a
*request*.

This is the cryptographic enforcement the kickoff's central thesis demands: replace
kawasekit's "delegation = possession of a key" with "delegation = a policy-gated
*signing authority*" (pre-m6-review §4; kickoff §1).

**Three load-bearing facts — all empirically demonstrated in the spike (§7):**

1. **Genuine distributed keygen, no trusted dealer.** Production keygen is a
   distributed DKG where neither party ever holds the whole key (spike Stage 2,
   `DkgSession`). The spike's *settle* leg used a trusted-dealer shortcut (`re_key`)
   purely to get a deterministic, fundable EOA — that shortcut is **not** the
   production path and §4.3 forbids it.
2. **No blind signing (A4).** The backend recomputes the EIP-712
   `TransferWithAuthorization` digest from the decoded `PaymentIntent` and signs
   *that*; it never signs a caller-supplied digest. The spike proved the digest
   **method** is sound — viem `hashTypedData` over the EIP-3009 typed data equals what
   `signTypedData` signs (Stage 3 digest-parity) — so on-chain `ecrecover` sees exactly
   the bytes the policy evaluated. Making that genuinely *byte-identical to the SDK's
   own* `signTransferWithAuthorization` (`src/tokens/eip3009.ts:246-260`) once the
   backend is Rust is an **M6-2 requirement**: the EIP-712 types must be a **single
   shared source of truth**, not re-declared per language (§4.5).
3. **Non-custodial — share + policy, never funds.** The owner can *refuse* (stop
   co-signing = immediate revoke) but cannot *move* funds alone (2-of-2). The spike's
   kill-one negative control makes this concrete: a single share, alone, produces no
   signature (Stage 2).

**What this RFC specifies (design-first, for M6-2…M6-5):** the share-split topology
(§4.4), the (A2) transport/secure channel (§4.7 — the largest un-built piece), (A3)
request authentication (§4.8), (A4) digest binding (§4.5), cross-language policy
re-evaluation + authoritative atomic `SpendState` (§4.6, satisfying M6-0 H2/H3), (B5)
key-share backup/recovery (§4.10), (B6) protocol-swap migration behind the audit-gate
(§4.11), (B7) the nonce boundary (§4.9), revocation (§4.12), the TSS threat model
(§5), and the (B8) adversarial test strategy (§6).

---

## 2. Problem statement — why a 2-of-2 co-signer, and why now

### 2.1 H1 is only closed by a cryptographic adapter (recap of M6-0 §2)

EIP-3009 forces an **EOA** `from` verified by pure `ecrecover` — the new JPYC
`transferWithAuthorization` has **no ERC-1271** path (`CLAUDE.md` JPYC note; M6-0
§2.2). As long as **one party holds a key that can sign unilaterally**, every
client-side guard is advisory — `wrapFetch` or not, `onPayment` or not. M6-0 proved
this structurally and shipped the type-gate as the *affordance*. To make the guard
**non-bypassable on an EOA**, the key itself must be unable to sign without the gate:
the key must be **split**, and one share must be held by the policy enforcer. That is
mpc-2p. (kickoff §2; M6-0 §2.2, §4.6 contract.)

### 2.2 Why 2-of-2 MPC specifically (vs. TEE, vs. smart-account)

- **Smart-account / ERC-4337** would move enforcement into a validator — but EIP-3009
  `transferWithAuthorization` requires an EOA signer (no contract signatures), so the
  x402/EOA-payer path cannot use a smart account for the *authorization* itself
  (`CLAUDE.md`: "EIP-3009 does NOT support ERC-1271"). The smart-account policy path
  (`src/policy/daily-limit.ts`) is a **sibling** for UserOp transfers, not this path.
- **TEE** (the reserved `tee` adapter) is a real alternative and the kickoff keeps it
  open precisely because TSS-ECDSA's fragility is *why the market defaulted to TEE*
  (kickoff §8). mpc-2p is the **no-extra-hardware, self-hostable, software-only**
  option; `tee` stays a reserved interface slot (M6-0 §4.6).
- **2-of-2 threshold ECDSA** gives exactly the non-custodial invariant we want:
  **negative control without positive control.** The owner backend can withhold its
  share (refuse / revoke) but cannot reconstruct the key or move funds alone; the
  agent likewise cannot sign alone. Neither is a custodian.

### 2.3 The cross-language problem that defined the architecture (A1)

A genuine 2-of-2 where the **TS/JS agent holds a real share** requires running *one*
MPC protocol on *both* ends, and the only end that can be JS/TS is a **WASM-compiled
Rust** library (cross-implementation MPC interop is nil). The original kickoff plan
(a Go `tss-lib` co-signer) **fails this** — `tss-lib` is Go-only with no usable WASM,
so both shares would live on the backend = the agent holds nothing = **custody**.
This A1 finding flipped the architecture to WASM-Rust, and an empirical pass then
chose `0xCarbon/dkls23-secp256k1` (the only permissive × OT × wasm32 × compiles-today
2-of-2). Full record: `.claude/m6-1-a1-cross-language-findings.md`, kickoff §8.

---

## 3. Design constraints (non-negotiable)

Derived from the M6-0 contract, the kickoff, the spike, and `CLAUDE.md`.

1. **Satisfy the M6-0 §4.6 `mpc-2p` contract verbatim** — return
   `PolicyGatedSigner<"cryptographic">`; recompute digest backend-side (A4);
   authenticate the request (A3); re-evaluate policy with a **port conformant to the
   TS `evaluateSpendingPolicy`** (B8 corpus); own the **authoritative `SpendState`**
   and commit cumulative caps **atomically** (H2/H3); deny+audit a re-used nonce with
   different fields (B7); contribute the share only on policy pass; hold **no funds**;
   `revoke` = stop co-signing; carry its own threat model through `web3-cto-review`.
2. **Crypto = `0xCarbon/dkls23-secp256k1` (DKLs23/OT), audit-gated.** Apache/MIT,
   OT-based (no Paillier ⇒ no TSSHOCK/BitForge CVE class), pure-Rust `k256` +
   `crypto-bigint` (no GMP/C). **UNAUDITED** → fine for spike/testnet (≈ zero value),
   **third-party audit (or swap to an audited DKLs) MANDATORY before mainnet/real
   value** (kickoff §8). Sequencing is non-negotiable because **key extraction
   defeats the policy layer entirely** (§5).
3. **Genuine distributed DKG — no trusted dealer in production.** Neither party ever
   holds the whole key. `re_key` (trusted dealer) is a spike-only convenience and is
   forbidden in the product (§4.3).
4. **Non-custodial is sacred.** Share + policy, never funds. Negative control only.
5. **No blind signing (A4); auth ≠ authz (A3); the nonce boundary is M5's (B7).**
6. **Policy parity is engineered, not assumed.** The Rust/Go re-evaluator and the TS
   evaluator are *two implementations of one spec*, kept identical by the B8
   cross-language corpus + the pinned canonical encoding (M6-0 §6, kickoff A1).
7. **The agent is untrusted; owner policy is the trust boundary.** The agent may be
   hostile or prompt-injected (M6-0 S1). The backend trusts *nothing* the agent
   says — it re-derives the digest and re-evaluates the policy itself.
8. **SDK stays TypeScript.** The agent-side share is Rust→WASM consumed from Node; the
   owner backend is a self-hostable Rust binary; the kawasekit SDK talks to the
   adapter through the M6-0 `PolicyGatedSigner` interface (mechanism-independent).

---

## 4. Architecture

### 4.1 Components & repos

```
kawasekit (TS SDK)                      ← M6-0 seam; unchanged by this RFC
  └─ PolicyGatedSigner<"cryptographic"> ← the contract; SDK code is adapter-agnostic

mpc-2p adapter (separate repo; spike scaffold = kawasekit-cosigner/)
  ├─ crypto/         Rust crate: 0xCarbon DKLs23 wrapper + wasm-bindgen  (PROVEN)
  │   ├─ wasm32 build → the AGENT share runs in Node (genuine MPC participant)
  │   └─ native build → the OWNER backend share
  ├─ agent (TS)      thin glue around the WASM share + the A2 transport client
  └─ backend (Rust)  owner co-signer: share + SpendingPolicy + SpendState ledger
                     + digest re-derivation + A3 auth + audit log + revoke switch
```

The crypto core is **one** Rust crate compiled two ways (wasm32 for the agent,
native for the backend) so both ends run **bit-identical** DKLs23 — the only way a
genuine 2-of-2 works (§2.3). The spike scaffold `kawasekit-cosigner/crypto/` is the
throwaway proof; the production `mpc-2p` repo is named at M6-2.

### 4.2 Crypto foundation — DKLs23 2-of-2 sign (PROVEN, Stage 0–1)

`0xCarbon/dkls23-secp256k1` v0.5.1. The signing protocol is a **synchronous,
manually-driven 4-phase `SignSession`** (no async/tokio → WASM-friendly): each party
runs `phase1..phase4`, exchanging typed messages routed by recipient; `phase4(…,
normalize = true)` yields a **low-S** signature with a recovery id. The result is a
standard secp256k1 ECDSA signature: `(r, s, v)` where on-chain `v = recovery_id + 27`.
**Low-S is mandatory, not cosmetic (L2):** ECDSA `s` is malleable (EIP-2 fixes the low-S
canonical form), and modern FiatToken / OpenZeppelin `ECDSA.recover` verifiers **reject
high-S** (confirm against the JPYC contract) — so `normalize = true` must never be dropped.
**Proven:** the signature `verify_ecdsa_signature` = true natively (Stage 0b), the
same path runs **in wasm32 + Node** (Stage 0c), and viem `recoverAddress` (=
`ecrecover` semantics) recovers the joint **group EOA** (Stage 1).

WASM specifics that M6-2 must carry forward (spike-discovered): the crate's RNG is
`rand::rng()` (ThreadRng → OS entropy), which on wasm32 needs
`getrandom = { features = ["wasm_js"] }` **and** `.cargo/config.toml` rustflags
`--cfg getrandom_backend="wasm_js"` (Web Crypto in Node). Without it the agent share
cannot sample randomness. **This is security-load-bearing, not just a build flag (T12):**
ECDSA nonce secrecy and the DKLs joint-randomness depend on the agent's RNG quality — a
biased/predictable source is a key-leak vector, so the host must provide a CSPRNG and the
audit (T2) covers nonce-generation integrity.

### 4.3 Keygen — genuine distributed DKG, NO trusted dealer (PROVEN, Stage 2)

**Production keygen MUST be the distributed DKG** (`DkgSession` phase1→4): each party
samples its own polynomial and exchanges only protocol messages (zero-share + OT-mul
+ BIP-derivation); the joint public key emerges with **neither party ever holding the
whole key**. The spike proved both parties derive the **same** group EOA and that the
resulting shares are sign-ready (phase4 wires the OT/mul setup distributively).

> **⚠️ `re_key` is forbidden in production.** The spike's Stage 0c/1/3/4 used
> `re_key` — a *trusted-dealer* shortcut that computes both shares + all OT setup
> locally from one secret — solely to obtain a **deterministic, fundable** EOA so the
> on-chain settle could reuse one funded address across runs. `re_key` is
> custody-in-disguise (one process knows the whole key) and is acceptable **only** for
> the EIP-3009/settle leg of the spike. mpc-2p production uses `DkgSession`
> exclusively. A consequence for M6-2 (§7): a DKG-keyed EOA is *random per ceremony*,
> so funding it for a real settle requires **share persistence** (§4.10) — the spike
> sidestepped this with `re_key`, which is why the "distributed DKG" leg (Stage 2) and
> the "on-chain settle" leg (Stage 4) were proven *separately*, not in one run.

### 4.4 Share-split topology — resolving the M6-0 §4.1 open question

M6-0 §4.1 deliberately left open whether the adapter's TS side is a *thin transport*
or a *full MPC participant*, pending this spike. **Resolved: full MPC participant.**
The agent holds a **genuine 2-of-2 share** and runs the DKLs protocol rounds in
**WASM, in-process** (Stage 0c proved the signing path executes in wasm32+Node); the
owner backend holds the other share. A thin-transport topology (agent forwards an
intent, backend signs) was rejected by A1: it collapses to the backend holding the
whole signing capability = custody (§2.3). This choice is what earns the
`"cryptographic"` enforcement label — the agent is a real cryptographic party, not a
client of a server that could sign alone.

### 4.5 (A4) Digest ↔ intent binding (digest *method* PROVEN, Stage 3)

The backend receives the **decoded `PaymentIntent`** (M6-0 §4.3: `{token, chainId,
from, to, value, validAfter, validBefore, nonce}`) — never a digest. It recomputes
the EIP-712 `TransferWithAuthorization` digest from those fields **plus a trusted,
pinned `(token, chainId) → (name, version)` domain registry** (never advertised
`extra`), and signs that. A `token` absent from the registry → `token_not_allowed`; a
recomputed digest that disagrees with anything the agent implies → no share
contributed. (kickoff §3 A4; M6-0 §4.3.)

**What the spike proved — and the gap (H1).** Stage 3 computed the digest with viem
`hashTypedData` over the EIP-3009 typed data + JPYC domain (`JPY Coin` / `"1"` /
`0xE7C3…` / chainId 80002) and a **digest-parity check** confirmed it equals what a
viem `signTypedData` produces. This proves the digest **method** is sound. It does
**not** prove byte-identity to `src/tokens/eip3009.ts:246-260`: the spike harness used
a **verbatim copy** of `transferWithAuthorizationTypes` on *both* sides of the parity
check (`run-stage3.mjs`), so the test is circular w.r.t. the SDK's actual type
definition — the copy is faithful today but nothing enforces it. **M6-2 requirement:**
the EIP-712 **types + domain must be a single shared source of truth** — the SDK
exports the canonical `transferWithAuthorizationTypes`, and the backend (Rust) consumes
that exported definition (or a pinned/codegen spec generated from it), **not a
re-declaration**. A **digest-conformance vector** is added to the B8 canonical-encoding
corpus (§4.6) and asserted against the SDK's *exported* types, so any Rust-side EIP-712
re-encoding mismatch (field order, type strings, domain) is caught cross-language. Only
then is "the bytes the policy gates on == the bytes `ecrecover` verifies" *enforced*,
not merely true-by-inspection.

**Presign × raw-signing — a forgery class to design out now (H2).** The signing
primitive signs a **raw 32-byte digest** (`sign_digest_2of2`, no message at the crypto
layer), and §10 Q1 contemplates **presigning** for latency. The combination
*presignature + raw signing (signing a hash without knowing the message)* is a
documented forgery / key-reconstruction class (web3 checklist §8; cf.
CVE-2025-66016/66017 on CGGMP21/24 — protocol-agnostic in shape). Today the design is
safe **because of A4**: the co-signer never signs an opaque hash — it **reconstructs**
the digest from a known `PaymentIntent`, so there is always a message behind the hash.
This safety is now a **hard constraint, not a coincidence**: any future presign design
**MUST bind the intent/message into the presignature** (no presignature usable against
an arbitrary digest) and **MUST forbid mutable derivation paths**; verifying this is in
the audit-gate (T2) scope. If a presign API cannot preserve the A4 binding, presign is
not adopted.

### 4.6 Policy re-evaluation + authoritative atomic SpendState (M6-0 H2/H3)

The backend re-evaluates the **same `SpendingPolicy` spec** as the SDK, via a **Rust**
port of `evaluateSpendingPolicy` (M6-0 §4.4) — Rust because the backend co-locates with
the 0xCarbon DKLs crate, **superseding M6-0's "Go port/backend" phrasing** (L1; the B8
corpus is language-neutral, so parity is unaffected) — kept identical to the TS
implementation by the **B8 cross-language conformance corpus + pinned canonical
encoding** (decimal-string `bigint`, checksummed `Address`, fixed `perToken` order,
explicit allowlist semantics; M6-0 §6). The **backend verdict is authoritative** (H2)
— it ignores any client-supplied state. For `cumulativeCap`, the backend owns the
**authoritative per-session `SpendState` ledger** and performs cumulative-cap
**check-and-commit atomically**, so parallel co-sign requests (LLM tool fan-out)
cannot race past the cap (H3 TOCTOU — the same race class M5's leased idempotency
store solved). This is the property M6-0's `local` adapter explicitly does **not**
provide; mpc-2p is where it becomes real.

### 4.7 (A2) Transport / secure channel — the largest un-built piece

The DKG and sign protocols are **multi-round, interactive** message exchanges. The
spike ran both parties **in one process** (Stage 2 native, in-proc routing), which
proves the protocol but leaves the cross-process/cross-language transport **un-built**
— this is the biggest M6-2/M6-4 design surface:

- **Message transport & serialization** between the agent (Node/WASM) and the backend
  (Rust): round framing, ordering, the DKLs message types over the wire. **Specifically
  un-de-risked (M3):** Stage 2 passed the DKLs message types (`Transmit*`, zero-share,
  OT-mul, BIP) as **in-memory Rust structs in one process** — never serialized across the
  WASM(Node)↔native(Rust) boundary. Cross-language (de)serialization of that message
  schema (field/version drift, encoding) is the part the in-proc proof did **not** touch,
  and should be the **first** M6-2 transport de-risk.
- **Session orchestration**: round-trip arbitration, timeout/retry, idempotent
  re-drive of an interrupted ceremony, identifiable-abort handling.
- **MITM resistance**: the channel MUST be **authenticated + encrypted**. A
  man-in-the-middle on the MPC messages is a distinct threat from A3 request-auth (a
  forged *message* vs. a forged *requester*).
- **Latency budget**: the round-trips must fit the x402 settle budget. DKLs23 supports
  presigning (offline rounds → fewer online rounds); whether the spike's synchronous
  4-phase path needs presign optimization for production latency is an open question
  (§10).

### 4.8 (A3) Request authentication — "who is asking" ≠ "what is allowed"

Every co-sign request is authenticated (token / mTLS), bound to a specific key-share +
policy, before any policy evaluation. Failure → `unauthenticated` (M6-0
`PolicyRejection` already reserves this reason). Authentication **never** stands in
for authorization: an authenticated caller still passes the full policy evaluation.
M6-0 §4.9 reserved the opaque `auth` carrier on adapter construction; mpc-2p realizes
it. A3 and policy are orthogonal layers (kickoff §3 A3).

### 4.9 (B7) Nonce / idempotency boundary

mpc-2p enforces *is-this-allowed*, **not** *is-this-the-same-payment-twice* — that
remains M5's `deriveAuthorizationNonce` (`src/tokens/eip3009.ts:157-172`) + the token
contract's `authorizationState`. The boundary mpc-2p MUST respect and **audit**: a
co-sign request re-presenting a **previously-seen nonce with different intent fields**
is a fund-correctness anomaly → **deny + log** (M6-0 §4.8). Spend-policy and
double-pay enforcement compose; neither subsumes the other.

### 4.10 (B5) Key-share backup / recovery — a hard requirement

2-of-2 means **either share lost ⇒ funds permanently locked**. This is a design
*must*, not a nice-to-have (kickoff §4 B5). Scope for M6-3:

- **Agent-share persistence + backup** (encrypted at rest; the agent share must
  survive process restarts — and, combined with §4.3, this is *also* what makes a
  DKG-keyed EOA stable enough to fund and reuse).
- **Owner-share backup** (the policy enforcer's share).
- **Proactive share refresh** (re-randomize shares without changing the public key;
  ePrint 2019/1328) to bound the window in which a single stolen share is useful.
- A documented **recovery ceremony** (and its threat surface — recovery is a juicy
  target).

### 4.11 (B6) Protocol-swap migration behind the audit-gate

The standing pre-value gate: **0xCarbon DKLs is unaudited.** Before mainnet/real
value, close it by either (a) **fork 0xCarbon → maintain/trace → commission a
third-party audit** (the main line), or (b) **swap to an audited DKLs** (Silence Labs
`sl-dkls23` under a commercial license, or another audited OT lib). Either way:
**live key shares are likely non-portable across DKLs implementations**, so a swap
means **new keys only** (existing accounts re-run DKG) — plan the migration path
(kickoff §8 B6). The M6-0 seam keeps the SDK side unchanged across any such swap
(`interface` stable, mechanism swapped).

### 4.12 Revocation

Owner disables the agent → the backend stops contributing its share → **immediate
revoke**, no on-chain uninstall, no settlement possible from that point. This is the
practical payoff of negative control and is strictly a backend switch (it does not
touch the agent or the chain).

---

## 5. Threat model (the TSS treatment — kickoff §8 lands HERE)

This is the threat model M6-0 §8 deferred to "the mpc-2p adapter's own RFC." The
`web3-cto-review` §8 TSS section applies to this table.

| # | Threat | Treatment |
|---|---|---|
| T1 | **Key extraction** from a share store reconstructs the EOA key → bypasses policy + on-chain caps entirely | **The load-bearing threat.** No policy/defense-in-depth saves this class (kickoff §8 "鍵抽出は policy 層を突破する"). Mitigation is *crypto correctness*: OT/DKLs removes the Paillier CVE class outright, **plus** the audit-gate (T2). Documented, never papered over (M6-0 S5). |
| T2 | **Unaudited crypto** (0xCarbon) ships an undiscovered soundness bug | **Standing gate (§4.11):** unaudited = spike/testnet (≈0 value) only; third-party audit or audited-DKLs swap **MANDATORY before mainnet**. value-at-risk kept ≈0 until then. |
| T3 | **Hostile / prompt-injected agent** requests an out-of-policy co-sign | Backend re-derives digest + re-evaluates policy; deny-closed, typed rejection, no share. **Agent is untrusted; owner policy is the boundary** (M6-0 S1). |
| T4 | Agent submits an **opaque digest** / mismatched fields to smuggle an unevaluated payment | A4 (§4.5): decoded-intent-only; backend recomputes; `intent_digest_mismatch` → no share (digest *method* proven Stage 3; byte-identity enforced at M6-2 via shared types, H1). |
| T5 | **MITM on the MPC channel** forges/replays protocol messages | A2 (§4.7): authenticated + encrypted channel; ssid/session binding; identifiable abort. Distinct from T6. |
| T6 | **Unauthenticated party** solicits a co-sign | A3 (§4.8): `unauthenticated`; auth bound to share+policy; auth ≠ authz. |
| T7 | **Parallel fan-out races the cumulative cap** (TOCTOU) | H3 (§4.6): authoritative backend ledger, atomic check-and-commit. |
| T8 | **Nonce reuse** for a different payment (double-pay vector) | B7 (§4.9): owned by M5 derived-nonce + on-chain `authorizationState`; mpc-2p denies+audits the re-used-nonce-different-fields anomaly. |
| T9 | **Single share lost** → permanent fund lock (availability, not theft) | B5 (§4.10): share backup + proactive refresh + recovery ceremony. A *must*, not optional. |
| T10 | **Custody creep** — does holding share+policy make the operator a custodian? | Non-custodial invariant: share+policy, **no funds**, negative control only. Regulatory framing kickoff §7; **expert review required before third-party operation** (out of scope for self-host). |
| T11 | **Agent-share compromise** (the WASM share or its host is owned) | Single stolen share ≠ signing capability (2-of-2) — but this rests on the **DKLs security proof**, *not* on the kill-one test (which proves only that the honest protocol **aborts** without the counterparty; M1). So share-secrecy is **gated on the audit (T2)**, not demonstrated by the spike. Bounded further by proactive refresh (§4.10) and revoke (§4.12). Full key compromise = T1. |
| T12 | **Agent-side RNG failure / bias** → ECDSA nonce or DKLs joint-randomness compromise → share/key leak | The agent's `wasm_js` getrandom backend (§4.2, Appendix A) is **security-load-bearing**, not a build detail: ECDSA nonce secrecy and the DKLs joint-randomness depend on it. The agent host MUST provide a CSPRNG (Web Crypto in Node ✓; flag bundling environments that don't); nonce-generation integrity is in the **audit (T2)** scope. |

**Negative-control acceptance (kill-one, PROVEN — Stage 2):** with one party absent
(or `revoked`), no signature exists. The spike's kill-one test is the empirical proof
and becomes a CI regression (§6). This is the non-custodial invariant as running code.

---

## 6. Conformance & tests (B8 — adversarial / regression)

The spike already produced three of these as runnable checks; M6-2 promotes them to
the adapter's CI and adds the rest.

1. **kill-one negative control** (PROVEN as a *protocol-abort* control, Stage 2) → CI
   regression: a single share, driving the honest protocol without the counterparty's
   messages, MUST NOT produce a valid signature (`sign_with_both` is the positive
   contrast). **Scope (M1):** this proves the protocol *aborts*, not that a stolen share
   is computationally inert offline — that rests on the DKLs security proof (T2). M6-2
   should strengthen the test to assert the abort is the MtA/consistency/identifiable-abort
   failure (not empty-input validation).
2. **digest-parity** (*method* PROVEN, Stage 3; byte-identity is enforced at M6-2 via a
   shared EIP-712 type source-of-truth, H1/§4.5) → CI: the backend digest MUST equal the
   SDK's `signTransferWithAuthorization` digest for the same intent, asserted against the
   SDK's **exported** EIP-712 types (not a re-declaration).
3. **cross-language policy parity** (B8, shared with M6-0 §6): the Rust/Go
   re-evaluator and the TS `evaluateSpendingPolicy` MUST return byte-identical
   decisions over the shared corpus against the pinned canonical encoding.
4. **all-proof-verify regression**: removing/weakening any DKLs consistency/ZK/OT
   proof check MUST be caught (no silent attack-surface widening); **identifiable
   abort** on a malformed message.
5. **testnet real-bullet settle** (PROVEN, Stage 4 — the empirical bar): a 2-of-2
   signature settles a real EIP-3009 `transferWithAuthorization` on Polygon Amoy /
   Kairos, `from == group EOA`, JPYC moves. Same bar as M5's real-bullet settles.

---

## 7. Empirical foundation — what the M6-1 spike PROVED (and what it did NOT)

The spike (`kawasekit-cosigner/crypto/`, throwaway) de-risked riskiest-first. This is
the honest ledger — **proven legs** vs. **un-built integration** — so the RFC does not
overclaim.

### 7.1 Proven (running code)

| Stage | Claim proven | Artifact |
|---|---|---|
| 0 | `0xCarbon/dkls23-secp256k1` compiles to `wasm32-unknown-unknown` (pure-Rust, no GMP/C) | `crypto/Cargo.toml` |
| 0b | native 2-of-2 keygen + sign → valid secp256k1 sig (`verify_ecdsa_signature` = true) | `crypto/src/main.rs`, `lib.rs` |
| 0c | the **signing path runs in wasm32 + Node** → genuine in-process agent share | `crypto/src/lib.rs` (`sign_2of2`), `run-node.mjs` |
| 1 | viem `recoverAddress` (= `ecrecover`) recovers the **group EOA** from the 2-of-2 sig | `crypto/run-node.mjs` |
| 2 | **distributed DKG (no trusted dealer)** + 2-of-2 sign + **kill-one aborts** (protocol-level negative control; *share-secrecy* itself rests on the unaudited DKLs proof — T2/M1) | `crypto/src/bin/stage2.rs` |
| 3 | sign a **real EIP-3009 digest**; **digest-parity** (*method* proven: viem `hashTypedData` ≡ `signTypedData` over the EIP-3009 typed data — see §4.5/H1 on byte-identity & shared types); `ecrecover == from` | `crypto/run-stage3.mjs`, `lib.rs` (`sign_digest_2of2`) |
| 4 | **on-chain settle** on Polygon Amoy: real `transferWithAuthorization`, `from == group EOA`, JPYC moved — ⚠️ *the EOA was `re_key` (trusted dealer), **not** the distributed-DKG key (§7.2(b)); distributed-DKG + on-chain settle are not yet combined* | `crypto/run-stage4.mjs`; tx `0x4720be99677a5bce57573a3d8df64dfddb8b26fab99c1e5223d197bc911c788f` (block 39415637) |

The architecture's *unknowns are retired*: a TS agent **can** hold a genuine MPC
share (WASM-Rust), the keygen **is** non-custodial, the signature **is** a valid
EIP-3009 authorization a live chain accepts.

### 7.2 NOT yet integrated (the M6-2…M6-4 surface — do not overclaim)

- **The full cross-process / cross-language topology.** Stage 2 ran *both* parties in
  **one native process** (in-proc message routing). It proves the protocol is
  genuinely distributed and non-custodial, but the **agent-WASM-in-Node ↔
  owner-Rust-backend-over-a-network-transport** wiring is **un-built** — that is (A2)
  §4.7, the biggest piece. In particular the DKLs message types were passed as
  **in-memory structs, never serialized cross-language** (M3) — wire (de)serialization
  of that schema is untested.
- **DKG-keyed *and* fundable in one run.** The distributed-DKG leg (Stage 2) and the
  on-chain-settle leg (Stage 4) were proven **separately**: Stage 4 used `re_key`'s
  deterministic EOA so it could be funded once. A DKG-keyed EOA is random per ceremony
  → needs **share persistence** (§4.10) before it can be funded and settled. Combining
  the two legs is an M6-2 integration task (de-risked, not done).
- **Policy re-evaluation, A3 auth, audit log, revoke switch** — none built in the
  spike (out of slice scope by design); §4.6/§4.8/§4.12.
- **The audit.** 0xCarbon is unaudited; the testnet settle was deliberately ≈0 value
  (T2 gate).

---

## 8. Definition of Done (mpc-2p, per kickoff §6)

- mpc-2p adapter signs **within** owner policy and **refuses outside it**, returns
  `PolicyGatedSigner<"cryptographic">`, owner can **revoke**, holds **share+policy but
  no funds**.
- **2-of-2 MPC x402 real-bullet settle** on testnet (the §6.5 bar) — now with a
  **distributed-DKG** key (not `re_key`) and the full agent/backend topology.
- kawasekit SDK pays via the cryptographic adapter (M6-0 seam, `requireNonBypassable`
  satisfied at last) → **H1 closes** in `THREAT_MODEL.md`.
- (A3) auth + (A4) digest binding effective; (B5) backup/recovery works; (B7) nonce
  boundary respected; (B8) adversarial suite green (kill-one, digest-parity, policy
  parity, all-proof-verify).
- backend carries its own threat model through `web3-cto-review` (§8 TSS) and the
  **audit-gate (T2) is cleared** before any real value.

---

## 9. Staging (maps to kickoff §5 M6-2…M6-5)

- **M6-2** — policy enforcement wired into mpc-2p (cap/recipient/rate/expiry/cumulative
  via the Rust/Go port) + (A3) request auth + (A4) digest↔intent + audit log +
  revocation; combine the DKG-key + settle legs (§7.2) with share persistence.
- **M6-3** — key-share lifecycle: DKG ceremony ops, rotation, **(B5) backup/recovery**,
  **(B6) protocol-swap migration**.
- **M6-4** — self-hostable deploy (Rust binary + DKLs, config-as-data) + **(A2)
  transport/secure channel** finished + kawasekit integration finished.
- **M6-5** — stablecoin-general (USDC alongside JPYC) + **(B8) adversarial suite** +
  backend threat model sign-off.
- **Pre-value (any time before mainnet)** — **the audit (T2/§4.11).**

---

## 10. Open questions for reviewers

1. **Presign vs. synchronous rounds for latency.** The spike used the synchronous
   4-phase `SignSession`. Does the x402 settle budget require DKLs23 **presigning**
   (offline rounds → 1 online round)? Measure the agent↔backend round-trip before
   committing the transport design (§4.7). **Hard constraint if presign is adopted
   (§4.5/H2):** the presignature MUST bind the intent/message (no raw-hash signing under
   presign) and MUST forbid mutable derivation paths — else it re-enters the
   CVE-2025-66016/66017 forgery class. If a presign API cannot preserve the A4 binding,
   presign is rejected.
2. **Where does the agent share live, and how is it backed up?** (§4.10) The
   non-custodial story depends on the agent genuinely holding a share that is *also*
   recoverable — these pull in opposite directions. Encrypted-at-rest + proactive
   refresh, or a (2-of-3)-with-owner-backup variant? v1 = 2-of-2; revisit.
3. **Fork-and-audit vs. buy-an-audited-license (T2/§4.11).** Commit to the 0xCarbon
   fork+audit line, or keep Silence Labs commercial DKLs as the swap target? Affects
   B6 migration planning.
4. **`validBefore` narrowing on the backend** (carried from M6-0 §9 Q3): may the
   backend *narrow* the expiry as a policy output (smaller replay/reorg window),
   reflected in `SignResult.intent`? Leaning yes (narrow only, never widen).
5. **Transport: in-house vs. an existing MPC-networking layer?** (§4.7) Build the
   authenticated/encrypted round transport, or adopt one? Cross-language (TS↔Rust)
   constrains the options.

---

## Appendix A — the proven spike recipe (for M6-2 to lift)

Key technical details the spike established, so M6-2 does not rediscover them:

- **Crate**: `dkls23-secp256k1 = "0.5.1"` (0xCarbon), with `k256` (RustCrypto
  secp256k1) + `crypto-bigint` — no GMP, no C, no Paillier.
- **WASM RNG**: `getrandom = { version = "0.4", features = ["wasm_js"] }` +
  `.cargo/config.toml` → `[target.wasm32-unknown-unknown] rustflags = ['--cfg',
  'getrandom_backend="wasm_js"']`. Build with `wasm-pack build --target nodejs`.
- **Keygen (production)**: `DkgSession` phase1→4 (distributed, no dealer). **Not**
  `re_key` (trusted dealer; spike-only, for a deterministic fundable EOA).
- **Sign**: `SignSession` phase1→4, messages routed by `.parties.receiver`;
  `phase4(…, normalize = true)` → low-S `EcdsaSignature { r, s, recovery_id }`. **`normalize
  = true` is required** — high-S is rejected by OZ `ECDSA.recover` (L2/§4.2).
- **EOA / v**: `compute_eth_address(&pk)` (EIP-55) = the group EOA; on-chain `v =
  recovery_id + 27`; `verify_ecdsa_signature` / viem `recoverAddress` both check it.
- **EIP-3009 digest**: viem `hashTypedData` over `transferWithAuthorizationTypes`
  (`src/tokens/eip3009.ts:76-85`) + the JPYC domain `{name:"JPY Coin", version:"1",
  chainId, verifyingContract:0xE7C3D8C9…29}`; **digest-parity** vs. `signTypedData`
  confirms byte-identity.
- **Settle**: JPYC `transferWithAuthorization(from,to,value,validAfter,validBefore,
  nonce, v, r, s)` (the `(v,r,s)` overload, `src/tokens/jpyc.ts:214`), broadcast by a
  gas-paying facilitator EOA; the group EOA is the `from`.

## Appendix B — verified anchors

| Claim | Anchor |
|---|---|
| the contract this RFC satisfies (`mpc-2p` adapter) | `docs/rfc/policy-gated-signer.md` §4.6 / §4.8 / §4.9 |
| `PolicyGatedSigner<"cryptographic">`, `PaymentIntent`, `SignResult`, reasons (`intent_digest_mismatch`, `unauthenticated`) | `src/signer/types.ts` |
| `requireNonBypassable` type-gate (this adapter satisfies it) | `src/signer/gate.ts` |
| `evaluateSpendingPolicy` spec the backend ports (B8) | `src/policy/spending-policy.ts`; corpus `src/policy/__fixtures__/spending-policy.vectors.json` |
| EIP-712 `TransferWithAuthorization` type + signer (A4 source of truth) | `src/tokens/eip3009.ts:76-85`, `:246-260` |
| JPYC `transferWithAuthorization` `(v,r,s)` overload | `src/tokens/jpyc.ts:214` |
| derived-nonce / `authorizationState` (B7, M5) | `src/tokens/eip3009.ts:157-172` |
| crypto foundation decision (0xCarbon DKLs, audit-gate) | `.claude/m6-kickoff.md` §8 |
| A1 cross-language finding (why WASM-Rust, why not tss-lib) | `.claude/m6-1-a1-cross-language-findings.md` |
| spike stages 0–4 (proven legs + the recipe) | `.claude/m6-1-slice-design.md`; `kawasekit-cosigner/crypto/{Cargo.toml,src/lib.rs,src/bin/stage2.rs,run-node.mjs,run-stage3.mjs,run-stage4.mjs}` |
| on-chain proof | Amoy tx `0x4720be99677a5bce57573a3d8df64dfddb8b26fab99c1e5223d197bc911c788f` |
| TSS hardening / threat-model burden lives here, not M6-0 | `.claude/m6-kickoff.md` §8; `docs/rfc/policy-gated-signer.md` §8 (Out of scope) |
