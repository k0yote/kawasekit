# Design — `createSponsoredKernelClient` (kawasekit SDK helper)

| | |
|---|---|
| **Status** | **Approved (owner) — option B.** Ready for implementation plan. |
| **Author** | k0yote (with Claude) |
| **Date** | 2026-06-16 (approved 2026-06-18) |
| **Realizes** | RFC-0001 finding **M4** / SDK gap **G1** (and the `as unknown` cast **G4**) |
| **Scope** | One new public SDK helper in `kawasekit/src/client/`. No policy/account/paymaster logic changes. |

---

## 1. Problem

The RFC-0001 harness (`kawasekit-example/zerodev-agent-jpyc/harness.ts`) had to drop to the **raw `@zerodev/sdk`** to build a Kernel client with a bundler + ZeroDev paymaster, because kawasekit:

- **G1** — exports the `ConfiguredKernelClient` *type* and `transferJpyc(client, …)` that *consumes* one, but **no helper to BUILD** a sponsored client. Today that construction lives only in `scripts/*` (e.g. `scripts/03-transfer-jpyc.ts:84–96`) and in the harness — copy-pasted, not reusable.
- **G4** — when the account flows in loosely-typed (the harness typed it `any`), `createKernelAccountClient(...)`'s deep generics don't unify with the exported `ConfiguredKernelClient` alias, forcing an `as unknown as ConfiguredKernelClient` cast.

This matters beyond the demo: **every `kawasekit-hub` integrator will hit the same gap.** The point of the RFC-0001 placement (§6.4) was to surface exactly this. M4 closes it in the SDK.

**Reference construction (the de-facto spec), `scripts/03-transfer-jpyc.ts:84–96`:**

```ts
const paymasterClient = createZeroDevPaymasterClient({ chain, transport: http(rpcUrl) });
const kernelClient = createKernelAccountClient({
  account,
  chain,
  client: publicClient,
  bundlerTransport: http(rpcUrl),
  paymaster: {
    getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
  },
});
```

Both kawasekit account builders — `createAgentSmartAccount` and `restoreSessionAccount` — already return the concrete `CreateKernelAccountReturnType<"0.7">`, so a helper typed on that input can return a clean `ConfiguredKernelClient` with **no caller cast** (script 03 already passes such a client to `transferJpyc` cast-free).

---

## 2. Decision summary

