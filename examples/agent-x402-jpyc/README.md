# agent-x402-jpyc

> kawasekit M3 — a Claude agent that pays a Hono paywall in JPYC on Polygon Amoy.

This example wires together the three M3 milestones:

- **M3-1 x402 client + server** — a Hono server gates `GET /weather/:city`
  behind a JPYC v2 x402 payment; the agent's wrapped `fetch` pays it.
- **M3-1 self-facilitator** — settlement runs locally (a kawasekit-managed
  EOA broadcasts `transferWithAuthorization` on Amoy). No Coinbase CDP /
  external facilitator needed.
- **M3-2 session-key lifecycle** — sidecar demo shows owner-side envelope
  issuance + agent-side restore on a fresh `PublicClient`.

The two processes (server + agent) run in the same Node tree but talk
exclusively over HTTP. The agent's only x402 surface is `wrapFetch`;
everything else is plain Mastra + Anthropic SDK.

## What lands on-chain

```
agent EOA  ──signs EIP-3009──▶  facilitator EOA  ──broadcasts──▶  JPYC contract
   │                                  │                              │
   │                              pays POL                            │
   │                                                                  │
   └────────────────────── 0.001 JPYC ───────────────────────────▶ recipient
```

Every paid call produces one Amoy tx. The agent logs the Polygonscan URL
on the way out.

## Prerequisites

1. **Node 22+** and **pnpm 11+**.
2. **Polygon Amoy** keys (use throwaway EOAs):
   - **Facilitator EOA** — funded with a tiny amount of Amoy **POL** for
     gas. Faucet: <https://faucet.polygon.technology/>.
   - **Agent payer EOA** — funded with Amoy **JPYC**. Faucet:
     <https://faucet.jpyc.co.jp/>. 0.1 JPYC supports ~100 calls.
   - **Recipient EOA** — any address you control (the JPYC destination).
3. **Anthropic API key** — get one at <https://console.anthropic.com/>.
   ~$0.02–0.05 for a 3-city run on `claude-sonnet-4-5`.
4. (Optional) **Owner EOA** — only needed for `dev:session-demo`. Sudo
   authority over the agent's smart account. Must be distinct from the
   agent payer.

## Setup

```bash
# from repo root
pnpm install
pnpm --filter kawasekit build  # produces dist/ that the example links to

# in this folder
cd examples/agent-x402-jpyc
cp .env.example .env
# edit .env — fill in the four private keys + ANTHROPIC_API_KEY + X402_RECIPIENT
```

## Run the demo

In two terminals:

```bash
# terminal 1 — paywall server
pnpm dev:server
# →  listening on http://127.0.0.1:8787
# →  paywalled route: GET /weather/:city
```

```bash
# terminal 2 — agent
pnpm dev:agent
# Claude reads the prompt, calls fetch_weather 3 times, pays for each call.
# Final output is a one-line summary per city plus a wrap-up.
```

### Expected output

The agent terminal looks roughly like:

```
=== agent-x402-jpyc — Mastra weather agent ===
payer EOA:       0x...
server:          http://127.0.0.1:8787
Anthropic model: claude-sonnet-4-5
budget:          0.01 JPYC (= 10000000000000000 wei)
prompt:          What's the weather in Tokyo, Osaka, and Kyoto? ...

→ fetch_weather("Tokyo")
  ↳ paid 0.001 JPYC  tx 0x...
→ fetch_weather("Osaka")
  ↳ paid 0.001 JPYC  tx 0x...
→ fetch_weather("Kyoto")
  ↳ paid 0.001 JPYC  tx 0x...

--- agent reply ---
Tokyo is currently 24°C and sunny.
Osaka is currently 22°C and cloudy.
Kyoto is currently 25°C and sunny.
Overall, the Kansai region is warm and pleasant; pack light layers.

--- payments summary ---
  Tokyo           0.001 JPYC  https://amoy.polygonscan.com/tx/0x...
  Osaka           0.001 JPYC  https://amoy.polygonscan.com/tx/0x...
  Kyoto           0.001 JPYC  https://amoy.polygonscan.com/tx/0x...
  total:          0.003 JPYC of 0.01 budget
```

Click any tx URL to inspect the on-chain JPYC `transferWithAuthorization`
event.

The server terminal logs each settlement as it happens:

```
  ↳ paid 0.001 JPYC by 0x... | tx 0x...
```

## Session-key sidecar

`pnpm dev:session-demo` runs the M3-2 lifecycle in isolation:

```bash
# requires OWNER_PRIVATE_KEY in .env (separate from the agent payer)
pnpm dev:session-demo
# →  [1/3] Owner issues a session envelope...
# →  [2/3] Serializing envelope to .agent-state/session.json...
# →  [3/3] Agent reads the envelope and restores on a fresh PublicClient...
# →  ✅ Roundtrip OK.
```

The session-key path is intentionally **independent of the agent**: JPYC's
EIP-3009 implementation rejects smart-account `from` addresses (pure
`ecrecover`, no ERC-1271 fallback), so x402 payments must come from an
EOA. The session key controls a separate **smart account** via ERC-4337
UserOps — useful for budgeted, owner-supervised agent actions that don't
go through x402.

To exercise the on-chain UserOp + revoke flows, run the root scripts:

```bash
# from repo root, with OWNER_PRIVATE_KEY + SESSION_KEY_PRIVATE_KEY + ZERODEV_PROJECT_ID
pnpm m3:session-issue-restore    # issue → restore → one sponsored transfer
pnpm m3:session-revoke           # transfer → revoke → asserted post-revoke failure
```

