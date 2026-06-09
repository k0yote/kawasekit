---
"kawasekit": minor
---

# M6-3a (slice 4a) — A3 request authenticator v2 (ceremonyId + ssid + freshness)

Hardens the `mpc-2p` wire's A3 request authentication (RFC m6-3a §4.6). The authenticator
now binds the request to a per-ceremony id, an ssid, and a **freshness** element (a timestamp
+ a per-request nonce distinct from the EIP-3009 nonce), so a captured request can no longer be
replayed at the auth layer or re-aimed at a different ceremony:

```
v1:  HMAC_k( canonical(intent) )
v2:  HMAC_k( wireVersion ‖ ceremonyId ‖ ssid ‖ canonical(intent) ‖ freshness{ts, nonce} )
```

The backend additionally enforces a clock-skew window + a freshness seen-set (a best-effort
anti-replay/DoS guard — fund-safety still rests on the durable idempotency + atomic SpendState
store, unchanged). The `createMpc2pPolicyGatedSigner` adapter generates `ceremonyId` / `ssid` /
`freshness` per `sign()` (Web Crypto) — **the injected interfaces are unchanged**, so integrators
using the adapter + the private glue are unaffected.

## Wire v2 (bumped) — for direct `CoSignFrame` consumers

- `WIRE_VERSION` is now `2`. The `CoSignFrame` `request` variant gains `ceremony_id`, `ssid`,
  `freshness_ts`, and `freshness_nonce`. A v1 request is rejected by the backend.
- **Breaking export rename:** `canonicalIntentBytes(intent)` → `canonicalRequestBytes(env)` over
  a new `CoSignRequestEnvelope` (`{ ceremonyId, ssid, intent, freshnessTs, freshnessNonce }`),
  encoding `kawasekit-mpc-2p/cosign-request/v3`. Both were introduced in `0.3.0`; this is the
  only API delta and it lives entirely on the (opt-in) `mpc-2p` wire surface.
