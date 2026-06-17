# Review — `createSponsoredKernelClient` Implementation Plan (option B)

| | |
|---|---|
| **Reviewer** | external CTO-class pass |
| **Date** | 2026-06-16 |
| **Subject** | `createSponsoredKernelClient` implementation plan (Phase 1 SDK helper + Phase 2 harness adoption, option B) |
| **Verdict** | **Approved to implement, with 5 findings to incorporate** (1 critical, 4 minor). |

---

## Verdict

The plan's structure, option B, and the items under **Approved as-is** are sound — **do not re-litigate them.** The single thing that determines whether the de-risk is *real* is **F1** (the discriminator's empirical premise). F1 is a documentation + test-observability + gating change, **not a defect in the helper code** — the helper and harness logic are correct. Fold F1–F5 in, then execute the plan.

---

## Findings (severity-ranked)

### F1 — 🔴 CRITICAL — the N1–N4 discriminator rests on an UNCONFIRMED empirical premise

**Statement.** The Sprint-1 discriminator distinguishes a *permission-validator rejection* (N1–N4) from a *paymaster sponsorship decline* by: the throw is **not** a `SponsorshipError`, no `sponsor_reject` span fired, no `settle` span, recipient balance unchanged. The harness logic that produces this (`sponsorDeclined` flag → `SponsorshipError` re-wrap vs raw re-throw) is **correct**. But its **soundness depends on ZeroDev's verifying-paymaster behavior**, which the plan does not confirm.

**Why it's load-bearing.** ZeroDev's paymaster is a *verifying paymaster* — the offchain signer decides sponsorship against its own gas policy, then signs `paymasterAndData`. Under a blanket "sponsor-all" policy, two outcomes are possible for an out-of-allowlist N1 op, and **which one occurs is version- and ordering-dependent and not documented**:

- **Premise HOLDS** — the paymaster sponsors (policy says yes), the op is then rejected at the bundler's `validateUserOp` (the permission validator). The failure surfaces *after* `getPaymasterData` succeeded → `sponsorDeclined = false` → raw re-throw → **non-`SponsorshipError`** → discriminator correct.
- **Premise BROKEN** — the paymaster service runs `eth_estimateUserOperationGas` (which executes `account.validateUserOp`) *before* signing; for N1 that simulation reverts → the `pm_sponsorUserOperation` call itself fails (HTTP 400) → `onSponsorError` fires → `sponsorDeclined = true` → harness raises `SponsorshipError` → **the discriminator misclassifies a policy rejection as a paymaster decline → the de-risk is silently vacuous.**

The plan's unit tests cannot catch this: they prove the harness *routes* errors correctly **given** a clean sponsor-vs-validate separation; they do **not** prove ZeroDev *produces* that separation.

**Required changes:**

- **(a) RFC-0001 §8 — add an explicit premise check as a named acceptance gate.** Before N1–N4 can be claimed, a live Amoy N1 (out-of-allowlist) run must produce a **non-`SponsorshipError`** throw with **no `sponsor_reject`** span and **no `settle`** span. `expectPolicyValidationReject` is necessary but, run live, only meaningful once this premise is established.
- **(b) RFC-0001 §9 — record the failure mode + fallback.** If the live N1 returns `SponsorshipError`/`sponsor_reject`, the paymaster is simulate-and-declining on validation failure, conflating the two rejection sources. **Fallback: isolate the two concerns** — keep H2 as the sponsorship proof (sponsored happy path), and run N1–N4 **without the paymaster** (a deployed, POL-funded account so the *only* possible rejection is the permission validator). **Precondition:** confirm `createBuyListPolicies` does **not** force paymaster-only (the session-key paymaster flag); if it does, the negatives must stay sponsored and the discriminator must instead distinguish decline-reason by error signature (brittle — last resort).
- **(c) The gated integration test — make the path observable.** Record/log which branch each negative took (`validation_reject` vs `sponsor_reject`) so the premise is visible in test output, not inferred.
- **(d) STATUS + RFC-0001 §11 — mark "implemented ≠ de-risked."** Step 3 is *not* closed on green units; it is closed only when the Amoy run confirms (a). **unit green ≠ de-risk closed.**

