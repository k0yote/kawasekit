# RFC M6-0 — PolicyGatedSigner Seam

| | |
|---|---|
| **RFC** | M6-0 |
| **Title** | PolicyGatedSigner — a signing seam where the enforcement *strength* is a first-class, type-visible property |
| **Status** | Draft v3 — **M6-0 implemented + merged; all `web3-cto-review` pass-1 findings closed** (C1 + H1–H3 + M1–M3 + L1–L2). M1 resolved in implementation (throw at the x402 boundary via `X402PolicyRejectedError`, typed `SignResult` at the signer boundary). |
| **Author** | k0yote |
| **Reviewers (invited)** | `web3-cto-review` skill (mandatory pass; §8 TSS section applies to the mpc-2p adapter, not to this M6-0 slice) |
| **Milestone** | M6-0 (Must / baseline — mechanism-independent, parallel-safe with the `0.1.0` GA soak) |
| **Addresses (affordance, not closure)** | `docs/THREAT_MODEL.md` threat **H1** (the bypassable `onPayment` guard). M6-0 ships the **affordance** that makes H1 *closable* — it moves policy into the signing primitive and makes substituting an advisory signer for an enforcing one a **compile error** — and generalizes M5-2 `maxAmountPerSign` (threat 1.14) from a single ceiling to policy-as-data. It does **NOT close H1**: M6-0 ships only the `local`/**advisory** adapter, whose policy a key-holder can still bypass; agent-bypass is closed only by a **cryptographic** adapter (`mpc-2p`, M6-1+, separate Go repo + RFC). **H1 therefore stays ⚠️/open in `THREAT_MODEL.md` until a cryptographic adapter ships and is wired** — exactly parallel to M5-2 shipping the `maxAmountPerSign` affordance while threat 1.14 stayed ⚠️. |
| **Defines the contract for** | the `mpc-2p` reference adapter (`enforcement: "cryptographic"`) — this RFC fixes the seam both adapters must satisfy, so the cryptographic adapter is designed against it from day one. |
| **Source of spec** | `.claude/m6-kickoff.md` §3–§8 (architecture, scope, hardening). This RFC is the design-first artifact for the M6-0 row of the kickoff sub-milestone table (§5). |
| **Created** | 2026-06-01 |

> This RFC fixes the design of the PolicyGatedSigner seam **before**
> implementation, per the M6 kickoff (`.claude/m6-kickoff.md` §10: "design-first —
> RFC → web3-cto-review → 実装"). Implementation of the M6-0 slice touches
> `src/policy/` and adds `src/signer/`, so it additionally goes through Plan Mode
> (`CLAUDE.md` Design Review Discipline). The design passed `web3-cto-review` pass 1
> (Sprint 1 C1 + H1–H3 applied); the §4.5 type-gate was compiled with `tsc --strict`
> (confirmed). **M6-0 is now implemented and merged** — Appendix B `file:line` anchors
> have been **re-verified against the implemented tree** (L2 done), and
> `recipientAllowlist` was tightened to required `| "any"` (M2 done).

---

## 1. Summary (TL;DR)

kawasekit's x402 / EIP-3009 path has **two policy primitives with opposite
enforcement strength, and nothing in the type system says which is which**:

- `maxAmountPerSign` is checked **inside** `sign()` (`src/x402/client.ts:382-387`)
  — **non-bypassable**: an agent that wants a signature *must* go through the
  ceiling check.
- `onPayment` is an **advisory** callback in `wrapFetch`
  (`src/x402/fetch.ts:85-88`, invoked only at `:221`) — **bypassable**: an agent
  can call `signer.sign()` directly and never reach it (the example at
  `src/x402/fetch.ts:326-336` does exactly that). This asymmetry is **H1**.

The lesson of M5 was *where you put the check determines whether it can be
skipped*. M6 generalizes that lesson along two axes at once:

1. **Move policy enforcement into the signing primitive** — a `PolicyGatedSigner`
   signs the EIP-3009 intent `{token, chainId, from, to, value, validAfter,
   validBefore, nonce}` **only if owner policy approves it**, and returns a typed
   rejection otherwise. There is no "sign first, check later" surface.
2. **Make the enforcement *strength* a first-class, type-visible property.** A
   signer declares `enforcement: "advisory" | "cryptographic" | "hardware" |
   "integrator"`. A `local` signer (a raw viem `Account` + a client-side gate) is
   `"advisory"` — the holder of the key can always bypass the gate by signing
   directly, so its policy is a *request*, not a *guarantee*. An `mpc-2p` signer
   (key split 2-of-2, owner backend re-evaluates policy before contributing its
   share) is `"cryptographic"` — no party can produce a valid signature without a
   policy-passing co-sign. The enforcement level is a **type parameter**, so a
   flow that requires non-bypassable enforcement (bounded amounts, regulated
   contexts) **fails to compile** when handed a `local` signer. This is the
   compile-time analog of "put the check inside `sign()`": it makes H1 *closable*
   and makes substituting an advisory signer for an enforcing one a **compile
   error**. It does **not by itself close H1** — H1 is the *agent-bypass* threat,
   and the type-gate binds the *integrator*, not the agent. H1 is closed only once
   a non-bypassable (`cryptographic`) adapter ships **and** is wired into the
   bounded flow. In the M6-0 slice no shipped adapter satisfies
   `requireNonBypassable` (only `local`/advisory exists), so the gate's positive
   direction is exercised by a type-level fixture (§6) until `mpc-2p` lands.

Three invariants make the gate meaningful:

- **No blind signing (A4).** `sign()` takes a **decoded `PaymentIntent`**, never a
  caller-supplied digest. The signer **recomputes** the EIP-712
  `TransferWithAuthorization` digest from the intent fields
  (`src/tokens/eip3009.ts:246-260`) and signs *that*. You can only gate on fields
  you can see; an opaque digest would let an agent smuggle an unevaluated payment
  past the policy.
- **One policy spec, two *conformant* implementations.** `SpendingPolicy` is
  **policy-as-data** (session+expiry, per-token `maxPerSign`+cumulative cap,
  recipient allowlist, `revoked`). The SDK-side (`local`) evaluator is TypeScript;
  the `mpc-2p` backend re-evaluates the same spec in **Go** (separate repo) — so it
  is one *specification* with **two implementations across a language boundary**,
  not literally one function. A **cross-language conformance test (B8)** drives a
  shared, language-neutral fixture corpus through both and asserts byte-identical
  decisions, against a **pinned canonical encoding** of policy-as-data
  (decimal-string `bigint`, checksummed `Address`, fixed `perToken` order, explicit
  allowlist semantics). With that in place, "advisory" and "cryptographic" differ
  only in *who can bypass*, never in *what is allowed* — but the parity is
  *engineered*, not assumed (this is kickoff **A1** surfacing in the policy layer).
- **Spend policy ≠ double-pay (B7).** The signer enforces *is this payment
  allowed?* It does **not** own *is this the same payment twice?* — that remains
  M5's `deriveAuthorizationNonce` (`src/tokens/eip3009.ts:157-172`) + the token
  contract's `authorizationState`. The two compose; neither subsumes the other.

This RFC specifies the **M6-0 slice**: the interface, the `PaymentIntent` and
`SpendingPolicy` types, the evaluator, the `local` adapter, and the wiring into
`createX402PaymentSigner` (`src/x402/client.ts:339`). The `mpc-2p` adapter is
M6-1+ in a separate repo; §4.6 and §5 define the contract it must satisfy.

---

## 2. Problem statement

### 2.1 The two-strength asymmetry (verified)

kawasekit already enforces *something* at sign time and *something* at fetch time,
but the type system treats them identically — both are "a way to constrain a
payment" — when their security properties are opposite.

| Primitive | Where it runs | Bypassable? | Today's status |
|---|---|---|---|
| `maxAmountPerSign` ceiling | inside `sign()` — `src/x402/client.ts:382-387` | **No** — the agent must call `sign()` to get a signature, and the check precedes the signature | M5-2, threat 1.14 → `⚠️ (with SDK affordance)` |
| `onPayment` guard | inside `wrapFetch()` — `src/x402/fetch.ts:85-88`, called at `:221` | **Yes** — `wrapFetch` is optional; `signer.sign()` is public and callable directly (`src/x402/fetch.ts:326-336`) | H1 |

(Precision, L1: `onPayment` is itself **required at the type level** within
`wrapFetch` — `src/x402/fetch.ts:78`, which "refuses to default to 'always pay'
silently" — so it is not an omittable field. The residual H1 is narrower: `wrapFetch`
*itself* is optional, and a caller holding the signer can call `sign()` directly
(`:326-336`), never reaching the guard. M6-0 targets exactly that residual by moving
enforcement into the signing primitive.)

The asymmetry is the whole problem: a reader of the public API cannot tell, from
the types, that `onPayment` is a *suggestion* and `maxAmountPerSign` is a *rule*.
An integrator who reaches for `onPayment` to enforce a spend limit against a
**hostile or prompt-injected agent** has built a control the agent can step around.

### 2.2 Why "just always use `wrapFetch`" is not the fix

`wrapFetch` is a convenience seam, not a trust boundary. The signer
(`createX402PaymentSigner`, `src/x402/client.ts:339`) holds — directly or
transitively — a viem `Account` (`src/x402/client.ts:118`, `:19`) whose
`signTypedData` produces a valid EIP-3009 authorization
(`src/tokens/eip3009.ts:246-260`). Any code path with that `Account` can sign,
`wrapFetch` or not. As long as **one party holds a key that can sign unilaterally**,
every client-side guard is advisory. This is not a kawasekit bug; it is the
structural property of an EOA-payer scheme (EIP-3009 requires `from` to be an EOA —
`CLAUDE.md` domain note; the new JPYC `transferWithAuthorization` uses `ecrecover`,
no ERC-1271). To make a guard *non-bypassable*, the key itself must not be able to
sign without the gate — i.e. the key must be **split**, and one share must be held
by the policy enforcer. That is the `mpc-2p` adapter. M6-0's job is to build the
**seam** that (a) makes both strengths expressible behind one contract and (b)
prevents the advisory one from masquerading as the enforcing one.

### 2.3 Consequence

Without the seam, M6's cryptographic adapter would bolt onto an API that still
exposes `onPayment` as a peer of real enforcement, and the "owner delegated a
*bounded* authority" claim (kickoff §7 regulatory framing) could be made over a
`local`/advisory signer that does not actually bound anything. The seam must make
that claim **inexpressible** for advisory signers — at the type level, not in prose.

---

## 3. Design constraints (from the codebase + CLAUDE.md, non-negotiable)

Derived from the verified source map and project rules; the design must satisfy
all of them.

1. **EOA-payer is forced; the key-binding layer is the only lever.** EIP-3009
   requires an EOA `from` and pure `ecrecover` (`CLAUDE.md` JPYC note). The seam
   therefore constrains *the signer*, not the token. (kickoff §2.)
2. **Policy semantics live in the SDK, mechanism-independent.** session / cap /
   cumulative / recipient / expiry / revoke / audit are the SDK's "what"; the
   adapter is the "how" (kickoff §3 "policy = what / mechanism = how"). The same
   `SpendingPolicy` + evaluator must run unchanged across adapters.
3. **`local` must be marked advisory and must not be usable where enforcement is
   required.** The seam must not paper over H1 (kickoff §2, §3 line 49). This is a
   **type** obligation, not only a docs obligation.
4. **No blind signing (A4).** The backend/signer recomputes the digest from
   decoded intent fields; it never signs an opaque caller-supplied digest (kickoff
   §3 (A4)). The existing `signTransferWithAuthorization`
   (`src/tokens/eip3009.ts:246-260`) already builds the EIP-712 typed data from
   fields — the seam preserves that and forbids a digest entry point.
5. **No funds custody; the signer is metadata + key authority, never a wallet.**
   A signer holds (a share of) a key and a policy; it does not hold funds
   (`CLAUDE.md` architectural constraint; kickoff §2 non-custodial). Negative
   control (can refuse) without positive control (cannot move funds alone).
6. **Typed result objects in the public API; throws only internally.** `sign()`
   returns `{ ok: true; signature } | { ok: false; rejection }` (`CLAUDE.md`
   TypeScript error-handling rule). Note this *changes* the surface relative to
   `maxAmountPerSign`, which currently **throws** `X402InvalidPayloadError`
   (`src/x402/client.ts:383`) — see §4.4 and §4.7 for the back-compat handling.
7. **Additive, tree-shakeable, named exports, one barrel per subsystem.** New code
   goes in `src/signer/` (the seam + adapters) and `src/policy/` (the
   `SpendingPolicy` data type + evaluator, alongside the existing
   `src/policy/daily-limit.ts`), each with its own `package.json#exports` subpath
   (`./signer`, `./policy`) following `./x402` / `./session` / `./idempotency`
   (verified: `package.json` exports map). The existing
   `createJpycDailyLimitPolicies` (`src/policy/daily-limit.ts:70-110`) is the
   **smart-account / ZeroDev** policy path and is a *sibling*, not a replacement —
   `SpendingPolicy` is the **x402-EOA** path. §4.3 keeps them distinct.
8. **stablecoin-general; do not hardcode JPYC.** The intent and policy are
   token-addressed (`token: Address`, per-token caps), so JPYC is a value, not a
   branch (kickoff §2; `CLAUDE.md` "chain configs are data").
9. **Conventions** (verified, mirror M5-1): `create<Noun>` factories;
   `<Verb><Noun>Params` / `<Verb><Noun>Result`; error classes `extends Error` with
   `this.name` + readonly fields + `{cause}`; `getAddress()` for address
   comparison; decimal strings on the wire, `bigint`/`Address` in the API; never
   log nonces/secrets/signatures (`CLAUDE.md` logging rules).

---

## 4. Architecture

### 4.1 Module layout

```
src/signer/
├── types.ts        # EnforcementLevel, PolicyGatedSigner<E>, PaymentIntent,
│                   #   SignResult, PolicyRejection, SignerDescription
├── gate.ts         # requireNonBypassable() type-gate helper + runtime assert
├── local.ts        # createLocalPolicyGatedSigner -> PolicyGatedSigner<"advisory">
├── errors.ts       # PolicyGatedSignerConfigError
└── index.ts        # barrel (export subpath "./signer")

src/policy/
├── daily-limit.ts  # (existing) ZeroDev smart-account policy — UNTOUCHED
├── spending-policy.ts  # SpendingPolicy (data), SpendState, evaluateSpendingPolicy,
│                       #   createSpendingPolicy, mergeSpendState  (pure, no I/O)
└── index.ts        # barrel (new export subpath "./policy")
```

The `mpc-2p` adapter (`createMpc2pPolicyGatedSigner -> PolicyGatedSigner<"cryptographic">`)
is **not** in this tree — it lives in the separate Go-backed repo (kickoff §9). It
realizes the same `PaymentIntent` / `SignResult` contract, so the SDK consumer's
code is identical across adapters (§4.6); **the contract is deliberately
topology-agnostic**. Whether the adapter's TypeScript side is a *thin transport*
(the agent forwards the intent and receives a signature) or a *full MPC
participant* (the agent holds a 2-of-2 share and runs the signing rounds with the
Go co-signer) depends on the share-split topology, which this RFC does **not**
settle — it is the first unknown the M6-1 feasibility spike resolves (kickoff
gap 1: cross-language MPC participation, TS agent ↔ Go `tss-lib`). M6-0 ships only
`types.ts` + `gate.ts` + `local.ts` + `spending-policy.ts` + the x402 wiring (§4.7);
none of it depends on that topology.

### 4.2 The seam: `PolicyGatedSigner<E>` (enforcement as a type parameter)

```ts
export type EnforcementLevel =
  | "advisory"      // a single party holds a key that can sign without the gate (local)
  | "cryptographic" // key split; no valid signature without a policy-passing co-sign (mpc-2p)
  | "hardware"      // enclave-sealed key + policy (tee — reserved)
  | "integrator";   // delegated to the integrator's HSM/KMS (byo — reserved)

export interface PolicyGatedSigner<E extends EnforcementLevel = EnforcementLevel> {
  /** First-class, visible enforcement strength. Covariant in E → drives the type-gate. */
  readonly enforcement: E;
  /** The EOA whose authorization this signer produces (intent.from must equal this). */
  readonly from: Address;
  /** Sign iff owner policy approves the decoded intent; never throw on a policy denial. */
  sign(intent: PaymentIntent): Promise<SignResult>;
  /** Non-secret description for audit/telemetry: enforcement, from, policy id+expiry, revoked. */
  describe(): SignerDescription;
}
```

`E` appears in the covariant `readonly enforcement: E` position, so
`PolicyGatedSigner<"advisory">` is **not assignable** to
`PolicyGatedSigner<"cryptographic" | "hardware">`. That single fact is the
type-gate (§4.5).

### 4.3 `PaymentIntent` — decoded, never a digest (A4)

No `PaymentIntent` type exists today (verified — the closest are
`X402PaymentRequirements`, `src/x402/types.ts:128-136`, the *advertised* wire
shape, and `TransferWithAuthorizationMessage`, `src/tokens/eip3009.ts:40-48`, the
*signed* message). M6-0 introduces `PaymentIntent` as the policy-evaluable,
digest-recomputable intent — the decoded EIP-3009 message plus the
`verifyingContract` (`token`) and `chainId`. It deliberately does **not** carry the
EIP-712 domain `name`/`version`: those are **not** caller-supplied (that would
reopen A4) — they are resolved from a trusted pinned config (see the Contract
below), because the digest cannot be recomputed without them:

```ts
export interface PaymentIntent {
  readonly token: Address;       // EIP-712 verifyingContract (the JPYC/USDC contract)
  readonly chainId: number;      // EIP-712 domain chainId — pins cross-chain replay
  readonly from: Address;        // EIP-3009 authorizer (must equal signer.from)
  readonly to: Address;          // recipient
  readonly value: bigint;        // amount, token base units
  readonly validAfter: bigint;   // EIP-3009 window start (unix seconds)
  readonly validBefore: bigint;  // EIP-3009 window end / expiry
  readonly nonce: Hex;           // EIP-3009 32-byte nonce (from M5; see §4.8)
}
```

**Contract:** an adapter MUST construct the EIP-712 `TransferWithAuthorization`
typed data from the decoded intent fields (`src/tokens/eip3009.ts:76-85` types) and
sign the resulting digest; it MUST NOT accept or sign a pre-computed digest. The
EIP-712 **domain** `{name, version, chainId, verifyingContract}` is completed by
resolving `{name, version}` from a **trusted, pinned `(token, chainId) → (name,
version)` config** — mirroring how the current signer pins via `resolveAssetParam`
(`src/tokens/asset-domain.ts:85`, lifted from `client.ts` in M6-0 and reused by both
sign paths) — and **never** from the
advertised `requirements.extra` (`src/x402/types.ts:124-126`), which is untrusted
producer input. The adapter MUST additionally **reject** an intent whose `token` ≠
the signer's pinned `verifyingContract`, carrying forward the existing
misadvertised-domain defense (`src/x402/client.ts:376-380`); otherwise a malicious
resource server could coerce a signature over an unintended domain (EIP-712
"misadvertised domain", checklist §2). So **A4 = recompute the digest from the
decoded intent fields *plus* the trusted pinned domain, never from advertised domain
material.** This lets the policy evaluate `to`/`value`/`token`/`validBefore` and
*know the signature is over exactly those fields*. (kickoff §3 (A4): "盲署名の禁止".)

For `mpc-2p`, the same rule is load-bearing on the **backend** side: the co-signer
receives the decoded intent, **recomputes** the digest, evaluates policy, and only
then contributes its share (kickoff §3 mpc-2p flow). A client that sent only a
digest could not be policy-checked — hence decoded-only.

### 4.4 `SpendingPolicy` (policy-as-data) + one pure *check* evaluator (two conformant impls)

```ts
export interface SpendingPolicy {
  readonly version: "1";
  readonly session: { readonly id: string; readonly notAfter: bigint }; // expiry (unix s)
  /** Per-token limits. A token absent from the map is NOT allowed (closed by default). */
  readonly perToken: readonly TokenLimit[];
  /** Required (no silent allow-open, M2): "any" = unrestricted, [] = deny-all, [...] = allowlist. */
  readonly recipientAllowlist: readonly Address[] | "any";
  readonly revoked: boolean;
}
export interface TokenLimit {
  readonly token: Address;
  readonly maxPerSign: bigint;        // generalizes maxAmountPerSign (threat 1.14)
  readonly cumulativeCap?: bigint;    // total across the session; undefined = uncapped
}
/** Cross-call spend state (cumulative). Injected, never module-global (mirrors the store pattern). */
export interface SpendState { readonly spentPerToken: readonly { token: Address; spent: bigint }[]; }

