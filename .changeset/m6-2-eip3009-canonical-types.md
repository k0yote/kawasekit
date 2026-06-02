---
"kawasekit": minor
---

# M6-2 (slice 1) — canonical EIP-712 types as a single source of truth

Makes the EIP-3009 `TransferWithAuthorization` typed-data structure the SDK's
**single, exported source of truth**, so the out-of-process `mpc-2p` co-signer
backend binds to (or codegens from) the exact same definition instead of
re-declaring it. Realizes the H1 requirement in `docs/rfc/mpc-2p-cosigner.md`
§4.5; additive, no behavior change to existing signing.

## New exports (`kawasekit`)

- `transferWithAuthorizationTypes`, `receiveWithAuthorizationTypes`,
  `cancelAuthorizationTypes` — the canonical EIP-712 type definitions (were
  module-private), so external/cross-language consumers reuse the byte-exact
  structure that `ecrecover` verifies.
- `resolvedAssetToEip3009Domain(asset, chainId)` (+ `ResolvedAsset` type) — the
  single place that assembles an `Eip3009Domain` from a pinned asset and the
  runtime `chainId`. The x402 signer and the PolicyGatedSigner now both use it
  (byte-identical to the previous inline construction).

## New: digest-conformance corpus

`src/tokens/__fixtures__/eip3009-digest.vectors.json` pins golden EIP-712
digests (frozen, computed over the exported types) across chains and both
primary types. A conformance test asserts the exported types reproduce them, so
any drift in field order / type strings / domain is caught — and the Rust
backend asserts the same vectors to prove cross-language byte-identity.
