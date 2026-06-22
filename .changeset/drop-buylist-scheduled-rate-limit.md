---
"kawasekit": minor
---

fix(policy)!: drop the scheduled rate-limit from `createBuyListPolicies` (the `0xf63d4139…` not-due bug)

**Breaking change.** `createBuyListPolicies` now returns `readonly [Policy, Policy]`
(`[callPolicy, timestampPolicy]`, was 3) and the `maxTransfers` parameter is **removed**.

The dropped `rateLimitPolicy` was built on ZeroDev's **scheduled-release** rate-limit
contract (`RATE_LIMIT_POLICY_CONTRACT 0xf63d4139…`, which gates op *i* at
`startAt + i·interval`) with `interval` set to the whole window
(`validUntil − validAfter`). So the 2nd transfer was **not-due until `validUntil`** and
the 3rd+ never — back-to-back multi-merchant payment reverted on-chain with
`AA22 (expired or not due)`. This surfaced only with two sequential successful ops under
one key on-chain; the byte-level unit tests passed because they only checked the encoding.

Payment is now bounded by the allowlist (recipients) + the per-transfer cap + the schedule
window + the account's **funded balance** (the binding total-value ceiling; funding is the
user's responsibility, out of the SDK's scope). A transfer-**count** / sponsored-op bound
(e.g. to limit gas ops against a compromised key) belongs to the consumer's **sponsor-gas
policy**, not this permission bundle.

**Migration:** drop `maxTransfers` from `createBuyListPolicies(...)` calls; the bundle is
now `[callPolicy, timestampPolicy]`. If you relied on the on-chain transfer count, move that
bound to your gas/sponsorship policy. See `docs/rfc/0004-buylist-drop-scheduled-rate-limit.md`.