export type PolicyDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: PolicyRejection };

/** Pure, deterministic, no I/O — the CHECK only (the cumulative-cap *commit* is the adapter's
 *  atomic job, §4.6). ONE spec, TWO conformant impls: this TS fn (local) + a Go port (mpc-2p,
 *  separate repo). Parity is engineered via the B8 cross-language conformance corpus (§6),
 *  NOT assumed — see kickoff A1. */
export function evaluateSpendingPolicy(
  policy: SpendingPolicy,
  intent: PaymentIntent,
  state: SpendState,
  nowSeconds: bigint,
): PolicyDecision;
```

Evaluation order (deny-closed; first failing check wins):

1. `revoked` → `revoked`
2. `nowSeconds > session.notAfter` → `expired`
3. `intent.validBefore > session.notAfter` → `expired` (the authorization must not
   outlive the session)
4. token not in `perToken` → `token_not_allowed`
5. `recipientAllowlist !== "any"` and `intent.to` not in it (compare via
   `getAddress`; `[]` = deny-all) → `recipient_not_allowed`
6. `intent.value > limit.maxPerSign` → `amount_exceeds_per_sign`
7. `spent(token) + intent.value > limit.cumulativeCap` → `amount_exceeds_cumulative`
8. else `{ ok: true }`

`maxAmountPerSign` (M5-2) is exactly the degenerate one-token, `maxPerSign`-only
`SpendingPolicy`. M6-0 makes the ceiling a special case of policy-as-data, and the
evaluator returns a **typed decision** instead of throwing (constraint 6).

**The evaluator is check-only; the cumulative-cap *commit* must be atomic (H3).**
`evaluateSpendingPolicy` *reads* `SpendState` but never mutates it. For a
`cumulativeCap` the enforcement point MUST perform the *check and the
spend-increment as one atomic step* — otherwise parallel agent tool-calls (LLM
fan-out, checklist §5) race: two concurrent `sign()` calls each read `spent < cap`,
both pass, both commit, and the cap is exceeded (a TOCTOU, the same race class the
M5 *leased* idempotency store solved). Authoritative `SpendState` ownership and this
atomicity requirement are part of the adapter contract — see §4.6. The `local`
adapter intentionally provides neither (its `cumulativeCap` is best-effort,
caller-managed — see §4.6).

`SignResult` / `PolicyRejection`:

```ts
export type SignResult =
  | { readonly ok: true;  readonly signature: Hex; readonly intent: PaymentIntent }
  | { readonly ok: false; readonly rejection: PolicyRejection };

