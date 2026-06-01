---
"kawasekit": minor
---

# M6-0 — PolicyGatedSigner seam

Adds a signing seam whose **enforcement strength is a first-class, type-visible
property**, generalizing M5-2's `maxAmountPerSign` from a single ceiling to
policy-as-data. This is the M6-0 baseline (mechanism-independent); the
cryptographic `mpc-2p` co-signer is M6-1+ in a separate repo. See
`docs/rfc/policy-gated-signer.md`.

## New: `kawasekit/signer`

- `PolicyGatedSigner<E extends EnforcementLevel>` — signs a decoded
  `PaymentIntent` only if owner policy approves it, returning a typed `SignResult`
  (`{ ok, signature }` | `{ ok: false, rejection }`); never throws on a policy
  denial. `E` is covariant, so a flow that demands non-bypassable enforcement
  **fails to compile** when handed an advisory signer.
- `createLocalPolicyGatedSigner({ account, policy, asset, acknowledgeAdvisory: true })`
  → `PolicyGatedSigner<"advisory">`. The `acknowledgeAdvisory: true` literal is
  **required** (omitting it is a compile error in TS and a throw in JS) so
  constructing an advisory signer is a conscious, greppable act.
- `requireNonBypassable` (compile-time type-gate) + `assertNonBypassable`
  (runtime backstop).

## New: `kawasekit/policy`

- `SpendingPolicy` (policy-as-data: session+expiry, per-token `maxPerSign` +
  cumulative cap, recipient allowlist, `revoked`), `createSpendingPolicy`
  (validator), `evaluateSpendingPolicy` (pure, deny-closed), `mergeSpendState`.
  The existing `createJpycDailyLimitPolicies` (smart-account path) moves under
  this subpath as a sibling.

## `createX402PaymentSigner` — additive `signer` variant

`createX402PaymentSigner` now accepts `{ network, signer, asset, requireEnforcement? }`
as an alternative to `{ network, account, ... }`. On a policy denial it throws the
new `X402PolicyRejectedError` (the `X402PaymentSigner.sign()` surface — returns a
payload or throws — is unchanged). The existing `account` path is byte-for-byte
unchanged.

## ⚠️ Type-level breaking change (non-fund)

`CreateX402PaymentSignerParams` changes from an `interface` to a **discriminated
union** (`account` | `signer`). **Value assignment is unaffected** — existing
`{ account, asset, network }` callers compile unchanged. But a union cannot be
`extends`-ed / declaration-merged: consumers who extended
`CreateX402PaymentSignerParams` should switch to the new, still-`interface`
**`CreateX402PaymentSignerAccountParams`** (the `account` arm, exported). Impact is
expected to be nil at `0.1.0-beta`, but it is called out here for completeness.

Internal: asset-domain pinning (`X402AssetParam` / `resolveAssetParam`) lifted to
`src/tokens/asset-domain.ts` (no behavior change; re-exported from `x402/client`).
