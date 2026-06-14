---
"kawasekit": minor
---

# `createJpycDailyLimitPolicies` — recipient allowlist

`createJpycDailyLimitPolicies` now accepts an optional `recipientAllowlist?:
readonly Address[] | "any"`. An address list restricts the session key's on-chain
callPolicy to `transfer` JPYC only to those recipients (via ZeroDev
`ParamCondition.ONE_OF` on the `to` argument); the per-transfer `value` cap and
the daily rate limit are unchanged. `"any"` (or omitting the field) leaves the
recipient unrestricted — byte-identical to before, fully backward-compatible.

The `Address[] | "any"` shape mirrors the off-chain `SpendingPolicy.recipientAllowlist`,
so a buy-list's resolved allowlist feeds both policy paths unchanged. Both paths
now share one `normalizeRecipientAllowlist` (checksum + de-dupe). Two on-chain-forced
differences from the off-chain sibling, documented at both call sites: the field is
optional here (omitted = `"any"`), and an empty array `[]` throws (rather than
meaning deny-all) — an on-chain allowlist cannot encode "match nothing". Combining
an address list with `callPolicyVersion: V0_0_1` throws up-front (the `ONE_OF`
condition needs `V0_0_2`+; the default `V0_0_4` is fine).

This is the on-chain enforcement behind the "pay only registered merchants"
model: a buy-list resolves to its merchants' addresses, which are baked into a
disposable, scoped session key — any transfer to a non-allowlisted address
reverts before funds move. Closes the long-standing "recipient is unrestricted
in M2; add allowlisting in M3" gap in `src/policy/daily-limit.ts`.
