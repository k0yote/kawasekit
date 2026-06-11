---
"kawasekit": minor
---

mpc-2p adapter wire hardening (M6-3a Track C, slices 4b+4c — RFC §4.7/§4.8):

- **Transient-only retry (4b/H2):** a bounded retry that replays the byte-identical
  `PaymentIntent` (nonce included — the backend's idempotency-by-nonce + atomic
  SpendState are the safety net) under a fresh A3 envelope. Delivered rejections,
  bans/identifiable-aborts, protocol anomalies, and timeouts are never retried.
- **Idempotent-replay acceptance (4b):** a roundless backend `result` (the cached
  signature for an already-committed nonce) is now accepted via the RFC §4.4
  ecrecover/low-S self-check — previously a retry-after-commit always threw. The
  live co-signed path performs the same recovery self-check.
- **Ceremony liveness (4c/W11/M1+M3):** the ceremony deadline always fires before
  `intent.validBefore − clockSkewBudget`, and a `sign()` whose remaining validity
  window is under `minWindowSecs + clockSkewBudgetSecs` is refused up front — a
  co-signature can never be born expired.
- **Inbound bound (4c/M3):** round payloads over `maxFrameBytes` (default 8 MiB,
  mirroring the backend's `MAX_FRAME_BYTES`) are refused before the WASM boundary.

New public surface (additive): `Mpc2pSignerParams.wire` (`Mpc2pWireOptions`),
`CoSignUnavailableError.transient`, and the `MAX_FRAME_BYTES` constant.
