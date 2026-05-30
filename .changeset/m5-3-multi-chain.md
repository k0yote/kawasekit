---
"kawasekit": minor
---

# M5-3 — Kaia / Avalanche / Ethereum chain support + per-chain finality

kawasekit now ships chain configs for **all four JPYC mainnets** (Polygon, Kaia,
Avalanche, Ethereum) plus their testnets, and makes confirmation depth a
**per-chain property** instead of a Polygon-centric default.

## New chains (`src/chains/`)

`kaia` (8217), `kairos` (1001), `avalanche` (43114), `avalancheFuji` (43113),
`ethereum` (1), `sepolia` (11155111) join `polygon` / `polygonAmoy`.
`SupportedChainId` and `getChain` / `isSupportedChainId` extend automatically.

JPYC uses the same address (`0xE7C3…c29`) on every supported chain, all
`isLive: true` — Kaia / Kairos / Avalanche / Fuji / Sepolia were confirmed by a
read-only on-chain check (`name()` == "JPY Coin", `symbol()` == "JPYC"); Polygon
/ Amoy / Ethereum are established. (Real x402 settlement on the new chains is not
yet exercised — config + liveness only.)

## Per-chain finality (config-as-data)

`KawaseChain` gains `defaultConfirmations` and `blockTimeMs`. `createSelfFacilitator`
now reads `chain.defaultConfirmations` rather than the binary `mainnet=4 /
testnet=1` switch:

- Polygon `4` (probabilistic) · Kaia `1` (IBFT immediate finality) · Avalanche
  `2` (Snowman) · Ethereum `32` (epoch finality).
- The old binary default would have **under-confirmed Ethereum** (4 blocks ≈
  48 s, not finalised) — re-opening the settle-reorg gap (threat 2.8) there.

`receiptTimeoutMs` now **auto-sizes** to the depth via the new exported
`deriveReceiptTimeoutMs(chain, confirmations)` = `max(60_000, 15_000 +
confirmations × blockTimeMs × 1.5)`. This preserves Polygon's 60 s default
exactly and gives Ethereum's 32-confirmation default ~10 min, so it does not time
out at the flat floor.

## Scope

- The **x402 EOA-payer path** works on every chain where JPYC is live.
- The **smart-account path** (session keys, sponsored UserOps via ZeroDev) stays
  verified on Polygon; Kaia's runs via Pimlico in a later phase (ZeroDev does not
  support Kaia).

## Docs / threats

Threat 1.1 (cross-chain replay) now formally spans Polygon / Kaia / Avalanche /
Ethereum; §6.6 and `docs/recipes/facilitator-finality-tuning.md` updated for the
per-chain model; README Supported Chains table refreshed. 10 new tests
(311 total).