### F2 — 🟡 MINOR — verify `exports` actually blocks deep import of the `@internal` seam

`sponsorWithObservability` is a module export tagged `@internal` and (correctly) not re-exported from `src/index.ts`, so it's absent from the public `dist/index.d.ts`. **But `@internal` is a documentation signal, not access control** — the real boundary is `package.json#exports`. **Add a verification:** confirm `exports` does not expose `kawasekit/dist/client/*` for deep import; if it does, restrict `exports` to the entry point. With that, the seam is effectively private and the testability win (4 chain-free seam tests) justifies the module export. **The module-private alternative is rejected** — it forces integration-style testing of pure logic, strictly worse.

### F3 — 🟡 MINOR (optional) — one wiring unit test for the `publicClient` conditional

The omission of a fake-account construction test is reasonable and documented (a thin pass-through; real construction is covered by integration). The one bit of actual logic is the `exactOptionalPropertyTypes` conditional spread (`client` passed only when defined). **Optional:** a single test that mocks `createZeroDevPaymasterClient` + `createKernelAccountClient` and asserts the `client` key is present when `publicClient` is given and absent when omitted. If not added, note it — typecheck + integration is adequate. **Do not over-test a thin helper.**

### F4 — 🟡 MINOR — sticky `sponsorDeclined` flag vs multiple `getPaymasterData` calls

`sponsorDeclined` is a sticky boolean set in `onSponsorError`. If `getPaymasterData` fires more than once per send (e.g. gas-estimate + send) with mixed outcomes, the flag reflects the last `onSponsorError`. **Verify in integration that `getPaymasterData` fires once per send** (log the count); if it can fire multiple times, make the flag robust (latch only a genuine final decline). Minor.

### F5 — 🟡 MINOR — link-validate-before-publish ordering

The plan releases kawasekit `0.8.0` before Phase 2 consumes it (with `link:` offered as an alternative). **Elevate `link:` to the default order:** link Phase 2 onto the local kawasekit build → validate the API actually fits the consumer (the harness) → **then** release `0.8.0` → then bump Phase 2 to the published version. Publishing an API before any consumer has used it risks a churn release (`0.8.1`) if Phase 2 reveals an awkward fit — and "the consumer validates the API" is the entire point of the boundary-test placement.

---

## Approved as-is (DO NOT change or re-litigate)

- **Option B** (thin helper + optional `observability` hook; harness adopts).
- **The generic, chain-free seam** `sponsorWithObservability<T>(sponsor, account, observability)` — good design; makes the observability logic trivially testable.
- **The new `SponsoredKernelClientObservability` interface** — correct: the existing `ObservabilityHooks` is x402-shaped (verify/settle); sponsorship (granted/declined) is a distinct event domain. A small domain-specific interface that **reuses `invokeHookSafely`** is the right fit (mechanism reused, no bespoke safe-invoke invented). This is better than a literal "reuse the x402 hook shape" and is endorsed.
- **The single documented cast** in the helper (`as unknown as ConfiguredKernelClient`, commented) — closes G4 for all callers; CLAUDE.md-compliant.
- **TDD discipline, the changeset (minor → 0.8.0), the 4-point gate.**

---

## Exit criterion (the real definition of done for step 3)

**unit green ≠ de-risk closed.** The gated Amoy integration is the proof. The first thing it must establish is the **F1 premise**: an out-of-allowlist N1 op surfaces as a **non-`SponsorshipError`** with **no `sponsor_reject`** span — i.e. the paymaster sponsored and the *permission validator* did the rejecting. Until that is confirmed on-chain, step 3 is **implemented, not de-risked.**
