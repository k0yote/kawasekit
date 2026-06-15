---
"kawasekit": minor
---

# `createBuyListPolicies` — buy-list → scoped disposable session-key policy bundle

New `createBuyListPolicies({ jpycAddress, merchants, maxPerTransfer, maxTransfers,
validUntil, validAfter?, callPolicyVersion? })` maps a resolved buy-list to the
ZeroDev policy bundle for a single-use session key — the on-chain authorization
behind the Agent Commerce Hub flow. It composes three policies:

- **callPolicy** — `JPYC.transfer` with `value ≤ maxPerTransfer` and `to ∈ merchants`
  (the allowlist; required and non-empty).
- **rateLimitPolicy** — a **total** cap of `maxTransfers` over the whole schedule
  window. The rate window is set to span `[validAfter, validUntil]`, so the count
  is a session total and does NOT reset per-day (which would otherwise let more
  than `maxTransfers` through over a multi-day window).
- **timestampPolicy** — the key is only valid within `[validAfter, validUntil]`.

Cumulative budget ("spend ≤ ¥X total") is not a policy field — it is the amount
the user funds the account with (funding is the user's responsibility, out of the
SDK's scope). These policies bound who (allowlist), how much per transfer (cap),
how many (count), and when (window).

Internal: the JPYC `transfer` callPolicy construction (amount cap + recipient
allowlist) is extracted into a shared `buildJpycTransferCallPolicy`, used by both
`createBuyListPolicies` and `createJpycDailyLimitPolicies` so the recipient/amount
constraint is built identically (no duplication). `createJpycDailyLimitPolicies`
behavior is unchanged.
