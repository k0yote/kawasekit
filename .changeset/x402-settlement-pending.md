---
"kawasekit": minor
---

feat(x402): a settlement that is not final is never reported as a failed payment (#53)

An x402 v2 facilitator can answer `/settle` without a final result: `settlement_pending` (x402 v2
§9 — broadcast, confirmation not yet established; non-terminal), or an error that says nothing about
whether the transaction went out (a 503, a 502 / 504 from a proxy, a dropped connection, a timeout).
Until now these reached the buyer as a failed payment, and a caller that retried the purchase signed
a new authorization — so the first transaction and the new one could both settle.

**`createHttpFacilitator`**

- Resends a request with the byte-identical body when the facilitator could not take it, honouring
  `Retry-After`, within a time budget. On by default
  (`retry: { maxAttempts: 3, budgetMs: 10_000, initialDelayMs: 500 }`); `retry: false` sends once.
  `/verify` is resent after 502 / 503 / 504, a network error or a timeout. `/settle` is resent only
  after a 503 or when nothing was sent (a refused connection, an unresolved host).
- New `timeoutMs` (absent = no timeout). A retry or timeout setting that is not a usable number is
  refused with `X402InvalidConfigError`.
- New `X402SettleOutcomeUnknownError`: every thrown `/settle` failure except one where nothing was
  sent — a 502 / 503 / 504, a dropped connection, a timeout, a body that is not a settle response,
  or a failure answered only after a resend (a proxy can answer 503 after forwarding). The payment
  may still land: reconcile on chain, never ask for a new authorization. The underlying failure is
  `cause`.
- New `X402FacilitatorTimeoutError`: a `/verify` timeout (and the cause of a settle timeout).
- A non-2xx `/settle` whose body is a settle response is now returned as that answer (it used to
  throw).
- `X402_FACILITATOR_ERROR_CODES` gains `settlement_pending`. This widens the union of its values: an
  exhaustive `switch` over a type derived from it needs the new case.

**`createSelfFacilitator`**

- A transaction that was broadcast but whose receipt did not arrive (timeout, RPC failure) now answers
  `settlement_pending` with the transaction (was `unexpected_settle_error`). `errorMessage` uses
  viem's `shortMessage`, which leaves out the RPC URL.

**`createX402Handler`**

- `settlement_pending`: resends the identical `/settle` (`settlementPendingRetries`, default 1, as the
  x402 reference server does). Still pending: **402 with a `PAYMENT-RESPONSE` header** carrying
  `settlement_pending` and the transaction. Only a success replaces a pending answer. The idempotency
  lease is kept: while the payment is pending a duplicate is answered `payment_in_progress` (verify
  runs first, so once the transaction confirms a duplicate is refused by verify). Not 202: the spec
  defines none, and other x402 clients would read it as success.
- `X402SettleOutcomeUnknownError` (or a settle `X402FacilitatorTimeoutError`) answers 500
  `facilitator_settle_outcome_unknown` (was `facilitator_settle_failed`) and keeps the lease.
- Every settle failure's 402 now carries `PAYMENT-RESPONSE` (the HTTP transport's failure example) —
  only `success`, `errorReason`, `transaction`, `network` and `payer`; a facilitator's `errorMessage`
  and `extra` stay server-side.
- 500 bodies are now `{ error }` only: the thrown `message` is no longer sent to the client (it could
  quote an RPC URL, and an RPC URL can carry an API key).

**`x402Middleware` (Hono)**

- Passes every handler option through (`hooks`, `idempotency` and `settlementPendingRetries` were
  dropped before) and keeps one idempotency store across requests (it used to build a fresh one per
  request, so no lease outlived its request).

**`wrapFetch`**

- A paid retry answered `settlement_pending` is reported as a `client_payment` failure with reason
  `settlement_pending` (was `settle_rejected`) and, when the server named it, the broadcast
  `transaction` (a new optional field on the failure variant). A 500
  `facilitator_settle_outcome_unknown` is reported as `settle_outcome_unknown` (was `http_error`).
  It still makes one paid attempt and never signs a second authorization.

**Behavior changes to check:** facilitator calls now retry by default; dashboards or alerts keyed on
`settle_rejected`, `http_error`, `facilitator_settle_failed` or `unexpected_settle_error` will also see
`settlement_pending`, `settle_outcome_unknown` and `facilitator_settle_outcome_unknown`; a client that
read `message` from a 500 body gets `{ error }` only.
