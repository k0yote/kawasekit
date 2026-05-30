---
"kawasekit": minor
---

# Redis IdempotencyStore adapter + Mastra idempotency example

`createRedisIdempotencyStore` (`kawasekit/idempotency/redis`) — a cross-replica
(Layer 3) durable backing store for the M5-1 reasoning-step idempotency layer.

- **Client-agnostic, no new dependency.** Pass a thin `IdempotencyRedisClient`
  (an `eval` shim over your own `ioredis` / `node-redis` instance), so kawasekit
  takes no Redis dependency and the operator owns the connection.
- **Atomic.** The race-free `begin` runs server-side in Redis via a Lua `eval`
  (done-check + `SET NX` lease); expiry and crash recovery use Redis-native TTL.
- Pass it to `CreateX402HandlerParams.idempotency.store` to deduplicate identical
  re-sent / concurrent paid requests across **all** server replicas — the
  in-memory default is single-process.

The agent example (`examples/agent-x402-jpyc`) now wires reasoning-step
idempotency at the tool-execution boundary (`idempotencyKeyFor` +
`deriveIdempotencyKey`), deriving the key from the request intent so it is
concurrency-safe under the LLM's parallel tool calls.