export interface PolicyRejection {
  readonly reason:
    | "revoked" | "expired"
    | "token_not_allowed" | "recipient_not_allowed"
    | "amount_exceeds_per_sign" | "amount_exceeds_cumulative"
    | "intent_digest_mismatch"   // A4: recomputed digest ≠ what was asked (mpc-2p backend)
    | "unauthenticated"          // A3: co-sign request not authenticated (mpc-2p)
    | "from_mismatch";           // intent.from ≠ signer.from
  readonly detail: string;       // human-readable; MUST NOT contain the nonce or signature
}
```

`intent_digest_mismatch` and `unauthenticated` are **never produced by the `local`
adapter** (it has no remote request and trivially "recomputes" its own digest);
they exist in the shared type because the `mpc-2p` backend produces them, and the
SDK consumer handles one `SignResult` regardless of adapter. This is intentional:
the *consumer code is adapter-agnostic*; only the enforcement strength changes.

### 4.5 The enforcement-level type-gate (makes H1 *closable*; prevents advisory-for-enforcing substitution)

The headline mechanism. A flow that must not run on a bypassable signer requires a
**non-bypassable** enforcement level:

```ts
/** Enforcement levels whose policy a single key-holder CANNOT bypass. */
export type NonBypassableEnforcement = Exclude<EnforcementLevel, "advisory" | "integrator">;
//        = "cryptographic" | "hardware"

