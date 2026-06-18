# Evaluation — RFC-0001 Amoy run #1 (the F1 premise result)

| | |
|---|---|
| **Reviewer** | external CTO-class pass |
| **Date** | 2026-06-16 |
| **Subject** | First live Amoy integration run of the RFC-0001 harness (`pnpm zerodev:demo` + `pnpm test:rfc0001`) |
| **Verdict** | **Enforcement proven; discrimination method failed exactly as F1(b) predicted. Resolution: Both.** |

---

## 1. What the run established (the good news)

- **Enforcement HOLDS.** In all four negatives (N1–N4) **no funds moved** — the out-of-scope transfer never executed. H1/H2: the in-scope sponsored payment lands on-chain with sponsored gas. **The on-chain permission policy is the enforcement boundary for money safety.**
- **The de-risk is NOT vacuous.** A controlled comparison holds: H1 (in-scope) sponsors and settles; N1/N2/N3 are rejected when exactly one policy-relevant parameter is flipped out-of-scope. Only the policy condition differs → the rejection is **policy-caused**.

## 2. What the run revealed (F1 premise: split by mechanism)

| Case | Policy | Result | Premise |
|---|---|---|---|
| H1/H2 | in-scope | sponsored success (real tx) | — |
| N1 (recipient ∉ allowlist) | Call `ONE_OF` | `sponsor_reject` | **BROKEN** |
| N2 (amount > cap) | Call value | `sponsor_reject` | **BROKEN** |
| N3 (count > maxTransfers) | RateLimit | `sponsor_reject` | **BROKEN** |
| N4 (after validUntil) | Timestamp | `validation_reject` | **HOLDS** |

**Why N1–N3 and N4 split:**
- **Call / RateLimit** make `validateUserOp` **revert** (`SIG_VALIDATION_FAILED`) on violation → the verifying paymaster's pre-sign `estimateUserOperationGas` (which executes `validateUserOp`) hits the revert → `pm_sponsorUserOperation` itself fails → `sponsor_reject`.
- **Timestamp** does **not** revert on violation; it returns an expired `validUntil` as a time-range → the paymaster's simulation succeeds → it sponsors → the **bundler** then rejects on the time-range → `validation_reject`.

This is correct ERC-4337 behavior and is precisely the **simulate-and-decline** F1(b) flagged as version/ordering-dependent.

## 3. The residual gap (precise)

The controlled comparison proves the policy **causes** the rejection — but for N1–N3 that rejection is observed at the paymaster's **off-chain pre-sign simulation**, not at the bundler-submitted **on-chain validation**. The non-custodial security claim requires the **on-chain, paymaster-independent** proof. N4 incidentally provides one on-chain `validation_reject` (sponsored path); N1–N3 do not, because the paymaster declines before the op reaches the bundler.

## 4. Verdict

- **Money safety:** PROVEN (no funds moved in any negative; controlled comparison).
- **Production-path (sponsored) negative behavior:** OBSERVED (`sponsor_reject`, no funds moved, graceful rejection).
- **Immutable on-chain boundary for revert-style policies (Call/RateLimit):** NOT YET directly proven — the paymaster catches the violation before the bundler does.
- **Resolution: Both.** Add the §9 fallback (paymaster-less N1–N4 → all `validation_reject`) for the airtight on-chain boundary proof, AND relax the sponsored N1–N4 to a durable invariant for production-path coverage.

## 5. Updated definition of done (step 3)

Step 3 is **de-risked** when, on Amoy:

- **(a)** paymaster-less N1–N4 all produce `validation_reject` — the on-chain validator **alone** is the boundary (paymaster-independent, immutable); **and**
- **(b)** sponsored N1–N4 satisfy the **durable invariant**: `threw` + **no `settle`** + **merchant balance unchanged** — with the branch (`sponsor_reject` / `validation_reject`) **recorded**, not hard-asserted (so the test survives ZeroDev paymaster-behavior changes).

Both green = step 3 closed. Until then, step 3 is **implemented, not de-risked.**
