---
"kawasekit": minor
---

feat(x402): treat `settlement_pending` and an unavailable facilitator as "not final" (#53)

An x402 v2 facilitator can answer `/settle` without a final result: `settlement_pending` (x402 v2
§9 — broadcast, confirmation not yet established; non-terminal), or 503 when it could not take
the request. Until now both reached the buyer as a failed payment, and a caller that retried the
purchase signed a new authorization — so the pending transaction and the new one could both settle.

**`createHttpFacilitator`**

- Resends a request with the byte-identical body when the facilitator could not take it,
  honouring `Retry-After`, within a time budget. On by default
  (`retry: { maxAttempts: 3, budgetMs: 10_000, initialDelayMs: 500 }`); `retry: false` sends once.
  `/verify` is resent after 502 / 503 / 504, a network error or a timeout. `/settle` is resent
  **only after a 503** (or a refused connection / unresolved host — nothing was sent): after a
  502 / 504, a connection dropped after sending or a timeout, the first attempt may have broadcast.
- New `timeoutMs` (absent = no timeout).
- New errors: `X402SettleOutcomeUnknownError` — a `/settle` the facilitator may have acted on and
  that is not resent (cause: the 502 / 504, the network error or the timeout); the payment may
  still land, so reconcile on chain and never ask for a new authorization. `X402FacilitatorTimeoutError`
  — a `/verify` timeout (and the cause of a settle timeout).
- `X402_FACILITATOR_ERROR_CODES` gains `settlement_pending`.

**`createX402Handler`** (and the Hono middleware)

- `settlement_pending`: resends the identical `/settle` (`settlementPendingRetries`, default 1, as
  the x402 reference server does). Still pending: **402 with a `PAYMENT-RESPONSE` header** carrying
  `settlement_pending` and the transaction, and the idempotency lease is kept, so a duplicate is
  answered `payment_in_progress`. Only a success replaces a pending answer. (Not 202: the spec
  defines none, and other x402 clients would read it as success.)
- Every settle failure's 402 now carries `PAYMENT-RESPONSE` too (the HTTP transport's failure
  example).
- A settle whose outcome is unknown answers 500 `facilitator_settle_outcome_unknown` (was
  `facilitator_settle_failed`) and keeps the lease.

**`wrapFetch`**

- A paid retry answered `settlement_pending` is reported as a `client_payment` failure with reason
  `settlement_pending` (was `settle_rejected`) and the broadcast `transaction` (a new optional field
  on the failure variant). It still makes one paid attempt and never signs a second authorization.

**Behavior changes to check:** facilitator calls now retry by default; dashboards or alerts keyed on
`settle_rejected` or `facilitator_settle_failed` will also see `settlement_pending` and
`facilitator_settle_outcome_unknown`. No exported type is narrowed.