/** Compile-time gate: accepts only a non-bypassable signer; advisory/local fails to typecheck. */
export function requireNonBypassable<E extends NonBypassableEnforcement>(
  signer: PolicyGatedSigner<E>,
): PolicyGatedSigner<E> {
  return signer;
}
```

```ts
const local = createLocalPolicyGatedSigner({ account, policy });   // PolicyGatedSigner<"advisory">
const coSign = createMpc2pPolicyGatedSigner({ /* ... */ });        // PolicyGatedSigner<"cryptographic">

requireNonBypassable(coSign);   // ✅ ok
requireNonBypassable(local);    // ❌ compile error: "advisory" not assignable to
                                //    "cryptographic" | "hardware"
```

An integrator's bounded/regulated endpoint types its dependency as
`PolicyGatedSigner<NonBypassableEnforcement>` (or calls `requireNonBypassable`),
and **wiring a `local` signer into it is a build failure**. This is the structural
closure of the *substitution hazard* — an advisory guard can no longer be silently
substituted for an enforcing one. It is **not** a closure of H1 itself (the
*agent-bypass* threat); that needs a shipped `cryptographic` adapter to exist and be
wired (see §1 and the front-matter "affordance, not closure" note). In M6-0,
`requireNonBypassable` is satisfiable by no shipped adapter — its positive direction
is locked by a type-level fixture (§6) until `mpc-2p` ships.

For JS consumers without types (and as defense-in-depth), a **runtime** mirror is
also provided:

```ts
/** Throws PolicyGatedSignerConfigError if the signer is not non-bypassable. Internal-throw is allowed here (not a policy denial). */
export function assertNonBypassable(signer: PolicyGatedSigner): asserts signer is PolicyGatedSigner<NonBypassableEnforcement>;
```

The type-gate is primary (catches the error at build time); the runtime assert is
the backstop for un-typed call sites and for `createX402PaymentSigner`'s optional
`requireEnforcement` guard (§4.7).

### 4.6 Adapter contract

| adapter | factory → return type | enforcement | bypassable? | M6 status |
|---|---|---|---|---|
| `local` | `createLocalPolicyGatedSigner(p): PolicyGatedSigner<"advisory">` | advisory | **yes** (holder of `account` can sign directly) | **M6-0 (this RFC)** |
| `mpc-2p` | `createMpc2pPolicyGatedSigner(p): PolicyGatedSigner<"cryptographic">` | cryptographic | no (2-of-2; co-sign gated) | M6-1+ (separate repo) — contract fixed here |
| `tee` | reserved | hardware | no | reserved interface slot only |
| `kms/byo` | reserved | integrator | (integrator-defined) | reserved interface slot only |

**`local` adapter (M6-0).** Wraps a viem `Account` (`src/x402/client.ts:19`,
`:118`) + a `SpendingPolicy` + an injected `SpendState` source. `sign(intent)`:

1. assert `getAddress(intent.from) === this.from` else `from_mismatch`; assert
   `intent.token` equals the signer's **pinned** `verifyingContract` else
   `token_not_allowed` (the misadvertised-domain reject, carrying
   `src/x402/client.ts:376-380`);
2. `evaluateSpendingPolicy(policy, intent, state, now)` → on `{ok:false}` return
   `{ ok:false, rejection }` (no signature produced);
3. on `{ok:true}` resolve `{name, version}` from the **pinned** `(token, chainId)`
   config (never advertised), build the EIP-712 typed data from `intent` + that
   trusted domain, and sign via the existing
   `signTransferWithAuthorization(account, domain, message)` path
   (`src/tokens/eip3009.ts:246-260`) → `{ ok:true, signature, intent }`. The
   injected `SpendState` here is single-process / in-memory (same scope caveat as
   the idempotency store).

It is **advisory** because step 1–3 are only reached if the caller chooses to call
*this* `sign()`; the underlying `account` can still sign anything elsewhere. The
factory's JSDoc states this in one sentence, the return type `<"advisory">`
enforces it through the type-gate, and the **required `acknowledgeAdvisory: true`**
(§9 Q1) makes the advisory choice a conscious, greppable act for JS consumers too.
`local` is for **dev, A1 cross-language
fallback, and any flow that is explicitly not bounded/regulated** (kickoff §3).

**`local` and the cumulative cap (best-effort, caller-managed).** The injected
`spendState` is a **read-only view** the adapter evaluates `cumulativeCap`
against; the `local` adapter does **not** own an authoritative ledger and does
**not** perform an atomic check-and-commit. The caller is responsible for folding a
successful spend back into the injected state (e.g. via `mergeSpendState`) before
the next call. Two consequences, both acceptable for an advisory signer and stated
so they do not surprise: (a) if the injected state is not updated between calls,
`cumulativeCap` is not enforced across calls; (b) because the *check* (adapter) and
the *spend-commit* (caller-side) are separate steps, concurrent `sign()` calls can
race past the cap — the in-process analog of the H3 TOCTOU (§4.4). **Atomic,
authoritative cumulative enforcement is a property of the `cryptographic` adapter
only** (its backend owns the ledger and commits atomically, see the `mpc-2p`
contract below). For `local`, `cumulativeCap` is therefore a *best-effort* bound,
consistent with `local`'s advisory nature — its policy is a request, not a
guarantee (§1).

**`mpc-2p` adapter (contract this RFC fixes; built M6-1+).** Must:
- return `PolicyGatedSigner<"cryptographic">`;
- recompute the digest backend-side from the decoded intent **plus a trusted
  `(token, chainId) → (name, version)` domain registry** (the backend's analog of
  the signer's pinned domain; H1) → a digest mismatch yields
  `intent_digest_mismatch`, and a `token` absent from the registry yields
  `token_not_allowed`; in both cases no share is contributed (A4 +
  misadvertised-domain reject);
- authenticate the co-sign request (A3, §4.9) → failure yields `unauthenticated`;
- re-evaluate the policy with a **Go port conformant to the TS `evaluateSpendingPolicy`**,
  verified against the shared **B8 cross-language conformance corpus + pinned
  canonical encoding** (§6); the **backend verdict is authoritative** (H2);
- own the **authoritative per-session `SpendState` ledger** and **ignore any
  client-supplied state**, and perform cumulative-cap **check-and-commit atomically**
  so parallel co-sign requests cannot race past the cap (H3);
- treat a co-sign request that re-presents a **previously-seen nonce with different
  intent fields** as a fund-correctness anomaly → deny + audit (B7, §4.8);
- on policy pass, contribute its 2-of-2 share so the combined signature is a valid
  EOA ECDSA signature (`ecrecover` verifies the EOA);
- hold key-share + policy but **no funds** (non-custodial); support owner
  `revoke` = stop co-signing (immediate, no on-chain uninstall);
- carry its own threat model through `web3-cto-review` (kickoff §8 TSS section),
  including the hardening checklist — **note: key extraction defeats the policy
  layer entirely** (kickoff §8 "鍵抽出は policy 層を突破する"), so crypto
  correctness is load-bearing and defense-in-depth does not save this class.

The seam guarantees the SDK consumer's code is identical across `local` and
`mpc-2p` except for the factory call and the enforcement type — the whole point.

### 4.7 Wiring into `createX402PaymentSigner`

Today `createX402PaymentSigner` takes `{ network, account: Account, asset,
defaultLifetimeSeconds?, maxAmountPerSign? }` (`src/x402/client.ts:104-149`) and,
inside `sign()`, builds the `TransferWithAuthorizationMessage`, enforces
`maxAmountPerSign` (`:382-387`), and calls `signTransferWithAuthorization`
(`:410-426`). M6-0 adds an **alternative, additive** construction that accepts a
`PolicyGatedSigner` instead of a raw `account`:

```ts
// additive overload / discriminated params — back-compat, the account path is unchanged
export type CreateX402PaymentSignerParams =
  | { /* existing */ readonly account: Account; readonly maxAmountPerSign?: bigint; /* network, asset, ... */ }
  | { readonly signer: PolicyGatedSigner; /* network, asset, ...; no maxAmountPerSign (subsumed by policy) */
      readonly requireEnforcement?: NonBypassableEnforcement /* runtime assert at construction */ };
