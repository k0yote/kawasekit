# Recipe: Session-Key Revoke Race — Immediate Operator Mitigations

**Threat reference**: [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md) Threat 3.4
("Revoke race") and §6.3 ("Soft revoke (nonce-key invalidation) for session
keys").

**Status**: Operator playbook for kawasekit ≤ v0.1.x. The SDK-level fix
(nonce-key invalidation in the same revoke UserOp) is tracked for M5 — see
the **Roadmap** section at the bottom of this page.

---

## When to use

Run this playbook when **any** of the following is true:

- An agent-side incident has leaked the session-key private key (PK + envelope)
  or there is credible suspicion it has (logs ingested by a third party, an
  agent runtime that wrote secrets to disk, a stolen developer laptop, a
  compromised CI runner that touched session credentials).
- A spending-pattern monitor (your own or `examples/observability/`) shows
  session-key UserOps that you cannot attribute to legitimate agent traffic.
- A merchant downstream of the agent has reported chargeback-style suspicion
  (duplicate or unexpected paywall hits sourced from one of your session
  keys).

This recipe describes the **minutes-window** response. The single
`revokeSessionKey()` call (Layer 1 below) is necessary but **not sufficient**
on its own — it leaves a race window in which already-in-flight UserOps can
still mine. The other three layers exist to compress what an attacker can
extract during that window.

---

## Layer 1 — SDK call: `revokeSessionKey`

This is the on-chain action. Submit it first and in parallel with the other
layers; do not block on it.

```ts
import { createPublicClient, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSudoKernelClient,
  parseSessionEnvelope,
  revokeSessionKey,
  X402_DEFAULT_BUNDLER_URL_AMOY,
} from "kawasekit";

const publicClient = createPublicClient({ chain: polygonAmoy, transport: http() });
const ownerSigner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as `0x${string}`);
const envelope = parseSessionEnvelope(await fs.readFile(envelopePath, "utf8"));

// CRITICAL — see src/session/revoke.ts JSDoc: must be sudo-only.
const ownerKernelClient = await buildSudoKernelClient({
  publicClient,
  signer: ownerSigner,
  bundlerUrl: X402_DEFAULT_BUNDLER_URL_AMOY,
});

const { transactionHash } = await revokeSessionKey({
  ownerKernelClient,
  envelope,
  ownerSigner,
  // policies must match the originally-installed policies exactly
  policies: originalPolicies,
});
console.log("revoke broadcast:", transactionHash);
```

**Latency profile (Polygon Amoy / PoS mainnet)**:

| Stage | Typical | P95 |
|---|---|---|
| Bundler accepts UserOp | < 1 s | 3 s |
| UserOp included on-chain | 5–15 s | 60 s |
| Receipt with `confirmations: 1` | + ~2 s | + ~6 s |
| Receipt with `confirmations: 4` (mainnet recommended) | + ~8 s | + ~24 s |

Anything the session key signed and submitted to the bundler **before** the
revoke UserOp lands can still settle inside that window. That is the gap the
remaining layers close.

---

## Layer 2 — Off-chain merchant endpoint shutdown

The attacker's last useful surface is a paywall endpoint that accepts the
compromised session key's payments. Take those endpoints offline as fast as
the broadcast above.

### 2a. Hono adapter — flip a kill-switch

If you wired the kawasekit Hono adapter (`createX402Handler` exposed via
`/verify` and `/settle`), gate them on a flag:

```ts
const INCIDENT_FREEZE = process.env.KAWASEKIT_INCIDENT_FREEZE === "1";

app.post("/verify", async (c, next) => {
  if (INCIDENT_FREEZE) return c.json({ error: "service_suspended" }, 503);
  return next();
});
app.post("/settle", async (c, next) => {
  if (INCIDENT_FREEZE) return c.json({ error: "service_suspended" }, 503);
  return next();
});
```

Flip the env var with whatever mechanism your platform supports
(`fly secrets set`, `kubectl set env`, Cloudflare Workers `wrangler secret`,
etc.) and trigger a rolling restart. Time-to-effect is typically 10–60 s,
which is comparable to or faster than the revoke inclusion latency above.

### 2b. nginx / Cloud Run maintenance mode

If the SDK is fronted by a reverse proxy, return 503 at the proxy:

```nginx
location ~ ^/(verify|settle)$ {
  return 503 "service_suspended\n";
}
```

`nginx -s reload` is sub-second.

### 2c. Tradeoff

Both 2a and 2b are **blunt** — they stop all paywall traffic, not just the
compromised session key. This is intentional: in a minutes-window incident
the cost of refusing a few legitimate calls is dramatically less than
allowing the attacker to keep settling. After Layer 1 lands you can lift the
freeze.

---

## Layer 3 — Paymaster sponsorship freeze

If you sponsor the agent's smart account through ZeroDev's paymaster (or any
other ERC-4337 paymaster with a policy API), revoke the sponsorship for the
specific smart-account address. Without sponsorship, any new UserOp from the
session key will fail bundler simulation (no `paymasterAndData`, no gas), so
the attacker cannot bypass the revoke window even if they have signed
UserOps in hand.

### ZeroDev dashboard

1. Open your ZeroDev project at <https://dashboard.zerodev.app>.
2. Navigate to **Gas Policy** → the policy that covers this agent.
3. Add the smart-account address to the **deny list**, or temporarily set
   the policy's daily/monthly cap to `0`.
4. Save. Changes propagate in a few seconds to the bundler/paymaster.

### Programmatic (where supported)

ZeroDev's policy API is not in scope for kawasekit, but if your
infrastructure has the equivalent of:

```ts
await paymasterClient.policies.update(projectId, {
  type: "deny_smart_account",
  address: envelope.smartAccountAddress,
});
```

call it from the same incident-response script that triggered Layer 1.

### Tradeoff

Layer 3 only helps if the attacker is relying on **your** paymaster
sponsorship. If they fund the smart account with native gas themselves
(impractical at scale but possible for a one-shot drain), this layer is
ineffective and you fall back on Layers 1 + 2.

---

## Layer 4 — Mempool monitoring

While the above three layers are taking effect, you want telemetry on what
the attacker is doing inside the race window. Watch the bundler mempool for
UserOps whose `sender` is the compromised smart account.

### ZeroDev bundler (or any 4337 bundler with a public RPC)

```bash
# Poll the bundler's debug_bundler_dumpMempool every 2 s and grep for sender.
SMART_ACCOUNT="0x..."   # envelope.smartAccountAddress
BUNDLER_URL="https://rpc.zerodev.app/api/v3/<projectId>/chain/80002"

while true; do
  curl -s -X POST "$BUNDLER_URL" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"debug_bundler_dumpMempool","params":["0x0000000071727De22E5E9d8BAf0edAc6f37da032"],"id":1}' \
    | jq --arg s "$SMART_ACCOUNT" '.result[] | select(.sender | ascii_downcase == ($s | ascii_downcase))'
  sleep 2
done
```

> **Note**: `debug_bundler_*` is part of the ERC-4337 debug bundler RPC. Not
> every public bundler exposes it; check your provider docs. ZeroDev's
> shared bundler exposes the namespace on project endpoints.

### What you can do with this telemetry

You **cannot** unilaterally drop another participant's UserOps from a
public mempool. What you can do:

- Confirm the attacker is actively trying (informs the rest of the response).
- Get advance notice of in-flight value at risk (size the incident).
- Feed alerts to your on-call channel so the human in the loop can decide
  whether to escalate to merchant-side refund preparation.

If you operate a **private** bundler for your own agents, you can drop the
session-key UserOps directly. Most operators do not, which is why this layer
is monitoring, not enforcement.

---

## Known residual risk

Even with all four layers running in parallel, **any UserOp the session key
signed and that the bundler accepted before Layer 1 lands can still mine**.
This is the fundamental gap §6.3 documents:

- The revoke is itself a single UserOp; it sits in the mempool too.
- A bundler may include the attacker's earlier UserOp in the same bundle as
  (or one bundle ahead of) the revoke.
- The on-chain spending policy on the session-key validator still applies
  during the race — the cap is the per-validator daily limit, not zero.

So the **worst case** in the race window is bounded by the session-key
validator's per-day policy cap. Operators who require a hard zero must
treat the daily-limit as the worst-case exposure for incident planning,
not as a number the policy can magically reduce after the fact.

---

## Roadmap

The structural fix is **soft revoke via nonce-key invalidation**:
`revokeSessionKey` would, in the same sudo UserOp that uninstalls the
validator, also call `invalidateNonce` on the session-key validator's nonce
key. Any in-flight UserOp signed by the session key would then fail
simulation against the new nonce state and bundlers would drop it before
inclusion.

The kawasekit `RevokeSessionKeyParams` type already exposes a
`invalidateInFlightNonces?: boolean` option in `src/session/revoke.ts` to
lock in the API shape; today it throws `"not implemented"` to make the
expected M5 surface visible without shipping a half-working implementation.
See `.claude/m5-features-candidates.md` for the implementation candidate.

Until that lands, this four-layer playbook is the operational answer.
