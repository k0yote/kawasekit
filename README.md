# kawasekit

> TypeScript SDK for stablecoin payments by AI agents. Japan-first, JPYC-native.

[![npm version](https://img.shields.io/npm/v/kawasekit.svg)](https://www.npmjs.com/package/kawasekit)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

🚧 **Status**: M4 complete — `kawasekit@0.1.0-beta.2` is published on npm (SLSA provenance, `beta` dist-tag) and mainnet-capable, with payment flows verified on Polygon mainnet. **Not yet GA.** Production use is currently constrained to **small per-call values**: the reasoning-step idempotency gap (see [`docs/THREAT_MODEL.md` §6.1](./docs/THREAT_MODEL.md#61-reasoning-step-idempotency-gap)) is not yet closed, so duplicate-payment scenarios are the integrator's responsibility. GA (`0.1.0` on the `latest` tag) lands in M5 after the idempotency layer + an external human security review. Built in public.

```bash
pnpm add kawasekit@beta   # 0.1.0-beta.2 — pre-GA, mainnet-capable
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
- [ ] **M5**: Reasoning-step idempotency layer (§6.1) + `0.1.0` GA promote + Kaia support — the technical prerequisites for first real integrations
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
    // `network` is required (M4-1): it is cross-checked against
    // walletClient.chain.isTestnet and throws on mismatch.
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

Client (any `fetch` becomes x402-aware):

```typescript
import { createX402PaymentSigner, JPYC_DECIMALS, wrapFetch } from "kawasekit";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const signer = createX402PaymentSigner({
  network: "testnet",
  account: privateKeyToAccount("0x..."),
  // Pin to the JPYC v2 EIP-712 domain at construction. The wire-format
  // extra.name / extra.version are ignored — Threat 1.4 mitigation.
  asset: { kind: "known", id: "jpyc-v2" },
});

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
});

const res = await fetch402("https://api.example.com/weather/Tokyo");
// → 402 → onPayment guard → signed retry → 200 with JPYC settled on-chain
```

> **⚠️ Call-level idempotency only.** kawasekit guarantees that a single
> `fetch402(...)` call settles **at most once** (EIP-3009 nonce + viem
> `nonceManager`). It does **not** prevent your agent from invoking
> `fetch402(...)` twice for the same reasoning step — retries, regeneration,
> pause-resume, and multi-agent fan-out can each cause duplicate charges.
> **Step-level idempotency is your responsibility**: track an
> `Idempotency-Key` per reasoning step at the agent framework layer.
> See [`docs/THREAT_MODEL.md` §6.1](./docs/THREAT_MODEL.md#61-reasoning-step-idempotency-gap) for the threat boundary.

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

JPYC availability and kawasekit support are **two separate axes** — JPYC being
live on a chain does **not** mean kawasekit has a config or has been tested
there. Today kawasekit ships a chain config only for **Polygon + Polygon Amoy**
(`src/chains/`); `getJpycAddress` / `SupportedChainId` accept only those two.

| Chain | JPYC availability | kawasekit support |
|---|---|---|
| Polygon (mainnet) | ✅ Live (`0xE7C3…c29`) | ✅ M4 — config shipped, verified with live mainnet txs |
| Polygon Amoy (testnet) | ✅ Live (`0xE7C3…c29`) | ✅ primary testnet target |
| Kaia | ✅ Live (`0xE7C3…c29`, same address)¹ | 🚧 planned M5 (x402 EOA-payer path first) |
| Avalanche | ✅ Live (`0xE7C3…c29`) | ⬜ not yet — no chain config |
| Ethereum | ✅ Live (`0xE7C3…c29`) | ⬜ not yet — no chain config |

¹ JPYC officially launched on Kaia in 2026-05 (Kaia DLT Foundation; Unifi began
JPYC support 2026-05-22), same contract address as the other chains. kawasekit
has no Kaia chain config yet — support is scheduled for M5.

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