| # | Decision | Status |
|---|---|---|
| D1 | **Responsibility scope = thin typed constructor.** Builds the paymaster + kernel client; sponsorship errors **propagate as-is** (no SDK error wrapping, no new error class). | ✅ **DECIDED** (owner, 2026-06-16) |
| D2 | RPC input shape (projectId vs raw URL) | proposed in §3 — confirm |
| D3 | Location + name | proposed in §3 — confirm |
| D4 | **Harness adoption = option B.** Thin helper + one optional `observability` hook (`onSponsor`/`onSponsorError`, via the SDK's `invokeHookSafely`). The harness adopts the helper and drops its bespoke `@zerodev` wiring, keeping the N1–N4 spans through the hook. | ✅ **DECIDED** (owner, 2026-06-18) |

Explicitly **rejected** (owner): an "opinionated" helper that owns a typed `SponsorshipError` + no-silent-fallback wrapping; and a general `createKernelClient` with optional owner-pays paymaster (YAGNI — only sponsored is needed today).

---

## 3. Proposed API (thin typed constructor)

**File:** `kawasekit/src/client/sponsored-kernel-client.ts` (colocated with `transfer-jpyc.ts`). Exported from `src/index.ts`. JSDoc + `@example` (CLAUDE.md requirement).

```ts
/**
 * Optional sponsorship observability (option B). The helper calls these through
 * the SDK's `invokeHookSafely`, so a throwing hook never breaks sponsorship.
 * The existing `ObservabilityHooks` is x402-facilitator-shaped (verify/settle),
 * so this is a small dedicated interface for the paymaster seam.
 */
export interface SponsoredKernelClientObservability {
  /** Fired AFTER the paymaster GRANTS sponsorship for a userOp. */
  readonly onSponsor?: (event: { readonly account: Address }) => void;
  /** Fired when the paymaster DECLINES sponsorship (the error then propagates). */
  readonly onSponsorError?: (event: { readonly account: Address; readonly error: unknown }) => void;
}

export interface CreateSponsoredKernelClientParams {
  /** A Kernel v0.7 account from `createAgentSmartAccount` or `restoreSessionAccount`. */
  readonly account: CreateKernelAccountReturnType<"0.7">;
  /** The viem chain the client operates on (e.g. `polygonAmoy`). */
  readonly chain: Chain;
  /**
   * The ZeroDev RPC URL — used for BOTH the bundler and the paymaster
   * (ZeroDev serves both from one project RPC). Build it from a project id with
   * `zerodevRpcUrl(chain, projectId)`, or paste the dashboard URL.
   */
  readonly zerodevRpc: string;
  /** Optional viem `PublicClient` for on-chain reads during userOp prep (recommended; matches scripts). */
  readonly publicClient?: PublicClient<Transport, Chain>;
  /** Optional sponsorship observability — granted / declined (option B). */
  readonly observability?: SponsoredKernelClientObservability;
}

/**
 * Build a sponsored Kernel account client: a `ConfiguredKernelClient` whose gas
 * is paid by the ZeroDev paymaster. Pass the returned client straight to
 * `transferJpyc(client, …)`.
 */
export function createSponsoredKernelClient(
  params: CreateSponsoredKernelClientParams,
): ConfiguredKernelClient;
```

**Behavior:** internally calls `createZeroDevPaymasterClient` + `createKernelAccountClient` with a `getPaymasterData` that calls `paymasterClient.sponsorUserOperation({ userOperation })`, fires `observability.onSponsor` on success / `observability.onSponsorError` on failure (both via `invokeHookSafely`), and **re-throws the original paymaster error unchanged** (per D1 — the SDK does not wrap it). Returns a properly-typed `ConfiguredKernelClient`. If `createKernelAccountClient`'s generics don't unify with the alias, exactly **one documented cast** lives *inside* the helper (per CLAUDE.md "no `as` without a comment") so **callers never cast** — closing G4 for them.

**D2 (RPC input) — recommendation:** accept a single `zerodevRpc: string` (one URL, bundler+paymaster). A caller with only a project id calls the already-exported `zerodevRpcUrl(chain, projectId)`. Keeps the helper minimal; no discriminated union.

**Error semantics (per D1):** a paymaster decline surfaces as the raw `@zerodev`/viem error thrown through the userOp-send path. The SDK does **not** wrap it. Callers that want a typed "sponsorship rejected, no fallback" signal classify it themselves (this is what the harness does today, and is the crux of §4).

**Usage:**

```ts
import {
  createSponsoredKernelClient, restoreSessionAccount, transferJpyc, zerodevRpcUrl, polygonAmoy,
} from "kawasekit";

const account = await restoreSessionAccount({ publicClient, envelope, sessionKeySigner });
const client = createSponsoredKernelClient({
  account, chain: polygonAmoy, zerodevRpc: zerodevRpcUrl(polygonAmoy, projectId), publicClient,
});
const { transactionHash } = await transferJpyc(client, { to, amount }); // no cast anywhere
```

---

## 4. Resolved decision — harness adoption → **option B**

> **Decided (owner, 2026-06-18): option B.** The helper takes an optional `observability` hook; the harness adopts the helper and drops its bespoke `@zerodev` wiring, re-emitting its N1–N4 `sponsor`/`sponsor_reject` spans by mapping them onto `onSponsor`/`onSponsorError`. The trade-off analysis that led here is kept below for the record.

**The tension.** The thin helper **owns `getPaymasterData` internally**. But the harness's Sprint-1 **H1 discriminator** (the §8 de-risk: prove N1–N4 are rejected by the *permission validator*, not the *paymaster*) is instrumented **at that exact seam**:

- inside `getPaymasterData`, the harness emits a `sponsor` span on success and a `sponsor_reject` span + throws `SponsorshipError` on a paymaster decline;
- the test then asserts a negative case threw something that is **not** a `SponsorshipError`, with **no** `sponsor_reject` span and **no** `settle` span → i.e. sponsorship was fine and the *policy* rejected.

If the harness swaps its builder for the **pure-thin** helper, that seam moves inside the SDK and is no longer observable — so the N1–N4 discriminator we just built in Sprint 1 **breaks**. Hence a decision is required:

| Option | What it means | Trade-off |
|---|---|---|
| **A. SDK helper for consumers; harness keeps its instrumented builder** | Ship `createSponsoredKernelClient` for the Hub/general use (closes G1+G4 there). The harness **keeps** its bespoke `buildSponsoredKernelClient` because it needs the `getPaymasterData` seam for N1–N4. README G1 note updates: "the SDK now ships the helper; this harness keeps a bespoke instrumented variant *solely* to discriminate N1–N4 at the paymaster seam." | ➕ zero extra SDK surface (truly thin); honest; the Hub gets the helper. ➖ the harness still has bespoke `@zerodev` wiring, so for *this example* the gap isn't visibly closed (it is closed for the real target — the Hub). Two builders exist, in two repos, each justified. |
| **B. Thin helper + one optional observability hook** | The helper takes an optional `observability?: { onSponsor?; onSponsorError? }` (reusing kawasekit's existing `ObservabilityHooks`/`invokeHookSafely` surface) so the harness **adopts the helper** and still emits its discriminator spans. | ➕ the harness fully drops bespoke `@zerodev` wiring → M4 visibly closes the gap everywhere; the Hub will *want* paymaster-decline observability for monitoring anyway. ➖ one extra optional param. It is **not** a new error class and reuses an existing surface, so it's arguably still "thin" — but it is more than D1's pure minimum. |
| **C. Re-architect H1 to classify at the `transferJpyc` seam** | Move the discriminator off `getPaymasterData` so the harness can use the pure-thin helper, classifying sponsorship-vs-validation from the single thrown error post-hoc. | ➖ brittle post-hoc error classification — exactly the unsoundness Sprint 1 removed. **Not recommended.** |

**Recommendation: B**, narrowly. kawasekit *already* exposes an observability hook surface, so an optional `observability?` param is in-keeping (not foreign), it lets the harness fully realize M4's value, and **sponsorship-decline monitoring is a real production need the Hub will want** regardless of the harness. If you would rather keep the SDK surface at its absolute minimum, **A** is the clean, honest fallback — M4 still delivers its stated purpose (closing the gap for the Hub), and the harness simply documents why it retains an instrumented builder.

> This is the single thing to decide before implementation. Everything else in §3 is mechanical.

---

## 5. Testing

- **Unit (always-run, no chain):** `createSponsoredKernelClient(...)` returns a client whose `.account.address === account.address` and `.chain.id === chain.id`; the `paymaster.getPaymasterData` config is wired (a stub `sponsorUserOperation` is invoked). No network. (Option B adds: the observability hooks fire on success/error via injected stubs.)
- **Type-level:** the return is assignable to `ConfiguredKernelClient` and accepted by `transferJpyc` **without a cast** at the call site (the G4 closure — assert by compiling a fixture).
- **Integration (gated, reuses the harness env):** an existing sponsored transfer continues to land on Amoy when built via the helper (covered by the harness happy path under Option B; under Option A, covered by a script smoke).

---

## 6. Rollout

1. Implement `src/client/sponsored-kernel-client.ts` + export + tests.
2. **Changeset (minor)** — new public API → version bump; JSDoc `@example` present; no `.md` links in JSDoc (the docs-build gate).
3. 4-point gate green: `pnpm typecheck && pnpm lint && pnpm vitest && pnpm build`.
4. **Harness adoption (option B):** refactor `kawasekit-example` `buildSponsoredKernelClient` onto `createSponsoredKernelClient`, mapping the harness's `sponsor`/`sponsor_reject` spans onto `observability.onSponsor`/`onSponsorError` so the N1–N4 discriminator is preserved with **no** bespoke `@zerodev` wiring left; the Sprint-1 unit/integration suite must stay green. Update README G1 + G4 to "closed (uses `createSponsoredKernelClient`)". Re-point the example to the published `kawasekit` version that ships the helper.
5. Maintainer commits/pushes (HTTPS); Claude leaves verified diffs.

---

## 7. Out of scope (YAGNI)

- A typed SDK `SponsorshipError` / no-silent-fallback wrapping (owner-rejected; stays an example concern).
- A general `createKernelClient` with optional owner-pays paymaster.
- Separate bundler vs paymaster transports / non-ZeroDev paymasters.
- Any change to `transferJpyc`, the policy builders, or the session lifecycle.