```

When given a `signer`, `createX402PaymentSigner.sign()`:

1. builds a `PaymentIntent` from the resolved `X402PaymentRequirements`
   (`src/x402/types.ts:128-136`: `asset → token`, `amount → value`, `payTo → to`,
   `network → chainId`) + `signer.from` + `validAfter`/`validBefore` (today's
   window, `src/x402/client.ts:389-391`) + `nonce` (§4.8). It **pins** `token` to the
   configured asset and **rejects** an advertised `asset` that doesn't match
   (carrying `src/x402/client.ts:376-380`), and resolves the EIP-712 domain
   `{name, version}` from the trusted pinned config — never from advertised `extra`
   (H1, §4.3);
2. calls `await signer.sign(intent)`;
3. maps `SignResult` onto the existing `X402PaymentSigner` return: `{ok:true}` →
   the same signed payload as today; `{ok:false}` → a typed signer error carrying
   `rejection` (the public surface keeps returning the project's result-object
   shape; internally an `X402PolicyRejectedError extends Error` may be thrown only
   across the internal boundary, never leaking funds).

**Back-compat for `maxAmountPerSign`:** the existing `account` path keeps its throw
(`src/x402/client.ts:383`) verbatim — no behavior change for current users. The new
`signer` path expresses the ceiling as a one-token `SpendingPolicy.maxPerSign` and
surfaces it as a typed `amount_exceeds_per_sign` rejection. Both reach the same
outcome; the RFC does not migrate existing callers.

**Drop-in alternative (advisory only).** For integrators who want the existing
`account` ergonomics with a `local` policy, the seam offers an adapter from
`PolicyGatedSigner<"advisory">` to a viem `Account` (implement `signTypedData` by
routing through `sign(intent)`, throwing on rejection). This is **advisory by
construction** and is offered only for the `local` case — it deliberately cannot
upgrade enforcement, so it cannot be used to smuggle a `local` signer into a
bounded flow (the type-gate still sees an `Account`, not a non-bypassable signer).

### 4.8 The nonce / idempotency boundary (B7)

The `PaymentIntent.nonce` is supplied to `sign()`; the signer **does not generate
or mutate it**. Ownership split:

- **No-double-pay** is M5's domain: `deriveAuthorizationNonce`
  (`src/tokens/eip3009.ts:157-172`) makes a re-signed *same intent* collide on the
  same bytes32 nonce, and the token contract's `authorizationState` rejects the
  second settle on-chain; `generateAuthorizationNonce`
  (`src/tokens/eip3009.ts:122-126`) is the random default.
- **Is-this-allowed** is M6's domain: `evaluateSpendingPolicy`. It is **nonce-blind**
  — two distinct payments with distinct nonces are each evaluated on their own
  merits, and the cumulative cap (state) is what bounds a *sequence* of allowed
  payments.

The boundary the `mpc-2p` backend must respect (and audit): a co-sign request that
re-presents a **previously-seen nonce with different intent fields** is a
fund-correctness anomaly (someone is trying to reuse a nonce for a different
payment) and MUST be denied + logged. M6-0 records this as the contract; the
mechanism is M6-2. Spend-policy enforcement and double-pay enforcement compose;
neither subsumes the other (kickoff §3 (B7)).

### 4.9 Request authentication (A3) — carrier in the seam, realized in mpc-2p

"Who is asking" ≠ "what is allowed." For `local` there is no remote request, so A3
is N/A; but the *seam* must let an adapter that has a remote boundary authenticate
the caller and bind it to a specific key-share + policy. M6-0 reserves an optional
opaque `auth` carrier on the adapter construction (not on the per-call `sign`,
which stays intent-only to keep A4 clean):

```ts
// mpc-2p factory (separate repo) — shape reserved by the seam:
// createMpc2pPolicyGatedSigner({ endpoint, auth: CoSignAuth /* token | mTLS material */, ... })
```

The `local` adapter ignores `auth`. The `mpc-2p` adapter (M6-2) authenticates every
co-sign request (token/mTLS), returns `unauthenticated` on failure, and never lets
authentication stand in for authorization (a valid caller still passes the full
policy evaluation). A3 and policy are orthogonal layers.

---

## 5. Threat model (M6-0 seam)

The seam is a trust-boundary primitive; it earns a threat-model section even though
M6-0 ships no crypto. The full TSS treatment is the `mpc-2p` adapter's own threat
model (kickoff §8); here we cover the seam.

| # | Threat | Seam treatment |
|---|---|---|
| S1 | **Hostile / prompt-injected agent** calls `sign()` with an out-of-policy intent | Deny-closed evaluator (§4.4); typed rejection, no signature. The **agent is untrusted**; **owner policy is the trust boundary**. |
| S2 | Agent **bypasses** the gate by holding the raw key (H1) | For `local`: acknowledged — `enforcement:"advisory"`, type-gated out of bounded flows (§4.5). For `mpc-2p`: impossible without the co-sign share (cryptographic). **`local` is explicitly NOT a trust boundary.** |
| S3 | Agent submits an **opaque digest** to get a signature over an unevaluated payment | Forbidden: `sign()` takes decoded intent only; digest recomputed (A4, §4.3). `mpc-2p` backend yields `intent_digest_mismatch`. |
| S4 | Caller sets `intent.from` ≠ the signer's EOA to spoof authorizer | `from_mismatch` rejection (§4.6 step 1). |
| S5 | **Key extraction** from the `mpc-2p` share store reconstructs the EOA key | **Out of the policy layer's reach** — defeats the gate entirely (kickoff §8). Crypto correctness is load-bearing; mitigated only by the §8 hardening + audit, *not* by this seam. Documented, not papered over. |
| S6 | Unauthenticated party solicits a co-sign | `unauthenticated` (A3, §4.9) — mpc-2p only. |
| S7 | **Custody creep** — does holding share+policy make the signer a fund custodian? | Non-custodial invariant (§4.6): share+policy, **no funds**; negative control only. Regulatory framing is kickoff §7; **third-party operation needs expert review before launch** (kickoff §7) — out of scope for M6-0 (local self-signs). |
| S8 | Nonce reuse for a different payment (double-pay vector) | Out of the policy layer (B7, §4.8); owned by M5 derived-nonce + on-chain `authorizationState`. Seam denies+audits the anomaly on the mpc-2p path. |

**Negative-control acceptance test (DoD):** with `revoked: true` (or
`now > session.notAfter`), `sign()` of any intent returns `{ok:false}` with the
corresponding reason and **produces no signature** — the signer can *stop* but, for
`local`, cannot itself *move* funds (it never held them), and for `mpc-2p` cannot
move them alone (2-of-2).

---

## 6. Conformance & tests (B8)

1. **Cross-language decision parity (the B8 conformance test).** A shared,
   language-neutral **fixture corpus** of `(policy, intent, state, now) →
   PolicyDecision` vectors is checked into both repos and run through **both**
   implementations — the TS `evaluateSpendingPolicy` (M6-0) and the Go backend port
   (M6-2) — asserting **byte-identical** decisions against a **pinned canonical
   encoding** (decimal-string `bigint`, checksummed `Address`, fixed `perToken`
   order, explicit allowlist semantics). "advisory" vs "cryptographic" must differ
   only in bypassability, never in the allow/deny verdict; the parity is
   *engineered*, not assumed (kickoff A1). M6-0 ships the TS evaluator + the corpus +
   the encoding spec; the Go side joins the corpus at M6-2.
2. **Evaluator unit matrix.** Each rejection reason + each boundary
   (`value == maxPerSign`, `spent+value == cumulativeCap`,
   `validBefore == session.notAfter`, `[]` (deny-all) vs `"any"` allowlist, address
   checksum mismatch) has a colocated `*.test.ts`.
3. **Type-gate test (both directions).** A `// @ts-expect-error` asserting
   `requireNonBypassable(localSigner)` does **not** compile (the *negative*
   direction — `local` is rejected), **and** a positive type-level fixture —
   `declare const fake: PolicyGatedSigner<"cryptographic">; requireNonBypassable(fake)`
   — must compile, so the gate's *pass* direction is locked even though M6-0 ships no
   non-bypassable adapter. This is the fixture §1 and §4.5 reference; it puts the
   *substitution-hazard closure* itself under test (mirrors M5's "✅ needs a test"
   discipline). The `tsc --strict` confirmation in `web3-cto-review` pass 1
   exercised exactly these two directions.
