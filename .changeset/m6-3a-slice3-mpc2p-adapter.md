---
"kawasekit": minor
---

# M6-3a (slice 3) — `createMpc2pPolicyGatedSigner` cryptographic adapter

Adds the cryptographic-enforcement PolicyGatedSigner that closes the M6-0 seam: a
2-of-2 MPC co-signer whose policy a single key-holder **cannot** bypass, so
`requireNonBypassable` accepts it (and still rejects an advisory `local` signer at
compile time). Realizes `docs/rfc/m6-3a-cross-process-wire.md` §4.4 in the public
SDK.

**Thin, open-core adapter.** The SDK ships only the protocol — it bundles no crypto,
no socket, and no key. The WASM DKLs share, the wss/mTLS transport, and the A3 HMAC
key are **injected interfaces**, provided concretely by the private
`kawasekit-mpc-2p` package. The adapter owns: the versioned `CoSignFrame` envelope,
the A4 digest re-derivation (reusing the exported `transferWithAuthorizationTypes`
source-of-truth), the A3 canonical-request bytes, the ceremony orchestration, and the
`SignResult` mapping.

**No silent fallback.** The adapter has no local-signing path: any transport /
availability failure throws `CoSignUnavailableError` — never an `{ ok: true }`
signature and never a `PolicyRejection`. A `rejection` means "the owner decided no"
(audit-meaningful); `CoSignUnavailableError` means "the owner did not decide" (the
caller may retry the same intent — the backend's idempotency keeps a retry safe).

## New exports (`kawasekit`, `kawasekit/signer`)

- `createMpc2pPolicyGatedSigner(params): PolicyGatedSigner<"cryptographic">` and
  `Mpc2pSignerParams`.
- The injected-interface types: `Mpc2pCoSignAgent`, `Mpc2pStepOutcome`,
  `CoSignTransport`, `CoSignConnection`, `CoSignRequestAuthenticator`.
- `CoSignUnavailableError` — the transient/internal (no-fallback) error.
- The wire source-of-truth: `CoSignFrame`, `WireIntent`, `toWireIntent`,
  `canonicalIntentBytes`, `WIRE_VERSION` — the TS mirror of the backend's serde +
  A3 canonical encoding (pinned to the backend by a shared conformance vector).

## Additive `PolicyRejection` reason: `nonce_reuse_conflict`

`PolicyRejection["reason"]` gains `"nonce_reuse_conflict"` — the backend's typed
verdict for the B7 anomaly (a previously-seen EIP-3009 nonce re-presented with
**different** intent fields). Additive only. Note for consumers that exhaustively
`switch` on `reason`: a new member means a previously-exhaustive switch now has an
unhandled case (add a branch or a `default`).
