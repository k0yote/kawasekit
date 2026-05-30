# Recipe: Facilitator Confirmation Depth — Finality Tuning

**Threat reference**: [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md) §6.6 ("Reorg
safety / confirmation depth", closed) and [threat 2.8](../THREAT_MODEL.md)
("settle tx reorg — content delivered, payment reverted").

**API**: `CreateSelfFacilitatorParams.confirmations` and
`CreateSelfFacilitatorParams.receiptTimeoutMs` (`src/x402/facilitator.ts`).

**Status**: Operator tuning guide for kawasekit ≥ `v0.1.0-beta`. Expands the
inline §6.6 tuning table into a chain-by-chain, value-tiered recipe.

> **Scope of "supported".** As of M5-3, kawasekit ships chain configs for
> **Polygon, Kaia, Avalanche, and Ethereum** (+ their testnets) in `src/chains/`,
> each carrying a per-chain `defaultConfirmations` and `blockTimeMs`
> (config-as-data). JPYC is live on the four mainnets (+ Amoy + Kairos) at the
> same address; on Avalanche Fuji / Sepolia JPYC is unverified, so
> `getJpycAddress` throws there. The **x402 EOA-payer path** works on every live
> chain; the **smart-account path** is Polygon-verified (Kaia's runs via Pimlico
> in a later phase).

---

## Why this matters

`createSelfFacilitator(...).settle()` broadcasts the JPYC
`transferWithAuthorization` and then waits for the receipt via viem's
`waitForTransactionReceipt({ confirmations, timeout })`
(`src/x402/facilitator.ts`). It returns success **only after `confirmations`
blocks have stacked on top of the settle tx**.

This is the defence for [threat 2.8](../THREAT_MODEL.md): on a chain with
non-trivial reorgs (Polygon PoS), a settle tx can be mined — your paywall
delivers the content — and then be reorged out, reverting the payment. The depth
you wait is a direct trade between **latency** (how long the caller waits for
`200`) and **finality risk** (the value you might deliver-but-not-collect inside
a reorg window).

There are **two knobs**, and they must be tuned **together**:

| Knob | What it does | Default (`src/x402/facilitator.ts`) |
|---|---|---|
| `confirmations` | blocks to wait past inclusion before returning success | `4` on mainnet, `1` on testnet (`:301-302`) |
| `receiptTimeoutMs` | how long `settle()` waits before giving up | **auto-sized** from `confirmations` × block time (floor 60 s), via `deriveReceiptTimeoutMs` (`:296` area) |

**The trap — now handled for you.** Raising `confirmations` without a matching
`receiptTimeoutMs` would make `settle()` time out before the depth is reached. The
SDK closes this: when you do not pass `receiptTimeoutMs`, it is derived from the
depth (`deriveReceiptTimeoutMs(chain, confirmations)`), so a deep-confirmation
chain like Ethereum (`32` × ~12 s) gets ~10 min, not the 60 s floor. Override only
to extend further. See the worked example.

---

## Chain-by-chain finality

Confirmation depth is a property of the **chain's consensus**, not of kawasekit.
Polygon PoS is probabilistic (needs depth); Avalanche and Kaia have fast
deterministic finality (a single block is effectively final); Ethereum finalises
in epochs.

| Chain | Block time | Finality model | Suggested base `confirmations` | Notes |
|---|---|---|---|---|
| **Polygon PoS** (mainnet) | ~2 s | Probabilistic; checkpoints to L1 ~every 30 min | **4** (default) → 16–256 by value | kawasekit's primary chain; the default `4` ≈ ~8 s soft finality. Depth is the main lever here. |
| **Polygon Amoy** (testnet) | ~2 s | Probabilistic | **1** (default) | Fast dev loops; do not infer mainnet safety from Amoy. |
| **Avalanche C-Chain** | ~2 s | Snowman BFT — sub-`2 s` deterministic finality | **2** (shipped default) | A confirmed block is final; deep confirmations add latency for ~no extra safety. |
| **Ethereum** (mainnet) | ~12 s | Casper FFG — finality at 2 epochs (~12.8 min) | **32** (shipped default) → 64 (fully finalised) | ~32 ≈ 6.4 min finalised-grade; the SDK auto-sizes `receiptTimeoutMs` (~10 min) so the default does not time out. |
| **Kaia** | ~1 s | IBFT — **immediate finality** | **1** (shipped default) | A single block is final, so `confirmations: 1` is correct (do **not** copy Polygon's `4`). |

> **Do not copy Polygon's `4` to Avalanche/Kaia.** On deterministic-finality
> chains, `confirmations: 1` is both correct and faster. On Ethereum, `4` is far
> *too low* for any non-trivial value. Confirmation depth is per-chain.

---

## Tuning by per-call value (Polygon)

The §6.6 seed table, expanded. Times assume Polygon's ~2 s block.

| Per-call value | Suggested `confirmations` | ≈ wall time | When |
|---|---|---|---|
| **< 1 JPYC** | `4` (default) | ~8 s | kawasekit default; small AI-agent paywall hits. The expected loss inside a reorg is sub-1-JPYC × in-flight settles. |
| **1 – 100 JPYC** | `16` – `32` | ~32 – 64 s | Mid-value merchant flows. Bump `receiptTimeoutMs` (see below). |
| **100 – 1 000 JPYC** | `64` – `128` | ~2 – 4 min | Higher-value flows; raise `receiptTimeoutMs` to ~300 000. |
| **> 1 000 JPYC** | `256` – `512` | ~8.5 – 17 min | Insurance-grade. Align to Polygon's checkpoint cycle; `receiptTimeoutMs` ≥ 900 000. Consider not delivering content until settlement is final at all (no "optimistic delivery"). |

The right tier is set by **how much value you would lose if a single settle
reorged out after you delivered**, not by average volume. A merchant doing
high-frequency *small* calls stays at the default; a merchant doing occasional
*large* calls dials up.

---

## Worked example: deep confirmations (the SDK sizes the timeout)

You sell a 250 JPYC report on Polygon mainnet and want `confirmations: 64`
(~2 min). You no longer have to hand-size the timeout — the SDK derives it from
the depth (`deriveReceiptTimeoutMs`) so `settle()` does not die at the 60 s floor:

```
receiptTimeoutMs = max(60_000, inclusionMs + confirmations × blockTimeMs × slack)
                 = max(60_000, 15_000 + 64 × 2_000 × 1.5)
                 = max(60_000, 207_000)  =  207_000 ms  (~3.5 min)
```

- `inclusionMs` (15 s) — time to first inclusion (a few blocks of mempool + build).
- `slack` (1.5×) — absorbs slow blocks / RPC lag so a healthy settle is not killed
  by a tight timeout.

```ts
import { createSelfFacilitator, deriveReceiptTimeoutMs, polygon } from "kawasekit";

const facilitator = createSelfFacilitator({
  network: "mainnet",
  walletClient, // account MUST carry viem `nonceManager` (threat 2.2)
  publicClient,
  confirmations: 64, // receiptTimeoutMs auto-sizes to ~207_000 ms
});

// Override receiptTimeoutMs only to add slack beyond the derived default:
deriveReceiptTimeoutMs(polygon, 64); // 207_000 — compute it yourself if needed
```

**Operator action on timeout overrun.** If `settle()` still times out (network
congestion, an RPC stall), it returns `failSettle(..., { transaction: txHash })`
with `success: false` — **the tx hash is preserved**. The settle reported
failure, but the broadcast tx may still confirm later. Do **not** treat a
timeout as "definitely not paid": reconcile the returned `txHash` on-chain (or
via the `onSettle` hook's `transaction` field) before refunding or retrying, or
you risk double-charging when the original tx lands. Pair a long
`receiptTimeoutMs` with a reconciliation job, not with a blind retry.

---

## Merchant SLO linkage (refund window ↔ confirmation depth)

Confirmation depth is also a **business** decision. Two postures:

- **Finality-before-delivery** (default-safe): deliver paid content only after
  `settle()` returns. Latency = the confirmation wall time above. The refund
  window can be short because a delivered payment is already deep. Choose the
  depth from the value table.
- **Optimistic delivery** (latency-first): deliver before deep finality (e.g. at
  `confirmations: 1`) and accept a small reorg-loss budget. Only sane for
  **small per-call values** where `value × expected-reorg-rate` is below your
  tolerance — i.e. kawasekit's default paywall case. Pair it with a refund /
  reconciliation policy that covers the reorg window.

A useful invariant: **your refund window should be ≥ the reorg depth you did
*not* wait for.** If you deliver at depth 1 on Polygon, keep the ability to claw
back / reconcile for at least the ~checkpoint horizon; if you wait to depth 256,
the post-delivery reorg risk is negligible and the refund window is a pure
business choice.

---

## Empirical tuning with the `onSettle` hook

Do not guess the wall time — measure it. The `onSettle` observability hook
(`ObservabilityHooks.onSettle`, `src/observability/hooks.ts`) fires after every
settle with a `durationMs` (wall time **including** the confirmation wait), the
`network`, the settlement `result`, and the `transaction` hash:

```ts
const facilitator = createSelfFacilitator({
  network: "mainnet",
  walletClient,
  publicClient,
  confirmations: 32,
  receiptTimeoutMs: 120_000,
  hooks: {
    onSettle: (e) => {
      // e.durationMs is the real settle latency at your depth + RPC.
      metrics.observe("x402_settle_duration_ms", e.durationMs, {
        network: e.network,
        result: e.result, // "success" | "failure"
      });
    },
  },
});
```

Wire `durationMs` into Prometheus/Grafana (see `examples/observability/`) and
read the **p95/p99**, not the mean — the tail is what your `receiptTimeoutMs`
must clear. Tune the loop:

1. Set `confirmations` from the value table; set `receiptTimeoutMs` from the
   formula.
2. Watch p99 `durationMs` and the `failure` rate for `invalid_transaction_state`
   / timeout reasons over a real soak.
3. If timeouts appear, the tail exceeded `receiptTimeoutMs` → raise it (not the
   depth). If finality feels excessive for the value, lower `confirmations`.

This turns "how deep should I wait?" from a guess into a measured SLO.

---

## Defaults reference

| Param | Default | Source |
|---|---|---|
| `confirmations` | per-chain `KawaseChain.defaultConfirmations` — Polygon `4` / Kaia `1` / Avalanche `2` / Ethereum `32` (testnets lower) | `src/chains/`, read in `createSelfFacilitator` |
| `receiptTimeoutMs` | `deriveReceiptTimeoutMs(chain, confirmations)` = `max(60_000, 15_000 + confirmations × blockTimeMs × 1.5)` | `src/x402/facilitator.ts` |

Confirmation depth is now **config-as-data per chain** (M5-3) — the facilitator
reads `chain.defaultConfirmations` rather than a binary mainnet/testnet switch,
and auto-sizes `receiptTimeoutMs` to match. Override either explicitly for a
specific value tier, using the tables above.

---

## See also

- [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md) §6.6 (reorg safety) and threat 2.8.
- [`examples/observability/`](../../examples/) — the Prometheus/Grafana wiring
  for `onSettle` `durationMs`.
- [Recipe: Session-Key Revoke Race](./revoke-race-mitigation.md) — the other
  operator playbook; the same `confirmations` reasoning applies to the revoke
  UserOp's reorg window (threat 2.9).
