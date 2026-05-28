---
"kawasekit": patch
---

# 0.1.0-alpha.1 — pre-external-review hardening

Three SDK-level threat-model gaps surfaced in the M4 self-review are now
closed with code, not just docs. The pre-fix mitigations were JSDoc /
example-only; this release moves them behind runtime checks so external
reviewers can confirm `✅ Mitigated` in source.

## SDK behaviour changes

- **`createSelfFacilitator` requires `nonceManager`** (closes threat 2.2 /
  §6.5). The bound walletClient's account must carry viem's
  `nonceManager`; construction throws otherwise with a copy-pasteable
  fix message. The pre-fix code silently dropped settlements under
  parallel-fan-out load (typical LLM agent tool calling).
- **Canonical base64 enforced** (closes threat 1.7 / §6.7). The decoder
  `BASE64_REGEX` is tightened to RFC 4648 §4: length must be a multiple
  of 4 and only the legal trailing forms `XX==` / `XXX=` / `XXXX` are
  accepted. Non-canonical inputs (overlong padding, embedded
  whitespace / newlines / tabs, misplaced padding, impossible lengths)
  are rejected upfront instead of slipping through to the JSON parser
  where cross-runtime behaviour differs between Node's `Buffer` and
  browser `atob`.
- **Chain-aware `confirmations` for settle finality** (closes threat 2.8
  / §6.6). `CreateSelfFacilitatorParams` gains a `confirmations?: number`
  option threaded into viem's `waitForTransactionReceipt({ confirmations })`.
  Chain-aware default: `1` on testnet, **`4` on mainnet** (~8 s of soft
  finality at Polygon's ~2 s block time). High-value merchants raise to
  32+ and bump `receiptTimeoutMs` to match.

## Breaking notes for alpha.0 consumers

- Constructing a facilitator without `nonceManager` now throws at boot.
  The fix is a one-line `{ nonceManager }` addition to `privateKeyToAccount`.
- A handful of non-canonical base64 inputs that previously failed at the
  JSON parse step now fail at the base64 regex with a clearer error.
  Inputs that decode to valid JSON were never produced by kawasekit's
  encoder, so legitimate clients are unaffected.
- The default `confirmations` on mainnet (`4`) adds ~8 s to each
  settle's wall-clock time. Operators who prefer the old single-receipt
  wait pass `confirmations: 1` explicitly.

## Documentation

`docs/THREAT_MODEL.md` gains a Layer 0 (Supply chain & build integrity)
section with 5 threats backed by actual config citations (pnpm
`minimumReleaseAge`, `allowBuilds`, npm provenance attestation, exact-
pinned production deps). §6.5 / §6.6 / §6.7 are marked **closed** with
the pre-fix gap preserved as historical record. Verdict tally:
27 ✅ Mitigated / 19 ⚠️ Operator responsibility / 4 🔵 Out of scope /
3 🟡 Known limitation, with 0 split verdicts remaining.

## Tests

247 vitest cases (alpha.0 had 228). Added: 2 nonceManager enforcement
cases, 15 RFC 4648 adversarial cases, 2 confirmation depth cases.

## Publish

Publishes as `kawasekit@0.1.0-alpha.1` under the `alpha` dist-tag. The
`0.0.1` placeholder remains on the `latest` tag until v0.1.0 GA.
