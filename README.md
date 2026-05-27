# kawasekit

> TypeScript SDK for stablecoin payments by AI agents. Japan-first, JPYC-native.

[![npm version](https://img.shields.io/npm/v/kawasekit.svg)](https://www.npmjs.com/package/kawasekit)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

🚧 **Status**: Pre-alpha (M3 milestone — externally-callable kawasekit). Built in public. Not yet ready for production use.

## Vision

kawasekit gives AI agents a way to pay for things using stablecoins — without exposing developers to chain selection, gas management, or signing complexity.

Today, AI services force users into monthly subscriptions and API key sprawl. As agentic workflows become common, the per-call cost model breaks down. kawasekit treats payments as a primitive: an agent submits an operation, the SDK handles the rest.

Built around modern account abstraction (ERC-4337 / Kernel v3.1) and Japan's first regulated yen stablecoin (JPYC, classified as 電子決済手段 under 改正資金決済法), with global expansion targeting Kaia and the broader Asia stablecoin ecosystem.

## Roadmap

- [x] **M1**: Smart account skeleton on Polygon Amoy
- [x] **M2**: JPYC transfer via UserOp + EIP-3009 signing helpers + Daily Limit spending policy
- [x] **M3**: x402 v2 server/client/facilitator + session-key lifecycle + Mastra/Hono integration example (this release)
- [ ] **M4**: Mainnet support + observability + npm v0.1 release + CLI + docs site
- [ ] **M5**: Community building + first real integrations
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
    facilitator: createSelfFacilitator({ walletClient, publicClient }),
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
import { createX402PaymentSigner, wrapFetch } from "kawasekit";
import { privateKeyToAccount } from "viem/accounts";

const signer = createX402PaymentSigner({ account: privateKeyToAccount("0x...") });
const fetch402 = wrapFetch({ signer });

const res = await fetch402("https://api.example.com/weather/Tokyo");
// → 402 → signed retry → 200 with JPYC settled on-chain
```

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

| Chain | Status | JPYC |
|---|---|---|
| Polygon | M2 | ✅ Live (`0xE7C3...c29`) |
| Polygon Amoy (testnet) | M2 (primary dev target) | ✅ Live (`0xE7C3...c29`, mint-controlled) |
| Kaia | M3+ | 🚧 In development |
| Avalanche | M4+ | ✅ Live (`0xE7C3...c29`) |
| Ethereum | M4+ | ✅ Live (`0xE7C3...c29`) |

## Why Japan-first

The Japanese stablecoin ecosystem in 2026 is uniquely positioned:

- **JPYC** is a fully regulated yen-pegged stablecoin under the revised Payment Services Act
- Multi-chain by design (same address on Ethereum, Polygon, Avalanche)
- Kaia integration coming via LINE NEXT's Unifi
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

The site will deploy to GitHub Pages on every push to `main` once Pages is enabled in the repository settings — see `.github/workflows/docs.yml`. The planned canonical URL is `kawasekit.k0yote.dev`.

## Contributing

This is currently a solo project, but contributions will be welcomed once we hit M3. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for guidelines.

For now, feedback, issues, and discussions are the most valuable contributions.

## Security

Report security issues privately to **security@k0yote.dev**. See [SECURITY.md](./SECURITY.md) for the disclosure policy, and [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the layer-by-layer threat model used by external reviewers.

This SDK handles signing credentials and constructs financial operations. While the architecture avoids holding user funds, integration mistakes can still result in financial loss. Audit and test thoroughly before any mainnet usage.

## License

Apache-2.0 © k0yote

This license includes an explicit patent grant, which is important for working in the account abstraction and stablecoin space.

---

Follow development progress: [@k0yote](https://github.com/k0yote) · Project home: kawasekit.k0yote.dev (coming soon)