4. **Negative controls.** revoked / expired / from_mismatch / digest mismatch
   (stubbed) → no signature.
5. **4-point gate** (`pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build`)
   green (pre-push gate, `pre-push-verification-gate` discipline).

---

## 7. Definition of Done (M6-0 slice of the kickoff DoD)

- `PolicyGatedSigner<E>` seam exported (`./signer`), `enforcement` visible, the
  `requireNonBypassable` type-gate compiles-green for `mpc-2p` and **fails for
  `local`** (test 3).
- `SpendingPolicy` + `evaluateSpendingPolicy` exported (`./policy`), pure, deny-closed.
- `local` adapter signs via the existing EIP-3009 path, returns typed `SignResult`,
  never blind-signs, marked advisory.
- `createX402PaymentSigner` accepts a `PolicyGatedSigner` (additive; `account`
  path unchanged; `maxAmountPerSign` expressible as one-token policy).
- Threat-model §5 negative-control test passes.
- B8 conformance fixtures + SDK-side parity test in place (mpc-2p half deferred to
  M6-2).
- This slice is **mechanism-independent** and does not touch the GA soak.

---

## 8. Out of scope (M6-0) / future

- **The `mpc-2p` adapter itself** (DKG, 2-of-2 ECDSA, transport/A2, co-sign gate,
  audit log, revocation mechanism) — M6-1+ in the separate Go repo, separate RFC;
  this RFC fixes the contract (§4.6, §4.8, §4.9) it must satisfy. The TSS hardening
  (kickoff §8) is that RFC's burden, not this one's.
