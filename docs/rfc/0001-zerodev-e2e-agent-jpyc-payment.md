# RFC-0001 — ZeroDev E2E: Agent JPYC Payment on Amoy (session-key userOp settlement)

| | |
|---|---|
| **Status** | Draft v2 — web3-cto-review pass 1 applied (2026-06-16). **Sprint 1** CLOSED: H1 (validation-vs-paymaster discriminator), H2 (issuance trust model — `addressToEmptyAccount` not used), H3 (x402 descoped), M1 (idempotency scoped), M3 (rate-limit no-reset → unit-asserted), L1/L3. **Sprint 2** CLOSED: M2 (funding preflight), L2 (independent `typecheck:rfc0001`/`test:rfc0001` gate). Deferred: M4 (`createSponsoredKernelClient` SDK gap G1) → Sprint 3 (SDK change). Pending owner approval. |
| **Author** | k0yote |
| **Date** | 2026-06-16 |
| **Realizes** | STATUS step 3 (ZeroDev e2e on testnet — #1 de-risk) |
| **Anchored to** | `agent-commerce-hub-reference-architecture.md` §1 (L1), §2 (L2), §3 (L3), §5 scope table; decision log D6 (native sponsor-gas) |
| **SDK baseline** | `k0yote/kawasekit` `0.7.0` (`createBuyListPolicies` merged); ZeroDev Kernel v3.1 / EntryPoint 0.7 |

---

## 1. Summary

Prove, end to end on **Polygon Amoy testnet**, that an AI agent holding a **ZeroDev smart account** can execute a real **JPYC** payment to a merchant where the on-chain **session-key permission policy (`createBuyListPolicies`)** is the thing that authorizes and constrains the transfer, with **gas sponsored by a paymaster**. Settlement is the **session-key userOp itself** (Option A). This is the single highest-leverage de-risk before consumer-launch work, because it is the first time the L2 enforcement layer is exercised against a live payment rather than only unit tests.

## 2. Motivation

`createBuyListPolicies` (0.7.0) composes the on-chain authorization behind the Hub flow: a buy-list maps to `[callPolicy, rateLimitPolicy, timestampPolicy]` scoping a disposable session key. It is unit-tested (`test/buy-list-policy.test.ts`) at the enforced-bytes level, but **no running code has yet driven account → session key → x402 → userOp → paymaster → on-chain settlement together**. Until that path runs, the claim "the agent can pay, bounded, gaslessly, with on-chain enforcement" is unproven. This RFC closes that gap on a zero-value testnet.

## 3. Goals

- G1. An agent, given a **serialized scoped session key**, completes a JPYC payment to an **allowlisted** merchant on Amoy via a **session-key-signed userOp**.
- G2. Gas is **sponsored** (the agent holds zero POL and the userOp still lands).
- G3. The **policy is the enforcement boundary**: out-of-scope payments fail at userOp validation, not at token balance. (See §8 acceptance criteria — this is the de-risk.)
- G4. The demo lives as a reproducible harness in the separate **`kawasekit-example`** repo, consuming `kawasekit` as an external dependency — wiring only existing SDK primitives plus thin orchestration. This placement doubles as an SDK public-API boundary test (§6.4).

## 4. Non-goals (explicitly OUT — anchored to the scope table)

- Passkey owner / `toPasskeyValidator` / RIP-7212 (L1 CONSUMER LAUNCH).
- Rotatable ownership, guardian/social/backup-owner recovery (L3 CONSUMER LAUNCH).
- AP2 Intent/Cart Mandate (L2 DEFER).
- `kawasekit-mpc-2p` / threshold MPC signer (L1 DEFER, audit-gated).
- Multi-chain, mainnet, real value.
- Japanese counsel review (not required for a zero-value testnet per the regulatory scope row).
- **Option B** settlement (EIP-3009 `transferWithAuthorization` / x402-spec facilitator broadcast) — deferred; see §6 and O-1.
- Custom ERC-7579 policy hook (e.g. an on-chain cumulative-¥ ceiling) and the off-chain Hub policy engine — deferred to **RFC-0002** (layered policy architecture); audit-gated like `kawasekit-mpc-2p`. See §6.5.

## 5. Background — layer positions for this demo

| Layer | This demo (BUILD NOW) |
|---|---|
| **L1 signer** | ECDSA owner only (`signerToEcdsaValidator`, sudo). No passkey/MPC wiring; seam preserved. |
| **L2 permission** | Session key scoped by `createBuyListPolicies` → `callPolicy` (JPYC.transfer to allowlisted merchant, `value ≤ maxPerTransfer`) + `rateLimitPolicy` (window-total count over `[validAfter, validUntil]`, no per-interval reset — 0.7.0) + `timestampPolicy` (expiry). |
| **L3 custody** | Single ECDSA owner, no recovery. Acceptable because testnet is valueless. |

## 6. Design

### 6.1 Actors

- **Owner** — ECDSA key; sudo validator on the Kernel account; issues the session key.
- **Agent** — holds only the **serialized session-key approval** + the session private key; never holds the owner key.
- **Merchant** — a fixed recipient address on the buy-list (the allowlist).
- **Infra** — ZeroDev **bundler** + **paymaster** on Amoy (`createZeroDevPaymasterClient`).

### 6.2 End-to-end flow

1. **Account creation.** Owner derives a Kernel v3.1 account: `signerToEcdsaValidator(...)` (sudo) → `createKernelAccount({ plugins: { sudo: ecdsaValidator }, kernelVersion: KERNEL_V3_1, entryPoint })`. The address is **counterfactual** — derived from the factory + the **sudo (owner) validator**, *not* the session key — and is **lazily deployed by the first userOp**. Consequences: (a) JPYC must be funded to *this* counterfactual address (not an EOA), and (b) the gas policy must cover the heavier deploy+transfer first op (see §9).
2. **Session-key issuance (owner side).** From the buy-list, `createBuyListPolicies(...)` produces the policy array. The owner calls kawasekit's `issueSessionKey(...)`, which builds the Kernel account with the owner ECDSA sudo validator **plus** a permission validator carrying the policies (`toECDSASigner(sessionSigner)` → `toPermissionValidator({ policies, ... })`), then `serializePermissionAccount(account)`, and hands the serialized approval to the agent. **Note — issuance trust model:** the current SDK builds the permission validator with the **real session signer**, so the **issuer must hold the session private key at issuance time**. `addressToEmptyAccount` (which would let the agent self-generate the key and disclose only its address) is **not** used anywhere in kawasekit. The owner EOA remains the sole sudo authority. An address-only issuance path is a possible SDK follow-up (see O-5).
3. **x402 negotiation (agent side) — OUT OF SCOPE for this harness.** In the full product the agent would request the resource, receive an **HTTP 402** with payment requirements (recipient, amount, `asset = JPYC`, `chain = Amoy`), and check the requirement is inside its policy scope before paying. This harness exercises Option A's settlement **directly** (the agent is handed recipient+amount); the x402 negotiation round and its scope pre-check are **future work** (see O-1, O-3). The committed harness imports nothing from `src/x402/*`.
4. **Payment construction.** Agent deserializes the session key, recreates the session signer with the real session private key, and builds a userOp calling **`JPYC.transfer(merchant, amount)`** (encoding via `src/tokens/*`).
5. **Submission + sponsorship.** `createKernelAccountClient({ account, chain: amoy, bundlerTransport, paymaster: { getPaymasterData(userOp) { return paymaster.sponsorUserOperation({ userOperation: userOp }) } } })` → send userOp.
6. **On-chain validation.** Kernel validates the userOp against the permission policies. Transfer executes **iff** recipient ∈ allowlist, `value ≤ cap`, count within window-total, and `now ∈ [validAfter, validUntil]`. Otherwise it **reverts at validation**.
7. **Confirmation.** Agent waits for the bundler receipt. (The x402 settlement-proof re-request is out of scope here — see step 3.) An **in-process** idempotency cache keyed on `deriveIdempotencyKey({conversationId, stepId})` guards against double **submission within one process** (call-level only — see §8 I1).

### 6.3 Settlement composition — decision (proposed D-log entry)

**Chosen: Option A — the session-key userOp is the settlement.** The userOp calls `JPYC.transfer`, so the ZeroDev Call/RateLimit/Timestamp policies are the on-chain authorization. x402 stays the negotiation/quote layer only. This directly exercises `createBuyListPolicies`, which is the point of step 3.

**Deferred: Option B** — settle via EIP-3009 `transferWithAuthorization` (`src/tokens/eip3009.ts`), the x402-spec facilitator-broadcast rail. B is valuable for **external-merchant interop** but **bypasses Kernel policy enforcement** unless wrapped in a userOp, so it does not prove the de-risk. Tracked as O-1.

### 6.4 What is new vs existing

Existing and reused (from `kawasekit`, as actually imported by the harness): `src/account/session-key.ts` + `src/session/*` (`issueSessionKey`, `restoreSessionAccount`, `serialize`/`parseSessionEnvelope`), `src/policy/buy-list.ts` (`createBuyListPolicies`, which composes `src/policy/jpyc-call-policy.ts`), `src/tokens/*` (`jpycAbi`, `getJpycAddress`, `JPYC_DECIMALS`), `src/client/transfer-jpyc.ts` (`transferJpyc`), `src/idempotency/*` (`deriveIdempotencyKey`), `src/observability/*` (`invokeHookSafely`). **Not** used: `src/x402/*` (the negotiation layer is out of scope — see §6.2 step 3). New: a harness in the **`kawasekit-example`** repo (`zerodev-agent-jpyc/`) that composes the above into the §6.2 flow, plus thin glue (the sponsored-client build — the SDK gap G1, §9).

**Placement rationale.** The harness consumes `kawasekit` strictly as an external dependency — exactly as the future `kawasekit-hub` will. If it cannot be built without reaching into SDK internals, that is a signal the public API is incomplete; surfacing that here, before the Hub depends on it, is intentional. Mirrors ZeroDev's own split (`zerodevapp/zerodev-examples` is a separate repo). During active development, link `kawasekit` via a path/workspace or commit-pinned git dependency; pin to a published version once stable.

### 6.5 Relationship to the layered policy architecture (RFC-0002)

In this demo the off-chain "policy engine" is **degenerate**: a fixed buy-list. The full layered model — off-chain Hub policy engine (decision/orchestration) + on-chain permission policy (enforcement floor, this demo) + a reserved custom ERC-7579 hook for the one or two constraints that must be trust-minimized and cannot be composed (cumulative-¥ ceiling, the D5/§1.3 gap) — is deferred to **RFC-0002**. Step 3 deliberately exercises only the **on-chain enforcement-floor half**, both to de-risk it and to learn what the floor can/cannot express — that learning is the input to RFC-0002. The custom hook, if/when built, will be a new `kawasekit` SDK primitive composed by the Hub, keeping the engine off-chain and the enforcement primitive in the SDK.

## 7. Configuration (pin / verify at implementation — do not hardcode from memory)

- **Chain**: Amoy, chain id **80002**, native gas **POL**.
- **JPYC (Amoy)**: contract address and **decimals** MUST be pulled from the **official JPYC faucet/docs** at implementation time and verified on Amoy PolygonScan; do not trust a search-derived address. Fund the test account from the JPYC faucet (Amoy supported). Note: the harness's `assertJpycOnChain` proves the env address **equals kawasekit's built-in `getJpycAddress(80002)`** and that on-chain `decimals() == 18` — i.e. *consistency*, not *correctness*. Correctness still rests on the operator verifying the address on Amoy PolygonScan against the official JPYC docs.
- **ZeroDev**: project id, bundler RPC, paymaster RPC from the ZeroDev dashboard; configure a **blanket "sponsor-all"** gas policy covering the demo userOps (it must NOT filter recipient/amount, or it would mask the permission validator — see §8/§9).
- **Account to fund**: run the harness **preflight** (`preflight()` / the head of `pnpm zerodev:demo`) to print the **counterfactual Kernel address** (derived from the owner sudo validator — *not* an EOA) the agent pays from, plus its current JPYC balance + deployment state; fund JPYC to that exact address. The preflight issues only locally (no tx, no gas) and never auto-funds.
- **POL faucet**: only needed for any non-sponsored path / account deployment fallback.
- **Keys**: owner ECDSA key and session-key — testnet-only, never reused from any value-bearing context.
- **SDK versions**: pin `@zerodev/sdk`, `@zerodev/ecdsa-validator`, `@zerodev/permissions` and confirm the exact symbol names against the installed version (reference-architecture §8 — symbols drift between versions).

## 8. Test plan / acceptance criteria

The de-risk is **§3 G3**: enforcement must happen at the policy layer. **Amoy run #1 (2026-06-18) resolved the F1 premise** (`docs/rfc/rfc0001-amoy-run1-evaluation.md`): with ZeroDev's **verifying paymaster**, **Call/RateLimit** violations (N1–N3) surface as `sponsor_reject` — the paymaster fail-fasts on a reverting `validateUserOp` during its pre-sign `estimateUserOperationGas` — while the **Timestamp** violation (N4, non-reverting) is sponsored then bundler-rejected → `validation_reject`. **Enforcement held — no funds moved in any negative.** The original strict sponsored discriminator (must be a non-`SponsorshipError` `validation_reject`) is therefore **superseded** by the **"Both"** acceptance below.

**Happy path**
- H1. Payment to allowlisted merchant, within cap, within count, within window → JPYC transfer succeeds on-chain; receipt confirmed; merchant balance increases by the amount. (No x402 exchange — out of scope, see §6.2 step 3.)
- H2. Agent holds **0 POL**; userOp still lands → sponsorship proven (G2).

**Policy-enforcement negatives (the core of the de-risk)**
- N1. Recipient **not** in allowlist → rejected (Call policy `ONE_OF`).
- N2. `amount > maxPerTransfer` → rejected (Call policy value bound).
- N3. The **(N+1)th** payment within the window (count = N) → rejected (RateLimit **count bound**). This confirms the count bound is enforced on-chain; the **no-mid-window-reset** property rests on the `createBuyListPolicies` encoding (`interval = validUntil − validAfter`, one rate bucket), which is unit-asserted in `test/buy-list-policy.test.ts` ("rate limit is a TOTAL over the window") — not on this on-chain case.
- N4. Payment after `validUntil` → rejected (Timestamp).

**Acceptance (the "Both" resolution — supersedes the run-1 premise gate, which is now answered):**
- **(a) Paymaster-LESS N1–N4 → all `validation_reject`** (`expectOnChainValidationReject`). Run the
  negatives through a **self-paid** (POL) client — no paymaster — so the **on-chain permission
  validator is the SOLE rejecter** (no verifying paymaster to simulate-and-decline). Each asserts:
  threw (not a `SponsorshipError`), a `validation_reject` span, **no** `sponsor_reject`, **no**
  `settle`, merchant balance unchanged. This is the **immutable, paymaster-independent** boundary
  proof. Needs the account POL-funded (~0.1 POL) for the bundler prefund check — **not consumed**
  (the ops revert at validation). (Step-0 verified: `createBuyListPolicies`/`issueSessionKey` impose
  **no** paymaster restriction — only `[call, rateLimit, timestamp]`; `toPermissionValidator` has no
  paymaster param — so the self-paid path works directly.)
- **(b) Sponsored N1–N4 → the durable invariant** (`expectPolicyEnforced`). The production
  (sponsored) path: each asserts it **threw** + **no `settle`** + merchant balance **unchanged**, and
  **records** the branch (`sponsor_reject` / `validation_reject`) via the `[F1 premise]` log
  **without hard-asserting it** — so the test survives ZeroDev paymaster-behavior changes. Controlled
  comparison (H1 in-scope settles vs N1–N3 one-param-out-of-scope rejected) attributes the rejection
  to the policy. Requires a blanket "sponsor-all" gas policy.

**Unit green ≠ de-risk closed** — both (a) and (b) must be green on a live Amoy run.

**Integrity**
- I1. Replaying the same `{conversationId, stepId}` does not double-submit — **call-level, in-process dedup only** (an in-memory cache, lost on restart, keyed on harness-local ids that diverge across agent-harness boundaries). This is **not** durable or cross-harness idempotency; the on-chain rateLimit count (N3) is the actual over-spend backstop. Durable / protocol-normalized-intent idempotency is future work.
- I2. Observability hooks emit the expected spans for submit / sponsor / settle.

A passing run = H1+H2 succeed **and** both (a) the **paymaster-less** N1–N4 are all `validation_reject` **and** (b) the **sponsored** N1–N4 satisfy the durable invariant (threw + no settle + balance unchanged; branch recorded), on Amoy. **Status (Amoy, 2026-06-18): MET ✅ — 16/16 live.** H1/H2 ✅; (b) sponsored N1–N4 ✅ (N1–N3 `sponsor_reject`, N4 `validation_reject`); (a) paymaster-less N1–N4 ✅ (all `validation_reject` / `UserOperationExecutionError`). **Step 3 is DE-RISKED.**

## 9. Risks & mitigations

- **SDK symbol drift** → pin versions; assert symbol names at impl (§7).
- **Wrong JPYC address / decimals on Amoy** → pull from official faucet/docs; verify on explorer; assert decimals in the harness.
- **Paymaster gas policy / rate limits** → configure a **blanket "sponsor-all"** ZeroDev dashboard policy for the demo; surface sponsorship rejection as a typed `SponsorshipError` (no owner-pays fallback). The gas policy MUST NOT restrict recipient/amount — otherwise N1–N4 would be rejected at the paymaster instead of the permission validator, masking the de-risk (the harness fails such a run; §8).
- **Paymaster simulate-and-decline (F1 — CONFIRMED, Amoy run #1, `docs/rfc/rfc0001-amoy-run1-evaluation.md`)** → ZeroDev's verifying paymaster runs `eth_estimateUserOperationGas` (executing `validateUserOp`) *before* signing, so **revert-style** policies (Call/RateLimit, N1–N3) fail `pm_sponsorUserOperation` → `sponsor_reject`/`SponsorshipError`; the **non-reverting** Timestamp (N4) is sponsored then bundler-rejected → `validation_reject`. Enforcement held (no funds moved in any negative). **Resolution = Both:** (a) **paymaster-less** N1–N4 (self-paid POL) prove the *immutable on-chain validator* boundary directly (no paymaster to conflate); (b) **sponsored** N1–N4 assert the *durable invariant* (threw + no settle + balance unchanged; branch recorded, not asserted) so the production path is covered and the test survives ZeroDev paymaster-behavior changes. **Step-0 verified:** `createBuyListPolicies`/`issueSessionKey` impose **no** paymaster restriction (only `[call, rateLimit, timestamp]`; `toPermissionValidator` has no paymaster param), so the self-paid path works directly with no special session-key variant.
- **Funding the wrong address** → JPYC must be funded to the **counterfactual** Kernel address (derived from the sudo validator, §6.2 step 1), not an EOA; the first userOp also deploys the account, so the gas policy must cover the heavier deploy+transfer op.
- **Quote vs policy window mismatch** *(deferred with x402)* → when the x402 negotiation round is added, the quote expiry must sit inside `[validAfter, validUntil]`; out of scope for this harness (§6.2 step 3).
- **RateLimit semantics misread** → the no-per-interval-reset property is asserted at the **unit** level (`test/buy-list-policy.test.ts` checks `interval == validUntil − validAfter` and `startAt == validAfter`); N3 confirms the on-chain count bound. Together they cover the reconciled semantics.

## 10. Open questions (carried from reference-architecture §7, scoped to this RFC)

- **O-1 (settlement unification):** Can x402-spec EIP-3009 settlement (Option B) be unified with session-key Call-policy enforcement **without double-authorization**? Deferred; A is used for step 3.
- **O-2 (JPYC units):** Exact decimals/amount handling for JPYC on Amoy — verified at impl, asserted in tests.
- **O-3 (402 carrier):** Should the 402 payment-requirements object carry chain/asset explicitly so the same agent works across JPYC chains later? Note for the x402 layer.
- **O-4 (passkey UX, deferred):** Per-payment passkey signing friction vs session keys — out of scope here (ECDSA owner), relevant at CONSUMER LAUNCH.
- **O-5 (address-only session issuance, deferred):** kawasekit's `issueSessionKey` requires the full session `LocalAccount` at issuance (it builds the permission validator with the real signer, not `addressToEmptyAccount`), so the **issuer holds the session secret**. Should the SDK offer an address-only issuance variant (agent self-generates the keypair, owner receives only the address) for the Hub's owner→agent delegation? Tracked for the Hub L1 design; harmless for this single-operator demo where both keys are co-located.

## 11. Rollout

1. Approve this RFC (Draft v2 — review findings applied).
2. Harness lives in the **`kawasekit-example`** repo (`zerodev-agent-jpyc/`) — SDK primitives + thin glue, no new policy code. It consumes published `kawasekit@^0.7.0`. CI tracks `kawasekit` via the dependency-light `pnpm typecheck:rfc0001` + `pnpm test:rfc0001` (a dedicated `zerodev-agent-jpyc/tsconfig.json` scopes the typecheck to the harness, so it stays green **without** the private `@kawasekit/mpc-2p` optional dep used elsewhere in the repo) — breaking SDK changes surface promptly.
3. **Preflight + provision (owner).** Run `pnpm zerodev:demo`'s preflight (`preflight()` in `harness.ts`) to resolve the **counterfactual account address** the agent pays from; fund *that* address with JPYC (Amoy faucet) + a **blanket "sponsor-all"** ZeroDev gas policy (sponsored H1/H2/I1/I2/sponsored-N1–N4), **and ~0.1 POL** for the **paymaster-less** N1–N4 prefund check (§8(a); not consumed). The preflight reports JPYC + POL sufficiency.
4. Run §8 on Amoy; record results. Acceptance = **Both** (§8): (a) **paymaster-less** N1–N4 all `validation_reject`, and (b) **sponsored** N1–N4 satisfy the durable invariant (threw + no settle + balance unchanged; branch recorded via `[F1 premise]`). **✅ MET — Amoy 2026-06-18, 16/16 PASS:** H1/H2 ✅; (b) ✅ (N1–N3 `sponsor_reject`, N4 `validation_reject` — F1 premise resolved per `docs/rfc/rfc0001-amoy-run1-evaluation.md`); (a) ✅ (all `validation_reject` / `UserOperationExecutionError` — on-chain validator is the sole boundary).
5. **Implemented ≠ de-risked → now DE-RISKED.** Both §8(a) and §8(b) are green on Amoy; no funds moved in any negative. Step 3 is **closed**.
6. **→ STATUS step 4 (passkey owner validator + recovery)**, the next launch-critical item.