## What kawasekit gives you here

| code path | kawasekit symbol | does what |
|---|---|---|
| server `app.use("/weather/*", x402Middleware(...))` | `x402Middleware` from `kawasekit/x402/hono` | turns any Hono route into an x402 paywall |
| server `createSelfFacilitator(...)` | `createSelfFacilitator` | local verify + settle; no Coinbase CDP / external facilitator |
| server `buildPaymentRequirements(...)` | `buildPaymentRequirements` | well-formed v2 `PaymentRequirements` with the JPYC `extra` baked in |
| agent `wrapFetch({ signer, onPayment, idempotencyKeyFor })` | `wrapFetch` | any `fetch` becomes x402-aware; `onPayment` is the budget hook; `idempotencyKeyFor` adds reasoning-step idempotency |
| agent `createX402PaymentSigner({ network, account, asset })` | `createX402PaymentSigner` | EOA-bound signer that produces EIP-3009 authorisations; `asset` pins the EIP-712 domain (use `{ kind: "known", id: "jpyc-v2" }`) |
| agent `deriveIdempotencyKey({ conversationId, stepId, intent })` | from `kawasekit/idempotency` | a deterministic reasoning-step key → derived EIP-3009 nonce |
| sidecar `issueSessionKey` / `restoreSessionAccount` | from `kawasekit/session` | owner-side issuance + agent-side restoration with chain / version / signer fail-fast |

Each of these has a JSDoc `@example` in the source. Read them straight
from your editor's hover popup.

### Reasoning-step idempotency (M5-1)

An LLM agent can pay **twice for one intent** — a retry, a "Regenerate", or
multi-agent fan-out re-signs the same logical request. This example wires the
M5-1 idempotency layer so that does not cost real JPYC twice:

- The agent passes `wrapFetch`'s `idempotencyKeyFor`, deriving a key from the
  request (`deriveIdempotencyKey`). The same intent → the same key → the **same
  EIP-3009 nonce**, so a re-signed duplicate is rejected on-chain by the JPYC
  contract's `authorizationState` — across uncoordinated replicas.
- The server's dedup store is **default-on** (`createX402Handler`), so identical
  re-sends replay the cached `200` instead of settling again. For a multi-replica
  server, pass a shared store: `createRedisIdempotencyStore` from
  `kawasekit/idempotency/redis`.

Claude fans out `fetch_weather` calls **in parallel**, so the example derives the
key from the request URL (the city = the intent) rather than a monotonic
counter, which would race under parallel tool calls. See the comment on
`idempotencyKeyFor` in `agent/index.ts`.

## Switching to production: replace `env://` with `kms://`

This example loads private keys through a thin `createPkProvider(uri)`
abstraction (see [`lib/pk-provider.ts`](./lib/pk-provider.ts)). By default
the URIs resolve to `env://VARNAME`, which:

- reads the key from `process.env[VARNAME]`,
- emits a loud `console.warn` on construction so you cannot miss the
  posture in CI logs, and
- is tagged `kind: "demo"` so downstream code can refuse to run with a
  demo provider when `NODE_ENV === "production"`.

To switch to a production posture, point the URI at `kms://<resource>`:

```bash
# Demo (default — what you get by copying .env.example):
AGENT_PAYER_PK_URI=env://AGENT_PAYER_PRIVATE_KEY
X402_FACILITATOR_PK_URI=env://X402_FACILITATOR_PRIVATE_KEY

# Production posture (after you wire your KMS SDK into pk-provider.ts):
AGENT_PAYER_PK_URI=kms://arn:aws:kms:ap-northeast-1:111111111111:key/abcd...
X402_FACILITATOR_PK_URI=kms://projects/your-gcp/locations/global/keyRings/.../cryptoKeys/...
```

The `kms://` branch in `pk-provider.ts` is intentionally a `throw` today
— kawasekit does **not** bundle a KMS adapter, because key custody is
operator territory (`docs/THREAT_MODEL.md` Threat 2.1 / 5.6). When you
replace the `throw` with your KMS SDK calls (`@aws-sdk/client-kms`,
`@google-cloud/kms`, `node-vault`, etc.), the rest of the example does
not need to change — only the provider implementation does.

## Troubleshooting

**`Smart account has 0 JPYC`** — the agent payer EOA has no Amoy JPYC.
Fund it via <https://faucet.jpyc.co.jp/>.

**`Facilitator has 0 POL`** — the facilitator EOA can't pay gas. Fund it
via <https://faucet.polygon.technology/>.

**`Module 'kawasekit/x402/hono' has no exported member ...`** — re-build
kawasekit: `pnpm --filter kawasekit build` from the repo root.

**`401 / Anthropic API error`** — `ANTHROPIC_API_KEY` is wrong or
unfunded. Check <https://console.anthropic.com/>.

**Amoy bundler timeouts past 60 s** — the public RPC is rate-limited.
Set `POLYGON_AMOY_RPC_URL` to an Alchemy / Infura / QuickNode endpoint.

## Where to look in the source

- `server/index.ts` — Hono app + facilitator setup. ~130 lines.
- `agent/index.ts` — Mastra agent + Claude provider + payment hooks. ~170
  lines.
- `scripts/session-demo.ts` — M3-2 issue/restore round-trip. ~110 lines.

If you want to swap Mastra for a different agent framework (LangChain.js,
Vercel AI SDK direct), `wrapFetch` is the only kawasekit surface you
need; everything else is your framework's tool/agent convention.