- **`tee` / `byo` adapters** — reserved interface slots; not built (kickoff §4 Out).
- **Cumulative cap across processes / persistence** — `SpendState` is injected; a
  durable shared `SpendState` store (Redis/SQL) mirrors the idempotency store and is
  future work. M6-0's in-memory `SpendState` is single-process (the same scope
  caveat the idempotency store carries).
- **Audit log schema** — M6-2 (the seam's `describe()` is the M6-0 stub).
- **ERC-8004 identity / bidirectional A2A** — keep-open (kickoff §4); the seam
  carries no identity claim that would conflict with a later adopt.
- **Regulatory sign-off on share+policy custody** — kickoff §7; required before
  third-party `mpc-2p` operation, not before M6-0 (local self-signs).

---

## 9. Open questions for reviewers

1. **Type-gate ergonomics vs. JS consumers — RESOLVED (require `acknowledgeAdvisory`).**
   The compile-time gate (`E` covariant) is invisible to plain-JS integrators, so
   `createLocalPolicyGatedSigner` **requires** a literal `acknowledgeAdvisory: true`
   (`CreateLocalPolicyGatedSignerParams`, Appendix A): omitting it is a compile error
   in TS and a construction-time **throw** (`PolicyGatedSignerConfigError`) in JS, so
   *constructing* an advisory signer is a conscious, **greppable** act for both
   audiences. This complements the type-gate (§4.5) and the runtime
   `assertNonBypassable` / `createX402PaymentSigner({ requireEnforcement })` backstop,
   and matches the project's existing "deliberate opt-in" convention (the `onPayment`
   `() => true`, `src/x402/fetch.ts:81`). The minor one-time friction on the dev/A1
   path is accepted in exchange for footgun safety.
2. **`SignResult` vs. throw at the `createX402PaymentSigner` boundary.** §4.7 keeps
   the result-object internally but must surface a denial to existing
   `X402PaymentSigner` callers who today get a *throw* from `maxAmountPerSign`. Do
   we (a) keep throwing on the `signer` path for surface-compat, or (b) introduce a
   result-returning sign entrypoint and deprecate the throw? (b) is cleaner but a
   larger surface change near GA-adjacent code.
3. **Where does `validAfter`/`validBefore` come from on the `signer` path?** M6-0
   reuses the signer's `Date.now()` window (`src/x402/client.ts:389-391`). For `mpc-2p`,
   should the **backend** be allowed to tighten `validBefore` (shorter expiry =
   smaller settle-reorg / replay window) as a policy output, or must it sign exactly
   the client's window (stricter A4)? Leaning: backend may *narrow* but never widen,
   and a narrow is reflected back in `SignResult.intent`.
