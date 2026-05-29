---
"kawasekit": minor
---

# M5-1 — Reasoning-step idempotency layer

Closes the `THREAT_MODEL.md` §6.1 fund-correctness gap (one of the two named
`0.1.0` GA gates): an AI agent's *single reasoning step* can no longer produce
*two payments* via retry, "Regenerate", pause-resume, or multi-agent fan-out.

The fix is layered (the SDK cannot see the LLM intent, only the harness can):

- **Half A — server-enforced at-most-once (default-on).** `createX402Handler`
  now deduplicates re-sent / concurrent paid requests: it replays the cached
  response and closes the verify→settle TOCTOU, keyed on the client
  `Idempotency-Key` header when present (the logical reasoning-step key, working
  even for signers that cannot derive a nonce) and falling back to the EIP-3009
  nonce otherwise — both namespaced by `(network, payTo, asset)` for
  cross-tenant isolation. Fund-correctness never depends on this store.
- **Half B — client-opt-in derived nonce (on-chain backstop).** When an
  idempotency key is supplied, the EIP-3009 nonce is derived deterministically
  from it (no shared secret — `keccak256(key ‖ from ‖ verifyingContract ‖
  chainId)`), so a re-signed same-intent payment produces the same nonce and the
  token contract's `authorizationState` rejects the duplicate settlement across
  any number of replicas.

## New public API (`kawasekit/idempotency` subpath + root)

- `normalizeIntentText`, `deriveIdempotencyKey`, `createIdempotencyKeyBuilder`,
  `CanonicalRequestIdentity` — the key authority (deterministic, non-semantic).
- `IdempotencyStore`, `IdempotencyLease`, `IdempotencyLookupResult`,
  `createInMemoryIdempotencyStore` — injectable store + the default in-memory
  bounded-LRU implementation (leased crash-recovery, `validBefore`-anchored TTL,
  one-time multi-replica warning).
- `IdempotencyRecord`, `serializeIdempotencyRecord`, `parseIdempotencyRecord`,
  `KAWASEKIT_IDEMPOTENCY_RECORD_VERSION` — the persisted record.
- `IdempotencyConfigError`, `IdempotencyRecordParseError`,
  `IdempotencyRecordVersionError`.
- `deriveAuthorizationNonce` (on `kawasekit`), `X402_HEADER_IDEMPOTENCY_KEY`.

## Wire-up (all additive / backward-compatible)

- `SignX402PaymentParams.idempotencyKey?` — derive the nonce deterministically.
- `WrapFetchParams.idempotencyKeyFor?` — attach the `Idempotency-Key` header and
  forward the key into the signer.
- `CreateX402HandlerParams.idempotency?` (`IdempotencyServerConfig`) — the
  server dedup gate. **Default-on** (in-memory); pass `{ store: "none" }` to
  disable or a shared store for multi-replica deployments.

## Notes

- The in-memory default is **single-process** and emits a one-time
  `KAWASEKIT_IDEMPOTENCY_001` warning; multi-replica deployments require a
  shared store (Layer 3) or the derived nonce (Layer 2) for the guarantee.
- Replayed responses carry an `Idempotency-Replayed: true` header; snapshots use
  a credential-safe header allowlist and a 64 KiB body cap.

## Tests

45 new cases (296 total): key authority, record (de)serialization, store state
machine (lease crash-recovery, LRU eviction, TTL), `deriveAuthorizationNonce`
scoping, and the §6.1 scenario matrix (identical re-send replay, disable,
header-keyed dedup across differing signatures, cross-tenant isolation,
concurrent TOCTOU, derived-nonce determinism, `wrapFetch` header propagation).

Design: `docs/rfc/m5-1-reasoning-step-idempotency.md` (RFC + `web3-cto-review`
pass). The `THREAT_MODEL.md` §6.1 verdict closure (1.8b/5.5 → ⚠️ with affordance,
new 1.8c → ✅) lands separately once this code is in.
