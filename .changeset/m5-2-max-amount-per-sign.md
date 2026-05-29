---
"kawasekit": minor
---

# M5-2 — `maxAmountPerSign` signer ceiling

Closes the second `THREAT_MODEL.md` `0.1.0` GA fund-correctness gate (with §6.1):
the **amount** a signer will authorize is now pinnable at the primitive, the way
the **asset** already is (threat 1.4).

`createX402PaymentSigner` gains an optional `maxAmountPerSign?: bigint`:

- `sign()` throws `X402InvalidPayloadError` when `requirements.amount` exceeds
  the ceiling (equal is allowed); a non-positive ceiling is rejected at
  construction.
- Covers the **direct-signer path**, which bypasses the `wrapFetch` `onPayment`
  guard, and the **EOA-payer x402 flow**, which is not bounded by the Layer-4
  session-key daily limit (threat 1.14).
- **Optional / backward-compatible.** Omit it for no ceiling (the payer EOA
  balance remains the only bound). Production posture is to set it — the verdict
  on threat 1.14 stays `⚠️ Operator responsibility`, exactly parallel to 1.4.

Threat 1.14 is updated from a future affordance to a shipped one. Tests:
`src/x402/client.test.ts` (over-ceiling throw / at-ceiling pass / under-ceiling /
unset = no ceiling / non-positive construction reject).
