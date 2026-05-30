# kawasekit

> TypeScript SDK for stablecoin payments by AI agents. Japan-first, JPYC-native.

[![npm version](https://img.shields.io/npm/v/kawasekit.svg)](https://www.npmjs.com/package/kawasekit)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

🚧 **Status**: M5 backbone complete — `kawasekit@0.1.0-beta.3` is published on npm (SLSA provenance, `beta` dist-tag) and mainnet-capable, with payment flows verified on Polygon mainnet. **Not yet GA**, but **both `0.1.0` fund-correctness gates are now closed**:

- **Reasoning-step idempotency** ([`docs/THREAT_MODEL.md` §6.1](./docs/THREAT_MODEL.md), now closed) — a default-on server dedup layer prevents duplicate payments for identical re-sends, and an opt-in client-derived EIP-3009 nonce makes the token contract reject re-signed same-intent duplicates on-chain. See the [idempotency note](#x402-paywall-m3-1).
- **`maxAmountPerSign`** (threat 1.14) — the signer can now pin a per-signature value ceiling, the way it already pins the asset.

This removes the earlier blanket "small per-call values only" caveat: preventing duplicate payment is now a matter of correct integration (wiring a reasoning-step key for the regenerate / fan-out case), not a missing SDK capability. GA (`0.1.0` on the `latest` tag) now waits on a **clean one-week beta soak**. Review happens **continuously in the open**: issues and counter-examples are welcome on GitHub and via [SECURITY.md](./SECURITY.md) (the §6.1 gap itself came from public feedback). A formal third-party audit is a goal on the road to `1.0`, not a `0.1.0` GA blocker. Built in public.

```bash
pnpm add kawasekit@beta   # 0.1.0-beta.3 — pre-GA, mainnet-capable
```

## Vision

kawasekit gives AI agents a way to pay for things using stablecoins — without exposing developers to chain selection, gas management, or signing complexity.

Today, AI services force users into monthly subscriptions and API key sprawl. As agentic workflows become common, the per-call cost model breaks down. kawasekit treats payments as a primitive: an agent submits an operation, the SDK handles the rest.

Built around modern account abstraction (ERC-4337 / Kernel v3.1) and Japan's first regulated yen stablecoin (JPYC, classified as 電子決済手段 under 改正資金決済法), with global expansion targeting Kaia and the broader Asia stablecoin ecosystem.

## Roadmap

- [x] **M1**: Smart account skeleton on Polygon Amoy
- [x] **M2**: JPYC transfer via UserOp + EIP-3009 signing helpers + Daily Limit spending policy
- [x] **M3**: x402 v2 server/client/facilitator + session-key lifecycle + Mastra/Hono integration example
- [x] **M4**: Polygon mainnet support + observability (Prometheus / OTLP) + CLI + docs site + npm `0.1.0-alpha`/`0.1.0-beta` release
- [ ] **M5** *(backbone done)*: reasoning-step idempotency layer (§6.1 ✅) + `maxAmountPerSign` ceiling (✅) → **both `0.1.0` fund-correctness gates closed**. Remaining: `0.1.0` GA promote (after a clean beta soak) and Kaia support (fast-follow). The README roadmap's framing — "Community building + first real integrations" — is the *outcome*; closing these gaps is the technical *prerequisite* for it.
- [ ] **M6**: Managed service alpha + Rust policy engine

## Quick Start

```bash
git clone https://github.com/k0yote/kawasekit.git
cd kawasekit
pnpm install
pnpm --filter kawasekit build   # builds dist/ (consumed by the example app)
cp .env.example .env
# Fill in OWNER_PRIVATE_KEY + ZERODEV_PROJECT_ID
# (M2-3 onward also needs SESSION_KEY_PRIVATE_KEY)
# (M3-1 scripts/07 needs X402_PAYER_PRIVATE_KEY + X402_FACILITATOR_PRIVATE_KEY)

pnpm m1:create-account          # M1: create a Kernel smart account
pnpm m2:transfer-jpyc           # M2-2: send JPYC.transfer() via UserOp
pnpm m2:transfer-with-policy    # M2-3: same, gated by Daily Limit policy
pnpm m3:x402-self-settle        # M3-1: end-to-end x402 payment on Amoy
pnpm m3:session-issue-restore   # M3-2: session-key issue → restore round-trip
pnpm m3:session-revoke          # M3-2: revoke flow with pre/post assertions
```

The M2 + M3 transfer scripts require a JPYC-holding address on Polygon Amoy.
JPYC on Amoy is available via the [JPYC faucet](https://faucet.jpyc.co.jp/).

### Try the agent example (M3-3)

A runnable [Mastra-driven Claude agent](./examples/agent-x402-jpyc/) that
pays a Hono paywall in JPYC over x402:

```bash
cd examples/agent-x402-jpyc
cp .env.example .env             # fill in payer / facilitator / Anthropic keys
pnpm dev:server                  # terminal 1 — the paywall server
pnpm dev:agent                   # terminal 2 — the LLM agent
```

The agent picks tool calls via Claude Sonnet, each `fetch_weather` invocation
pays 0.001 JPYC, and the summary prints Polygonscan tx URLs for every
settlement. See the [example README](./examples/agent-x402-jpyc/README.md)
for the full walkthrough.

### CLI (M4-4)

Installing the package exposes a `kawasekit` binary (`npx kawasekit <cmd>`, or
`pnpm exec kawasekit` in a workspace):

```bash
pnpm add kawasekit@beta

npx kawasekit init                              # scaffold .env + required vars
npx kawasekit account create --chain polygonAmoy   # deploy a Kernel smart account
npx kawasekit policy create  --chain polygonAmoy   # build a Daily Limit policy
npx kawasekit transfer       --chain polygonAmoy   # send JPYC via a sponsored UserOp
npx kawasekit session-key issue   --chain polygonAmoy   # issue a session key + envelope
npx kawasekit session-key restore --chain polygonAmoy
npx kawasekit session-key revoke  --chain polygonAmoy
npx kawasekit session-key rotate  --chain polygonAmoy
```

Every on-chain command takes `--chain "polygon" | "polygonAmoy"`. Mainnet
(`--chain polygon`) additionally requires `KAWASEKIT_ALLOW_MAINNET=1` in the
environment as a safety guard against accidental real-funds broadcasts.

### Programmatic use (M2)

```typescript
import { parseUnits } from "viem";
import {
  createAgentSmartAccount,
  createJpycDailyLimitPolicies,
  getJpycAddress,
  JPYC_DECIMALS,
  polygonAmoy,
  transferJpyc,
} from "kawasekit";

// 1) Build a session-key-gated agent smart account
const policies = createJpycDailyLimitPolicies({
  jpycAddress: getJpycAddress(polygonAmoy.id),
  maxPerTransfer: parseUnits("100", JPYC_DECIMALS),  // 100 JPYC / tx
  maxTransfersPerDay: 10,                             // 10 tx / day
});

const account = await createAgentSmartAccount({
  publicClient,
  ownerSigner,       // viem LocalAccount — full sudo
  sessionKeySigner,  // viem LocalAccount — restricted by `policies`
  policies,
});

// 2) Send JPYC as a sponsored UserOp
const { userOpHash, transactionHash } = await transferJpyc(kernelClient, {
  to: "0xBeef...",
  amount: parseUnits("50", JPYC_DECIMALS),
});
```

### EIP-3009 EOA-payer signing

```typescript
import { privateKeyToAccount } from "viem/accounts";
import {
  authorizationDeadlineFromNow,
  generateAuthorizationNonce,
  JPYC_EIP712_DOMAIN_HINT,
  signTransferWithAuthorization,
} from "kawasekit";

const account = privateKeyToAccount("0x...");
const signed = await signTransferWithAuthorization(
  account,
  { ...JPYC_EIP712_DOMAIN_HINT, chainId: 137, verifyingContract: "0xE7C3..." },
  {
    from: account.address,
    to: "0xPayee...",
    value: parseUnits("100", JPYC_DECIMALS),
    validAfter: 0n,
    validBefore: authorizationDeadlineFromNow(300),
    nonce: generateAuthorizationNonce(),
  },
);
// Pass (signed.v, signed.r, signed.s) to JPYC.transferWithAuthorization on chain.
```

> ⚠ EIP-3009 cannot be used to spend from a smart account: JPYC's signature check is pure `ecrecover`, so `from` must be an EOA. Agent-controlled smart accounts use `transferJpyc()` instead.

### x402 paywall (M3-1)

Server (Hono):

```typescript
import { Hono } from "hono";
import {
  buildPaymentRequirements,
  createSelfFacilitator,
  getJpycAddress,
  JPYC_DECIMALS,
  polygonAmoy,
} from "kawasekit";
import { x402Middleware } from "kawasekit/x402/hono";
import { parseUnits } from "viem";

const app = new Hono();
app.use(
  "/weather/*",
  x402Middleware({
    // `network` is required (M4-1): cross-checked against walletClient.chain.isTestnet,
    // throws on mismatch. walletClient.account MUST be built with viem's `nonceManager`
    // — createSelfFacilitator throws at construction otherwise (threat 2.2). On mainnet
    // it waits for 4 confirmations by default (1 on testnet); override with `confirmations`.
    facilitator: createSelfFacilitator({ network: "testnet", walletClient, publicClient }),
    requirementsFor: () => [
      buildPaymentRequirements({
        chainId: polygonAmoy.id,
        asset: getJpycAddress(polygonAmoy.id),
        payTo: "0x...",
        amount: parseUnits("0.001", JPYC_DECIMALS),
      }),
    ],
  }),
);
app.get("/weather/:city", (c) => c.json({ city: c.req.param("city"), weather: "sunny" }));
```

The server **deduplicates identical re-sent paid requests by default** (M5-1): an
in-memory store replays the cached response instead of settling twice, and closes
the verify→settle race. It is single-process — for multi-replica deployments pass a
shared store (or rely on the client-derived nonce below); disable with
`idempotency: { store: "none" }`. See the [idempotency note](#x402-paywall-m3-1) below.

Client (any `fetch` becomes x402-aware):

```typescript
import { createX402PaymentSigner, JPYC_DECIMALS, wrapFetch } from "kawasekit";
import { createIdempotencyKeyBuilder } from "kawasekit/idempotency";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const signer = createX402PaymentSigner({
  network: "testnet",
  account: privateKeyToAccount("0x..."),
  // Pin to the JPYC v2 EIP-712 domain at construction. The wire-format
  // extra.name / extra.version are ignored — Threat 1.4 mitigation.
  asset: { kind: "known", id: "jpyc-v2" },
  // Per-signature value ceiling (M5-2, threat 1.14): refuse to sign any
  // requirement above this. Pins the *amount* the way `asset` pins the token.
  maxAmountPerSign: parseUnits("1", JPYC_DECIMALS), // ≤ 1 JPYC per call
});

// One key builder per agent run; call .next(intent) at each tool-execution
// boundary and reuse the returned key for retries of that step.
const keys = createIdempotencyKeyBuilder({ conversationId: "conv-42" });
let stepKey = keys.next("fetch_weather:Tokyo");

// onPayment is *required* at the type level — kawasekit refuses to default
// to "always pay" silently. The callback is your budget guard.
let spent = 0n;
const MAX_SPEND = parseUnits("100", JPYC_DECIMALS); // 100 JPYC (JPYC has 18 decimals)
const fetch402 = wrapFetch({
  signer,
  onPayment: (req) => {
    const next = spent + BigInt(req.amount);
    if (next > MAX_SPEND) return false; // budget exhausted → 402 returned
    spent = next;
    return true;
  },
  // Reasoning-step idempotency (M5-1): the key is sent as an `Idempotency-Key`
  // header AND derives a deterministic EIP-3009 nonce, so a regenerate /
  // multi-agent re-sign of the SAME intent reuses the nonce and the token
  // contract rejects the duplicate on-chain. Omit for today's random-nonce path.
  idempotencyKeyFor: () => stepKey,
});

const res = await fetch402("https://api.example.com/weather/Tokyo");
// → 402 → onPayment guard → signed retry → 200 with JPYC settled on-chain
```

> **Reasoning-step idempotency (M5-1).** kawasekit now prevents one agent
> reasoning step from paying twice, across two layers:
>
> - **Identical re-send — handled by default.** The server dedup layer (shown in
>   the server example above) replays the cached response for a re-sent /
>   network-duplicate request and closes the verify→settle race — no
>   configuration needed (threat 1.8c, ✅). It is single-process; use a shared
>   store for multiple replicas, or rely on the derived nonce below.
> - **Re-signed same intent — wire the key.** A "Regenerate" click or multi-agent
>   fan-out signs a *fresh* authorization for the same intent. Pass a
>   reasoning-step key (`idempotencyKeyFor` + `createIdempotencyKeyBuilder`, shown
>   in the client example) so the EIP-3009 nonce is derived deterministically and
>   the JPYC contract rejects the duplicate **on-chain**, across uncoordinated
>   replicas. The SDK can't do this for you — it never sees the LLM intent, only
>   your harness does — so this half is **operator responsibility** (threat 1.8b,
>   parallel to the asset pin). Omit the key to fall back to random-nonce behaviour.
>
> See [`docs/THREAT_MODEL.md` §6.1](./docs/THREAT_MODEL.md) (now closed) and the
> [design RFC](./docs/rfc/m5-1-reasoning-step-idempotency.md) for the full model.

### Session-key lifecycle (M3-2)

```typescript
import { issueSessionKey, parseSessionEnvelope, restoreSessionAccount, serializeSessionEnvelope } from "kawasekit";

// Owner side: issue + serialize
const envelope = await issueSessionKey({
  publicClient, ownerSigner, sessionKeySigner, policies,
});
const wire = serializeSessionEnvelope(envelope);   // portable JSON string

// Agent side (different process): restore on a fresh PublicClient
const restored = await restoreSessionAccount({
  publicClient: agentPublicClient,
  envelope: parseSessionEnvelope(wire),
  sessionKeySigner,
});
// → restored.address matches owner-side smart account
```

## Tech Stack

- **Language**: TypeScript 6 (strict, ESM-only)
- **EVM client**: viem v2
- **Account abstraction**: ZeroDev Kernel v3.1 (ERC-4337 v0.7)
- **Build**: tsup
- **Lint/Format**: Biome
- **Runtime**: Node 22+
- **Package manager**: pnpm 11

## Supported Chains

JPYC availability and kawasekit support are **two separate axes**. As of M5-3,
kawasekit ships chain configs for **Polygon, Kaia, Avalanche, and Ethereum**
(+ their testnets) in `src/chains/`, each carrying a per-chain finality default
(`defaultConfirmations`). Two honest caveats: the **x402 EOA-payer path** works
on every chain where JPYC is live, but the **smart-account path** (session keys,
sponsored UserOps) is verified only on Polygon — Kaia's runs via Pimlico in a
later phase. And JPYC is **not yet verified** on Avalanche Fuji / Sepolia, so
`getJpycAddress` throws there.

| Chain (id) | JPYC (`0xE7C3…c29`) | kawasekit support |
|---|---|---|
| Polygon (137) | ✅ Live | ✅ config + x402 + smart-account; verified with live mainnet txs |
| Polygon Amoy (80002) | ✅ Live | ✅ primary testnet target |
| Kaia (8217) | ✅ Live, same address¹ | ✅ M5-3 config — x402 EOA path; smart-account via Pimlico (later) |
| Kaia Kairos (1001) | ✅ Live (faucet) | ✅ M5-3 config — x402 EOA path |
| Avalanche (43114) | ✅ Live | ✅ M5-3 config — x402 EOA path; smart-account untested |
| Avalanche Fuji (43113) | ❓ unverified | ⚠️ config shipped; JPYC unverified (`getJpycAddress` throws) |
| Ethereum (1) | ✅ Live | ✅ M5-3 config — x402 EOA path; smart-account untested; deep confirmations (32) |
| Sepolia (11155111) | ❓ unverified | ⚠️ config shipped; JPYC unverified |

¹ JPYC officially launched on Kaia in 2026-05 (Kaia DLT Foundation; Unifi began
JPYC support 2026-05-22), at the same contract address as the other chains. Kaia
runs IBFT consensus with immediate finality, so its `defaultConfirmations` is `1`
(not Polygon's `4`). See the
[finality-tuning recipe](./docs/recipes/facilitator-finality-tuning.md).

## Why Japan-first

The Japanese stablecoin ecosystem in 2026 is uniquely positioned:

- **JPYC** is a fully regulated yen-pegged stablecoin under the revised Payment Services Act
- Multi-chain by design (same address on Ethereum, Polygon, Avalanche, and Kaia)
- Now live on Kaia (2026-05), with LINE NEXT's Unifi supporting JPYC since 2026-05-22
- Japanese AI startup ecosystem actively seeking modern payment rails

kawasekit aims to be the developer-facing layer that connects this stablecoin infrastructure to the global AI agent ecosystem.

## Documentation

The full documentation site is built from [docs/](./docs/) using Astro Starlight. Bilingual (English / 日本語), with a [Quick Start](./docs/src/content/docs/quickstart.mdx), [example walkthroughs](./docs/src/content/docs/examples/), and an auto-generated [API reference](./docs/src/content/docs/) driven by TypeDoc.

Run locally:

```bash
cd docs
pnpm install
pnpm dev
```

The site is live at **[kawasekit.k0yote.dev](https://kawasekit.k0yote.dev)**, auto-deployed from `main` via `.github/workflows/docs.yml`.

## Contributing

This is currently a solo project, but with M1–M4 shipped and `0.1.0-beta` on npm, contributions are now welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for guidelines.

For now, feedback, issues, and discussions are the most valuable contributions.

## Security

Report security issues privately to **security@k0yote.dev**. See [SECURITY.md](./SECURITY.md) for the disclosure policy, and [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the layer-by-layer threat model used by external reviewers.

This SDK handles signing credentials and constructs financial operations. While the architecture avoids holding user funds, integration mistakes can still result in financial loss. Audit and test thoroughly before any mainnet usage.

## License

Apache-2.0 © k0yote

This license includes an explicit patent grant, which is important for working in the account abstraction and stablecoin space.

---

Follow development progress: [@k0yote](https://github.com/k0yote) · Project home: [kawasekit.k0yote.dev](https://kawasekit.k0yote.dev)
