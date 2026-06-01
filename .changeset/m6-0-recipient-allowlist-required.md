---
"kawasekit": patch
---

# M6-0 polish — `SpendingPolicy.recipientAllowlist` is now required (no allow-open default)

Tightens the (unreleased) M6-0 `SpendingPolicy` so its recipient restriction is
**deny-closed like `perToken`**, removing the one allow-open default flagged by
`web3-cto-review` (finding M2).

`recipientAllowlist` changes from optional `readonly Address[]` (where `undefined`
silently meant *any recipient*) to **required** `readonly Address[] | "any"`:

- `"any"` — unrestricted (now an explicit, greppable choice)
- `[]` — deny-all
- `[...]` — allowlist

Omitting it is a compile error, so "allow any recipient" can never be an
accidental default. Matches the project's conscious-choice convention
(`acknowledgeAdvisory`, the required `onPayment` guard, `unsafeOverride`).

Also re-verified every `docs/rfc/policy-gated-signer.md` Appendix B source anchor
against the implemented tree (review finding L2).
