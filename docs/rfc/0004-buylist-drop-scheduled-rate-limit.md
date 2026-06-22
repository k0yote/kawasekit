# RFC-0004 — Drop the scheduled rate-limit from `createBuyListPolicies`

| | |
|---|---|
| **Status** | **Accepted (single decision).** Implemented in `0.10.0`. Not a decision-queue RFC — the fix was confirmed against the `@zerodev/permissions` source + an on-chain `AA22` and is applied directly. |
| **Author** | k0yote (with Claude) |
| **Date** | 2026-06-22 |
| **Realizes** | A correctness fix to the `createBuyListPolicies` session-key bundle (the buy-list authorization primitive behind RFC-0001 / the Agent Commerce Hub). |
| **Scope** | `src/policy/buy-list.ts` only. **`createJpycDailyLimitPolicies` (`daily-limit.ts`) is NOT changed here** — it uses the same `toRateLimitPolicy` primitive and warrants its own review (see §6). |
| **Breaking** | Yes (0.x minor). `createBuyListPolicies` returns `readonly [Policy, Policy]` (was 3); `maxTransfers` param removed. |

---

## 1. Summary

`createBuyListPolicies` composed three policies — `callPolicy` (allowlist + per-tx cap), `rateLimitPolicy` (a `maxTransfers` count), and `timestampPolicy` (window). The `rateLimitPolicy` was built on ZeroDev's **scheduled-release** rate-limit contract in a way that **breaks back-to-back multi-merchant payment**: the 2nd transfer is rejected on-chain with `AA22 (expired or not due)`. This RFC **drops the rate-limit**: the bundle becomes `[callPolicy, timestampPolicy]` and `maxTransfers` is removed.

## 2. The finding (mechanism, verified against source)

`@zerodev/permissions` exposes two rate-limit contracts (`constants.js`):

- **`RATE_LIMIT_POLICY_CONTRACT = 0xf63d4139B25c836334edD76641356c6b74C86873`** — encodes `interval‖count‖startAt` and gates operation *i* to unlock at **`startAt + i·interval`** (a *schedule*, not a sliding bucket).
- **`RATE_LIMIT_POLICY_WITH_RESET_CONTRACT = 0x6a06358e6b283921deceabe7e8a3741d506cca9b`** — encodes `interval‖count` (no `startAt`); "non-standard reset".

`toRateLimitPolicy` defaults to the **first** (scheduled) contract. `createBuyListPolicies` called it with `interval = validUntil − validAfter` (the **whole window**), `count = maxTransfers`, `startAt = validAfter`. Therefore:

| op | unlocks at | result |
|---|---|---|
| op 0 (1st transfer) | `startAt` (= `validAfter`, now) | valid ✓ |
| op 1 (2nd transfer) | `startAt + interval` = **`validUntil`** | **not-due until the window's end** ✗ |
| op 2+ | `startAt + 2·interval` > `validUntil` | dead (also past the timestamp policy) |

So with `count ≥ 2`, the 2nd transfer cannot execute until ~`validUntil`, and further transfers never can. The prior JSDoc ("one rate bucket / session total, NOT a per-day limit") was **wrong about the contract** — it is a schedule, not a bucket.

**Empirical:** an on-chain run paying two allowlisted merchants under one key — 1st payment **succeeded**, 2nd reverted with:

```
✗ User Operation expired.
Details: UserOperation reverted with reason: AA22 expired or not due
```

(`validUntil` was `now + 3600`, so the 2nd transfer was "not due" for ~1 hour.)

## 3. Why it surfaced only now

The byte-level unit tests (`test/buy-list-policy.test.ts`) asserted the **encoded** rate-limit params (`interval`, `count`, `startAt`) — which were "correct" per the prior (mistaken) model. The bug only manifests with **two sequential *successful* ops under one key on-chain**, which no prior test or harness exercised (RFC-0001's negatives only ever did **one** successful op per key, then a *rejected* one). This is a clean instance of **unit-green ≠ on-chain-closed**.

## 4. The fix

`createBuyListPolicies` now returns **`[callPolicy, timestampPolicy]`**; the `rateLimitPolicy` block and the `maxTransfers` parameter (and its validation) are removed, along with the `toRateLimitPolicy` import.

## 5. Rationale (separation of concerns)

The session-key permission bundle bounds **payment**:
- **who** — the recipient allowlist (`callPolicy` `to ∈ merchants`, `ONE_OF`);
- **how much per transfer** — the per-tx cap (`callPolicy` `value ≤ maxPerTransfer`);
- **when** — the schedule window (`timestampPolicy`).

**Total value** is bounded by the account's **funded balance** — funding is the user's responsibility and out of the SDK's scope (already documented). The transfer **count** was redundant with funding + the per-tx cap for *value*-bounding, and it was the term that broke multi-merchant payment. A **count / sponsored-op** bound — e.g. to limit how many sponsored-gas ops a *compromised* key can burn — is a **gas/sponsorship** concern that belongs to the **consumer's sponsor-gas policy** (the paymaster/gas-tank configuration), not to this on-chain permission bundle. Keeping the two separate is both correct and avoids re-introducing a scheduled-release foot-gun.

## 6. Related (out of scope) — `createJpycDailyLimitPolicies`

`daily-limit.ts` also uses `toRateLimitPolicy` (the same default `0xf63d…` contract) with `interval = ONE_DAY_SECONDS`, `count = maxTransfersPerDay`, and **no `startAt`** (→ 0). With `startAt = 0`, op *i* unlocks at `i·86400` — absolute epoch seconds in the **1970s** (all in the past) — so the time-gate is trivially satisfied and the "per-day reset" likely does not behave as its JSDoc claims (the count may act as a lifetime total, not a daily one). This is the **x402-EOA / M2 path**, not the buy-list, and is **not changed here** — it warrants its own review + on-chain check.

## 7. Breaking change & migration

- **Return:** `readonly [Policy, Policy]` (was `[Policy, Policy, Policy]`).
- **Param:** `maxTransfers` removed from `CreateBuyListPoliciesParams`.
- **Migration:** drop `maxTransfers` from `createBuyListPolicies(...)` calls. If you relied on the on-chain transfer count, move that bound to your gas/sponsorship policy. Shipped in **`0.10.0`** (a 0.x minor carrying this documented breaking change).

## 8. Acceptance

- `test/buy-list-policy.test.ts` updated: asserts the bundle is `[callPolicy, timestampPolicy]` (2), **no** `rate-limit` policy present; allowlist / per-tx cap / window enforced-bytes assertions retained. Green under the 4-point gate (typecheck / lint / vitest / build).
- The on-chain re-verification (two allowlisted merchants paid back-to-back under one key) is a **downstream** step for the consumer harness after `0.10.0` publishes.