4. **`SpendState` trust on the `mpc-2p` path — RESOLVED in §4.6 (was open).** The
   authoritative `SpendState` is the **backend's**; §4.6 now states `mpc-2p` ignores
   any client-supplied state and uses its own ledger, with **atomic** cumulative-cap
   check-and-commit (H3, also §4.4). M6-0's injected `SpendState` is `local`-only and
   single-process. Retained here as the resolution record, not an open question.

---

## Appendix A — public API sketch (for review; not final)

```ts
// src/signer/types.ts  (export subpath "./signer")
export type EnforcementLevel = "advisory" | "cryptographic" | "hardware" | "integrator";
export type NonBypassableEnforcement = Exclude<EnforcementLevel, "advisory" | "integrator">;

export interface PaymentIntent {
  readonly token: Address; readonly chainId: number;
  readonly from: Address; readonly to: Address; readonly value: bigint;
  readonly validAfter: bigint; readonly validBefore: bigint; readonly nonce: Hex;
}

export interface PolicyRejection {
  readonly reason:
    | "revoked" | "expired" | "token_not_allowed" | "recipient_not_allowed"
    | "amount_exceeds_per_sign" | "amount_exceeds_cumulative"
    | "intent_digest_mismatch" | "unauthenticated" | "from_mismatch";
  readonly detail: string; // never contains nonce/signature
}
export type SignResult =
  | { readonly ok: true;  readonly signature: Hex; readonly intent: PaymentIntent }
  | { readonly ok: false; readonly rejection: PolicyRejection };

export interface SignerDescription {
  readonly enforcement: EnforcementLevel; readonly from: Address;
  readonly policyId: string; readonly notAfter: bigint; readonly revoked: boolean;
}
export interface PolicyGatedSigner<E extends EnforcementLevel = EnforcementLevel> {
  readonly enforcement: E; readonly from: Address;
  sign(intent: PaymentIntent): Promise<SignResult>;
  describe(): SignerDescription;
}

// src/signer/gate.ts
export function requireNonBypassable<E extends NonBypassableEnforcement>(
  s: PolicyGatedSigner<E>): PolicyGatedSigner<E>;
export function assertNonBypassable(
  s: PolicyGatedSigner): asserts s is PolicyGatedSigner<NonBypassableEnforcement>;

// src/signer/local.ts
export interface CreateLocalPolicyGatedSignerParams {
  readonly account: Account; readonly policy: SpendingPolicy;
  readonly acknowledgeAdvisory: true; // REQUIRED literal — omit = compile error (TS) + throw (JS); §9 Q1
  readonly spendState?: () => SpendState | Promise<SpendState>; // injected read-only view; default empty. cumulativeCap is best-effort for local — §4.6
}
export function createLocalPolicyGatedSigner(
  p: CreateLocalPolicyGatedSignerParams): PolicyGatedSigner<"advisory">;

// src/policy/spending-policy.ts  (export subpath "./policy")
export interface TokenLimit { readonly token: Address; readonly maxPerSign: bigint; readonly cumulativeCap?: bigint; }
export interface SpendingPolicy {
  readonly version: "1";
  readonly session: { readonly id: string; readonly notAfter: bigint };
  readonly perToken: readonly TokenLimit[];
  readonly recipientAllowlist: readonly Address[] | "any";
  readonly revoked: boolean;
}
export interface SpendState { readonly spentPerToken: readonly { token: Address; spent: bigint }[]; }
export type PolicyDecision = { readonly ok: true } | { readonly ok: false; readonly rejection: PolicyRejection };
export function evaluateSpendingPolicy(
  policy: SpendingPolicy, intent: PaymentIntent, state: SpendState, nowSeconds: bigint): PolicyDecision;
export function createSpendingPolicy(p: /* validated init */ unknown): SpendingPolicy;

// src/x402/client.ts (additive) — CreateX402PaymentSignerParams gains a { signer } variant (§4.7)
```

## Appendix B — verified source anchors

Anchors **re-verified against the implemented tree** (current `main`, post-M6-0;
L2). Line numbers shifted from v1 where M6-0 added code; `resolveAssetParam` was
lifted to `src/tokens/asset-domain.ts`; `PaymentIntent` now exists.

| Claim | Anchor (current `main`) |
|---|---|
| `createX402PaymentSigner` factory (branches account / signer) | `src/x402/client.ts:293`; account-arm `CreateX402PaymentSignerAccountParams` `:70`, signer-arm `CreateX402PaymentSignerSignerParams` `:126`; `account:Account` `:84` |
| viem `Account` import | `src/x402/client.ts:19` |
| `maxAmountPerSign` ceiling — **non-bypassable**, inside `sign()`, throws (account path) | `src/x402/client.ts:339` |
| `validBefore` from `Date.now()` window (account path) | `src/x402/client.ts:346-348` |
| EIP-3009 signature production in the signer (account path) | `src/x402/client.ts:367-385` |
| `onPayment` guard — **bypassable**, advisory | `src/x402/fetch.ts:85-88`; `WrapFetchParams` `:51-110`; invoked only at `:221`; direct-`sign()` bypass example `:326-336` |
| asset-domain pinning (`X402AssetParam` / `resolveAssetParam`, **lifted M6-0**) | `src/tokens/asset-domain.ts:50` / `:85`; `ResolvedAsset` `:73`; re-exported from `src/x402/client.ts:61` |
| `TransferWithAuthorizationMessage` (intent fields) | `src/tokens/eip3009.ts:40-48` |
| EIP-712 `TransferWithAuthorization` type | `src/tokens/eip3009.ts:76-85` |
| `generateAuthorizationNonce` (random) | `src/tokens/eip3009.ts:122-126` |
| `deriveAuthorizationNonce` (M5, deterministic) | `src/tokens/eip3009.ts:157-172` |
| `signTransferWithAuthorization` (builds typed data from fields, never a digest) | `src/tokens/eip3009.ts:246-260` |
| `requireSignTypedData(account)` capability check | `src/tokens/eip3009.ts:193` |
| `X402PaymentRequirements` (advertised wire shape → intent fields) | `src/x402/types.ts:128-136` |
| ZeroDev smart-account policy (sibling, not replaced) | `src/policy/daily-limit.ts:70-110` |
| `PaymentIntent` type — **shipped by M6-0** (no longer absent) | `src/signer/types.ts:57` |
| export-subpath convention (now incl. `./signer` `./policy`) | `package.json#exports` (`./signer`, `./policy` added) |
| design-first + Plan Mode obligation for `src/policy/` | `CLAUDE.md` Design Review Discipline; spec `.claude/m6-kickoff.md` §3–§8 |
