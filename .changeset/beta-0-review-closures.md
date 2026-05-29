---
"kawasekit": patch
---

# External-review + source-verification closures (beta line)

Promotes the alpha line to beta after closing a full CTO-class review of
`docs/THREAT_MODEL.md` (19 findings + 5 follow-ups) and a second,
source-verification pass (3 new findings) against the actual SDK source.
Two of the closures are **breaking changes to the public API** vs
`0.1.0-alpha.0` / `0.1.0-alpha.1` — see the breaking-notes section below.

## Breaking API changes (vs alpha.0 / alpha.1)

- **`wrapFetch`'s `onPayment` is now required at the type level** (review
  item C1). It was optional in alpha; omitting it silently defaulted to
  "always pay". It is now a non-optional field on `WrapFetchParams`
  (`src/x402/fetch.ts`) — omission is a compile-time error. Existing
  callers that relied on the default must add an explicit budget gate, or
  `onPayment: () => true` to opt in deliberately.
- **`createX402PaymentSigner`'s `asset` is now a required discriminated
  union** (review item H2). The optional `domainOverride` field is
  **removed**; `CreateX402PaymentSignerParams.asset` is now
  `{ kind: "known"; id: KnownAssetId } | { kind: "unsafeOverride"; domain }`.
  The signer pins the EIP-712 domain at construction and cross-checks
  `paymentRequirements.asset` at every sign call, so a malicious server's
  advertised `extra.name` / `extra.version` are no longer consulted (Threat
  1.4). For JPYC v2 pass `{ kind: "known", id: "jpyc-v2" }`; for any other
  asset, `{ kind: "unsafeOverride", domain }` is the deliberately-loud
  escape hatch. New error `X402InvalidConfigError` is thrown on unknown
  `kind` / unknown id / malformed override.

## New public API surface

- `X402AssetParam`, `KnownAssetId`, `KnownAssetDomain`, `getKnownAssetDomain`,
  `listKnownAssetIds`, `X402InvalidConfigError` — exported from the root and
  the `kawasekit/x402` subpath (`src/tokens/known-assets.ts`,
  `src/x402/errors.ts`).

## Security posture (no code change, documented)

- **New Layer 1 threat 1.14 — server-advertised amount inflation** (source-
  verification finding H1-A): the signer bounds the requested `amount` only
  by `uint256` shape — no ceiling. The `wrapFetch` `onPayment` guard is the
  operator's required ceiling, and the public direct-signer path bypasses
  it; the EOA-payer x402 path is **not** bounded by the Layer-4 session-key
  daily-limit. A `maxAmountPerSign` affordance is planned for M5 (H1 Part B).
- Threat 1.8 split into 1.8a (✅ API-surface, the required `onPayment`) and
  1.8b (🟡 wire-format reasoning-step gap) so the verdict matches the §0
  vocabulary (no hybrid labels).
- Threats 1.3 (MITM) and 2.3 (DoS via `/verify`) moved ⚠️ → 🔵 (the SDK is
  genuinely not the defence layer). New threats 1.12 (clock skew), 1.13
  (JSON payload DoS), 2.9 (revoke reorg), 4.8 (Kernel nonce-key collision).
- The JPYC v2 contract citations behind the 1.1 / 1.11 / 4.7 ✅ verdicts are
  now independently resolvable (commit-pinned upstream `jcam1/JPYCv2@e06edf5`
  permalinks + the Polygonscan-verified deployed implementation
  `0xafAc17FC…`), instead of the gitignored local `fiat/` tree (finding H2).
- New operator runbook `docs/recipes/revoke-race-mitigation.md` (review item
  H3); example PK loading abstracted behind `createPkProvider` (`env://`
  demo vs `kms://` production, item H5); new informative §8 "Regulatory
  affordances".

## Tests / tooling

- 251 vitest cases (alpha.1 had 247). Added: asset-whitelist (Threat 1.4)
  cases, the `onPayment`-required `expectTypeOf` type test, and a
  `fast-check` property-based test for BASE64 regex / decoder agreement.
- `fast-check` added as a devDependency.
- The supply-chain-policy CI assertion is now a shared composite action
  (`.github/actions/assert-supply-chain-policy`) invoked by both `ci.yml`
  and `release.yml` (item F5).

The full per-item trail (C1–C3 / H1–H5 / M1–M6 / L1–L5 / F1–F5 + the
source-verification Sprint 1+2 items) is recorded in `docs/THREAT_MODEL.md`
Appendix A.

## Publish

Publishes under the `beta` dist-tag (`pnpm add kawasekit@beta`). The
prerelease counter is monotonic across the pre-release window and does not
reset on the alpha→beta tag change, so this lands as `0.1.0-beta.2`
(continuing alpha.0 / alpha.1). The `0.0.1` placeholder remains on the
`latest` tag until v0.1.0 GA (planned for M5 after the external human formal
review).
