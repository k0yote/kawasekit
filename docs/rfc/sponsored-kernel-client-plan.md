# `createSponsoredKernelClient` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Repo workflow note:** per this project, the **maintainer runs all `git commit` / `git push`** (via HTTPS). Each "Commit" step below means: stage the listed files, verify the gate, and hand the maintainer the conventional-commit message shown. Do **not** run `git commit`/`push` yourself.

**Goal:** Add a kawasekit SDK helper `createSponsoredKernelClient` that builds a gas-sponsored Kernel client (closing gap G1 + the `as unknown` cast G4), then adopt it in the RFC-0001 harness via an optional `observability` hook (option B).

**Architecture:** A thin typed constructor in `src/client/` wires `createZeroDevPaymasterClient` + `createKernelAccountClient` with a `getPaymasterData` that sponsors the userOp, fires optional granted/declined observability hooks (via the SDK's `invokeHookSafely`), and re-throws the raw paymaster error unchanged. The harness drops its bespoke `@zerodev` wiring and maps its N1–N4 `sponsor`/`sponsor_reject` spans onto those hooks; it re-wraps a declined sponsorship into its own `SponsorshipError` so the Sprint-1 discriminator is preserved.

**Tech Stack:** TypeScript (ESM, strict), `@zerodev/sdk` 5.5.10, `@zerodev/permissions` 5.5.14, viem 2.50.4, Vitest, Biome, Changesets.

---

## File Structure

**Phase 1 — `kawasekit` (the SDK, self-contained + releasable):**
- Create: `src/client/sponsored-kernel-client.ts` — the helper + the `@internal` `sponsorWithObservability` seam + the two public param/observability interfaces.
- Create: `test/sponsored-kernel-client.test.ts` — unit tests for the observability seam (no chain).
- Modify: `src/index.ts:32-38` — export the new public symbols next to the `transfer-jpyc` block.
- Create: `.changeset/sponsored-kernel-client.md` — minor bump (new public API → 0.8.0).

**Phase 2 — `kawasekit-example` (adoption; runs AFTER kawasekit publishes the helper):**
- Modify: `package.json` — bump `kawasekit` to the published version that ships the helper.
- Modify: `zerodev-agent-jpyc/harness.ts` — replace the bespoke `buildSponsoredKernelClient` body with `createSponsoredKernelClient`; thread a sponsorship-decline flag through `agentPay`.
- Modify: `zerodev-agent-jpyc/README.md` — mark G1 + G4 "closed".

---

## PHASE 1 — kawasekit SDK helper

### Task 1: The observability seam (`sponsorWithObservability`)

**Files:**
- Create: `src/client/sponsored-kernel-client.ts`
- Test: `test/sponsored-kernel-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sponsored-kernel-client.test.ts`:

```ts
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { sponsorWithObservability } from "../src/client/sponsored-kernel-client";

const ACCOUNT = getAddress(`0x${"11".repeat(20)}`);

describe("sponsorWithObservability", () => {
	it("fires onSponsor after a successful sponsorship and returns the data", async () => {
		const seen: string[] = [];
		const out = await sponsorWithObservability(() => Promise.resolve({ paymaster: "0xpm" }), ACCOUNT, {
			onSponsor: ({ account }) => seen.push(`sponsor:${account}`),
			onSponsorError: () => seen.push("error"),
		});
		expect(out).toEqual({ paymaster: "0xpm" });
		expect(seen).toEqual([`sponsor:${ACCOUNT}`]);
	});

	it("fires onSponsorError and RE-THROWS the original error on a decline", async () => {
		const seen: string[] = [];
		const cause = new Error("paymaster declined");
		await expect(
			sponsorWithObservability(() => Promise.reject(cause), ACCOUNT, {
				onSponsorError: ({ account, error }) => seen.push(`error:${account}:${(error as Error).message}`),
			}),
		).rejects.toBe(cause);
		expect(seen).toEqual([`error:${ACCOUNT}:paymaster declined`]);
	});

	it("is safe with no observability (resolves, no throw from missing hooks)", async () => {
		await expect(sponsorWithObservability(() => Promise.resolve(1), ACCOUNT, undefined)).resolves.toBe(1);
	});

	it("a throwing hook never breaks the flow (invokeHookSafely)", async () => {
		await expect(
			sponsorWithObservability(() => Promise.resolve(1), ACCOUNT, {
				onSponsor: () => {
					throw new Error("hook boom");
				},
			}),
		).resolves.toBe(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/sponsored-kernel-client.test.ts`
Expected: FAIL — `sponsorWithObservability` is not exported / module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `src/client/sponsored-kernel-client.ts`:

```ts
/**
 * Build a gas-sponsored Kernel account client — a {@link ConfiguredKernelClient}
 * whose UserOp gas is paid by the ZeroDev paymaster. Pass the returned client
 * straight to {@link transferJpyc}; callers never construct a paymaster or cast.
 *
 * @packageDocumentation
 */

import {
	type CreateKernelAccountReturnType,
	createKernelAccountClient,
	createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { type Address, type Chain, http, type PublicClient, type Transport } from "viem";
import { invokeHookSafely } from "../observability/hooks";
import type { ConfiguredKernelClient } from "./transfer-jpyc";

/**
 * Optional sponsorship observability. Hooks fire through {@link invokeHookSafely},
 * so a throwing hook never breaks sponsorship. The existing `ObservabilityHooks`
 * is x402-facilitator-shaped (verify/settle); this is the paymaster-seam surface.
 */
export interface SponsoredKernelClientObservability {
	/** Fired AFTER the paymaster GRANTS sponsorship for a userOp. */
	readonly onSponsor?: (event: { readonly account: Address }) => void;
	/** Fired when the paymaster DECLINES sponsorship (the raw error then propagates). */
	readonly onSponsorError?: (event: { readonly account: Address; readonly error: unknown }) => void;
}

/**
 * @internal Sponsor a userOp and fire the granted/declined observability hook.
 * The original paymaster error is re-thrown unchanged (no SDK wrapping). Exported
 * for unit testing the seam without a live chain.
 */
export async function sponsorWithObservability<T>(
	sponsor: () => Promise<T>,
	account: Address,
	observability: SponsoredKernelClientObservability | undefined,
): Promise<T> {
	try {
		const data = await sponsor();
		invokeHookSafely(observability?.onSponsor, { account });
		return data;
	} catch (error) {
		invokeHookSafely(observability?.onSponsorError, { account, error });
		throw error;
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/sponsored-kernel-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** (maintainer runs)

Stage `src/client/sponsored-kernel-client.ts`, `test/sponsored-kernel-client.test.ts`. Message:
`feat(client): sponsorWithObservability seam (granted/declined hooks, raw re-throw)`

---

### Task 2: The public helper (`createSponsoredKernelClient`)

**Files:**
- Modify: `src/client/sponsored-kernel-client.ts` (append the params interface + the helper)

- [ ] **Step 1: Add the params interface + helper**

Append to `src/client/sponsored-kernel-client.ts`:

```ts
/** Parameters for {@link createSponsoredKernelClient}. */
export interface CreateSponsoredKernelClientParams {
	/** A Kernel v0.7 account from `createAgentSmartAccount` or `restoreSessionAccount`. */
	readonly account: CreateKernelAccountReturnType<"0.7">;
	/** The viem chain the client operates on (e.g. `polygonAmoy`). */
	readonly chain: Chain;
	/**
	 * The ZeroDev RPC URL — used for BOTH the bundler and the paymaster (ZeroDev
	 * serves both from one project RPC). Build it from a project id with
	 * `zerodevRpcUrl(chain, projectId)`, or paste the dashboard URL.
	 */
	readonly zerodevRpc: string;
	/** Optional viem `PublicClient` for on-chain reads during userOp prep (recommended). */
	readonly publicClient?: PublicClient<Transport, Chain>;
	/** Optional sponsorship observability — granted / declined. */
	readonly observability?: SponsoredKernelClientObservability;
}

/**
 * Build a gas-sponsored Kernel account client. The returned
 * {@link ConfiguredKernelClient} pays UserOp gas via the ZeroDev paymaster and is
 * accepted directly by {@link transferJpyc} — no caller-side cast.
 *
 * @example
 * ```ts
 * import {
 *   createSponsoredKernelClient,
 *   polygonAmoy,
 *   restoreSessionAccount,
 *   transferJpyc,
 *   zerodevRpcUrl,
 * } from "kawasekit";
 *
 * const account = await restoreSessionAccount({ publicClient, envelope, sessionKeySigner });
 * const client = createSponsoredKernelClient({
 *   account,
 *   chain: polygonAmoy,
 *   zerodevRpc: zerodevRpcUrl(polygonAmoy, process.env.ZERODEV_PROJECT_ID as string),
 *   publicClient,
 * });
 * const { transactionHash } = await transferJpyc(client, { to, amount });
 * ```
 */
export function createSponsoredKernelClient(
	params: CreateSponsoredKernelClientParams,
): ConfiguredKernelClient {
	const paymasterClient = createZeroDevPaymasterClient({
		chain: params.chain,
		transport: http(params.zerodevRpc),
	});
	const client = createKernelAccountClient({
		account: params.account,
		chain: params.chain,
		// exactOptionalPropertyTypes: only pass `client` when given (never `undefined`).
		...(params.publicClient !== undefined ? { client: params.publicClient } : {}),
		bundlerTransport: http(params.zerodevRpc),
		paymaster: {
			getPaymasterData: (userOperation) =>
				sponsorWithObservability(
					() => paymasterClient.sponsorUserOperation({ userOperation }),
					params.account.address,
					params.observability,
				),
		},
	});
	// createKernelAccountClient's deep generics don't unify with the exported
	// ConfiguredKernelClient alias; the runtime client is identical. One cast here
	// means callers never cast (closing gap G4).
	return client as unknown as ConfiguredKernelClient;
}
```

- [ ] **Step 2: Typecheck (the helper's declared types must compile)**

Run: `pnpm typecheck`
Expected: PASS (0 errors). If `getPaymasterData`'s `userOperation` param errors on type inference, annotate it explicitly from the paymaster signature: `(userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]["userOperation"]) => …` (the exact pattern the harness used pre-refactor).

- [ ] **Step 3 (F3, included): one wiring test for the `publicClient` conditional**

Add to `test/sponsored-kernel-client.test.ts` a test that mocks the two `@zerodev/sdk` factories and asserts the `client` key is present iff `publicClient` is given (the `exactOptionalPropertyTypes` spread — the one bit of construction logic):

```ts
import { vi } from "vitest";

vi.mock("@zerodev/sdk", () => ({
	createZeroDevPaymasterClient: () => ({ sponsorUserOperation: async () => ({}) }),
	// echo the args so the test can inspect what the helper passed.
	createKernelAccountClient: (args: Record<string, unknown>) => args,
}));

// (import createSponsoredKernelClient AFTER the mock; a minimal fake account suffices.)
const fakeAccount = { address: getAddress(`0x${"22".repeat(20)}`) } as unknown as Parameters<
	typeof createSponsoredKernelClient
>[0]["account"];
const chain = { id: 80002 } as unknown as Parameters<typeof createSponsoredKernelClient>[0]["chain"];

describe("createSponsoredKernelClient wiring", () => {
	it("passes `client` only when publicClient is provided (exactOptionalPropertyTypes)", () => {
		const withPc = createSponsoredKernelClient({
			account: fakeAccount,
			chain,
			zerodevRpc: "https://rpc.example/x",
			publicClient: { id: "pc" } as never,
		}) as unknown as Record<string, unknown>;
		const withoutPc = createSponsoredKernelClient({
			account: fakeAccount,
			chain,
			zerodevRpc: "https://rpc.example/x",
		}) as unknown as Record<string, unknown>;
		expect("client" in withPc).toBe(true);
		expect("client" in withoutPc).toBe(false);
	});
});
```

Run: `pnpm vitest run test/sponsored-kernel-client.test.ts` → PASS. (If the module-mock interferes with the Task-1 seam tests, split it into its own `*.wiring.test.ts` file.)

- [ ] **Step 4: Run the full unit suite (nothing regressed)**

Run: `pnpm vitest run`
Expected: PASS (all existing tests + Task 1's 4 + the F3 wiring test).

- [ ] **Step 5: Commit** (maintainer runs)

Stage `src/client/sponsored-kernel-client.ts`, `test/sponsored-kernel-client.test.ts`. Message:
`feat(client): createSponsoredKernelClient — gas-sponsored Kernel client (closes G1/G4)`

---

### Task 3: Export + changeset

**Files:**
- Modify: `src/index.ts:32-38`
- Create: `.changeset/sponsored-kernel-client.md`

- [ ] **Step 1: Add the public exports**

In `src/index.ts`, immediately after the existing `./client/transfer-jpyc` export block (line 38), add:

```ts
export {
	type CreateSponsoredKernelClientParams,
	createSponsoredKernelClient,
	type SponsoredKernelClientObservability,
} from "./client/sponsored-kernel-client";
```

(Do **not** export `sponsorWithObservability` — it is `@internal`, test-only.)

- [ ] **Step 2: Write the changeset**

Create `.changeset/sponsored-kernel-client.md`:

```md
---
"kawasekit": minor
---

# `createSponsoredKernelClient` — build a gas-sponsored Kernel client

New `createSponsoredKernelClient({ account, chain, zerodevRpc, publicClient?, observability? })`
returns a `ConfiguredKernelClient` whose UserOp gas is paid by the ZeroDev paymaster —
the construction half of the agent-payment path (kawasekit already shipped
`transferJpyc(client, …)`, which *consumes* such a client, but no helper to *build*
one). Pass the result straight to `transferJpyc`; callers never construct a paymaster
client or cast to `ConfiguredKernelClient`.

The optional `observability` hook (`onSponsor` / `onSponsorError`, fired via the SDK's
safe-invoke) reports sponsorship granted / declined at the paymaster seam — useful for
monitoring and for distinguishing a paymaster decline from a policy rejection. A paymaster
decline re-throws the original error unchanged (no SDK wrapping / no owner-pays fallback).
```

- [ ] **Step 3: Verify the 4-point gate**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build`
Expected: all PASS. (`lint` = Biome; format counts — do not skip.)

- [ ] **Step 4: Verify the public symbol is exported from the built package**

Run: `pnpm build && grep -c "createSponsoredKernelClient" dist/index.d.ts`
Expected: ≥ 1.

- [ ] **Step 5 (F2): Verify `exports` blocks deep import of the `@internal` seam**

`@internal` is a doc signal, not access control — the real boundary is `package.json#exports`. Inspect it:

Run: `node -e "const e=require('./package.json').exports; console.log(JSON.stringify(e))"`
Expected: `exports` maps only the entry point (`"."`) — there is **no** `"./dist/*"` / `"./client/*"` subpath that would let a consumer `import "kawasekit/dist/client/sponsored-kernel-client"`. If a wildcard subpath exists, restrict `exports` to the entry point so the seam is effectively private. Also confirm `grep -c "sponsorWithObservability" dist/index.d.ts` is `0` (not re-exported from the entry).

- [ ] **Step 6: Commit** (maintainer runs)

Stage `src/index.ts`, `.changeset/sponsored-kernel-client.md` (and `package.json` only if `exports` was restricted). Message:
`feat(client): export createSponsoredKernelClient + changeset (minor)`

> **Ordering (F5) — link-validate BEFORE publish.** Do **not** release `0.8.0` before a consumer has used the API. Order: (1) implement Phase 1 (above); (2) **link** the local kawasekit build into the example and run Phase 2 (Tasks 4–6) against it — the harness is the boundary test that validates the API actually fits; (3) only then does the maintainer release `0.8.0`; (4) **then** bump the example to the published `^0.8.0` (Task 7). Publishing first risks a churn release (`0.8.1`) if the consumer reveals an awkward fit.

---

## PHASE 2 — kawasekit-example adoption (link-validate first, per F5)

### Task 4: Link the LOCAL kawasekit build into the example (dev-only, not committed)

**Files:**
- (no committed change — a temporary `link:` for validation; reverted before handoff)

- [ ] **Step 1: Build kawasekit so the link exposes the new helper**

Run: `cd ../kawasekit && pnpm build && grep -c "createSponsoredKernelClient" dist/index.d.ts`
Expected: ≥ 1.

- [ ] **Step 2: Temporarily point the example at the local build**

Run (from `kawasekit-example/`): `pnpm add link:../kawasekit`
Then confirm: `grep -c "createSponsoredKernelClient" node_modules/kawasekit/dist/index.d.ts`
Expected: ≥ 1. (This edits `package.json`/lockfile — it is **reverted in Task 7 Step 0**, not committed.)

- [ ] **Step 3: (no commit)** — the link is dev-only.

---

### Task 5: Refactor the harness onto the helper

**Files:**
- Modify: `zerodev-agent-jpyc/harness.ts`

- [ ] **Step 1: Update imports**

In `zerodev-agent-jpyc/harness.ts`:

- Remove the `@zerodev/sdk` value import line `import { createKernelAccountClient, createZeroDevPaymasterClient } from "@zerodev/sdk";` and replace it with a type-only import for the account type:

```ts
import type { CreateKernelAccountReturnType } from "@zerodev/sdk";
```

- Add `createSponsoredKernelClient` to the existing `kawasekit` import (keep the others):

```ts
import {
	type ConfiguredKernelClient,
	createBuyListPolicies,
	createSponsoredKernelClient,
	deriveIdempotencyKey,
	issueSessionKey,
	jpycAbi,
	parseSessionEnvelope,
	restoreSessionAccount,
	serializeSessionEnvelope,
	transferJpyc,
	type TransferJpycResult,
} from "kawasekit";
```

- In the `viem` import, remove `http` (no longer used after the refactor — verify with a search first; `formatUnits` and `parseUnits` stay).

- [ ] **Step 2: Replace the `buildSponsoredKernelClient` body**

Replace the entire `buildSponsoredKernelClient` function (the JSDoc block + body, including both `biome-ignore` lines) with:

```ts
/**
 * Build a sponsored Kernel client via the kawasekit SDK helper
 * `createSponsoredKernelClient` (no bespoke `@zerodev` wiring, no cast — gaps
 * G1/G4 closed). The harness maps the SDK's sponsorship observability onto its
 * own spans (`sponsor` / `sponsor_reject`) and reports the LATEST sponsor outcome
 * via `onSponsorOutcome(declined)` so `agentPay` can surface a typed
 * `SponsorshipError` (no owner-pays fallback). Latest-wins (not sticky) is robust
 * to `getPaymasterData` firing more than once per send with mixed outcomes (F4).
 * This keeps the §8 N1–N4 paymaster-vs-validator discriminator intact.
 */
export function buildSponsoredKernelClient(params: {
	readonly account: CreateKernelAccountReturnType<"0.7">;
	readonly cfg: RfcConfig;
	readonly telemetry?: HarnessTelemetry;
	readonly onSponsorOutcome?: (declined: boolean) => void;
}): ConfiguredKernelClient {
	const { cfg, telemetry } = params;
	return createSponsoredKernelClient({
		account: params.account,
		chain: cfg.chain,
		zerodevRpc: cfg.zerodevRpc,
		observability: {
			onSponsor: ({ account }) => {
				emit(telemetry, { phase: "sponsor", at: Date.now(), account });
				params.onSponsorOutcome?.(false);
			},
			onSponsorError: ({ account }) => {
				emit(telemetry, { phase: "sponsor_reject", at: Date.now(), account });
				params.onSponsorOutcome?.(true);
			},
		},
	});
}
```

- [ ] **Step 3: Thread the decline flag through `agentPay`**

In `agentPay`, replace the client construction + the `try/catch` around `transferJpyc` with:

```ts
	// Latest-wins (F4): reflects the LAST sponsor outcome, robust to getPaymasterData
	// firing more than once per send. A genuine final decline → SponsorshipError below.
	let sponsorDeclined = false;
	const client = buildSponsoredKernelClient({
		account,
		cfg,
		telemetry,
		onSponsorOutcome: (declined) => {
			sponsorDeclined = declined;
		},
	});

	emit(telemetry, {
		phase: "submit",
		at: Date.now(),
		account: account.address,
		to: params.to,
		amount: params.amount.toString(),
	});
	try {
		const result = await transferJpyc(client, { to: params.to, amount: params.amount });
		emit(telemetry, {
			phase: "settle",
			at: Date.now(),
			account: account.address,
			to: params.to,
			amount: params.amount.toString(),
			...(result.transactionHash !== null ? { transaction: result.transactionHash } : {}),
		});
		cache.set(key, result);
		return { key, deduped: false, result };
	} catch (err) {
		// A paymaster decline (onSponsorDecline fired) is NOT a policy rejection. Surface it
		// as the typed SponsorshipError (no owner-pays fallback) the §8 tests discriminate on.
		if (sponsorDeclined) {
			throw new SponsorshipError(
				"paymaster declined to sponsor the userOp — set/raise a ZeroDev gas policy on the Amoy project (no owner-pays fallback).",
				{ cause: err },
			);
		}
		// Otherwise the userOp was rejected at VALIDATION (the permission validator) — the
		// transfer never executed, so the merchant balance is unchanged (the §8 discriminator).
		emit(telemetry, {
			phase: "validation_reject",
			at: Date.now(),
			account: account.address,
			to: params.to,
			detail: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
```

(`SponsorshipError` is already imported in `harness.ts`. The `account` local is the `restoreSessionAccount` return, already typed `CreateKernelAccountReturnType<"0.7">`, so it flows into `buildSponsoredKernelClient` with no cast.)

- [ ] **Step 4: Typecheck the harness (G4 closed for the consumer)**

Run: `pnpm typecheck:rfc0001`
Expected: PASS (0 errors) — proves `createSponsoredKernelClient(...)` returns a `ConfiguredKernelClient` with no caller cast and no `any`/`biome-ignore` left in `buildSponsoredKernelClient`.

- [ ] **Step 5: Run the harness suite (Sprint-1 discriminator preserved) + F4 call-count**

Run: `pnpm test:rfc0001`
Expected: PASS — the always-run unit cases stay green; integration stays skipped without live env. The `expectPolicyValidationReject` assertions (`not instanceof SponsorshipError`, no `sponsor_reject`, no `settle`) are unchanged and still hold: a policy reject leaves `sponsorDeclined=false` (raw re-throw), a paymaster decline throws `SponsorshipError`.

**F4 (call count):** the live integration is the only place `getPaymasterData` actually fires. The F1 premise log already prints `spans=[…]`; the count of `sponsor`/`sponsor_reject` entries there **is** the `getPaymasterData` call count per send. The flag is **latest-wins** (Step 3), so it is correct even if that count > 1 with mixed outcomes. Record the observed count from the live run; no extra instrumentation needed.

- [ ] **Step 6: Commit** (maintainer runs)

Stage `zerodev-agent-jpyc/harness.ts`. Message:
`refactor(zerodev-agent-jpyc): adopt createSponsoredKernelClient (drops bespoke @zerodev wiring; G1/G4 closed)`

---

### Task 6: Mark G1 + G4 closed in the README

**Files:**
- Modify: `zerodev-agent-jpyc/README.md`

- [ ] **Step 1: Update the G1 + G4 findings**

In `zerodev-agent-jpyc/README.md`, under "SDK public-API boundary findings", replace the **G1** bullet and the **G4** bullet with:

```md
- **G1 — CLOSED.** kawasekit now ships `createSponsoredKernelClient({ account, chain,
  zerodevRpc, publicClient?, observability? })`; the harness uses it and no longer touches
  raw `@zerodev/sdk` for client construction. The optional `observability` hook
  (`onSponsor`/`onSponsorError`) carries the §8 sponsor / sponsor_reject discrimination.
- **G4 — CLOSED.** `createSponsoredKernelClient` returns a typed `ConfiguredKernelClient`;
  the harness's `buildSponsoredKernelClient` no longer needs the `as unknown as
  ConfiguredKernelClient` cast or an `any`-typed account.
```

Also update the "used as-is" paragraph: add `createSponsoredKernelClient` to the list of kawasekit symbols the harness consumes.

- [ ] **Step 2: Confirm no stale claims remain**

Run: `grep -n "raw .@zerodev/sdk.\|as unknown as ConfiguredKernelClient\|G1\|G4" zerodev-agent-jpyc/README.md`
Expected: the only G1/G4 mentions are the "CLOSED" bullets; no "drop to the raw @zerodev/sdk" language remains for the client build.

- [ ] **Step 3: Commit** (maintainer runs)

Stage `zerodev-agent-jpyc/README.md`. Message:
`docs(zerodev-agent-jpyc): mark SDK gaps G1/G4 closed (createSponsoredKernelClient)`

---

### Task 7: Post-release — bump the example to the published kawasekit (AFTER 0.8.0 is on npm)

> Runs **only after** Tasks 4–6 validated the API against the local link AND the maintainer released `0.8.0`.

**Files:**
- Modify: `package.json` (kawasekit-example root)

- [ ] **Step 0: Revert the dev-only link (Task 4 Step 2)**

Run (from `kawasekit-example/`): `git checkout package.json pnpm-lock.yaml`
(removes the temporary `link:../kawasekit`; node_modules is not committed).

- [ ] **Step 1: Bump to the published version**

In `package.json`, change `"kawasekit": "^0.7.0"` → `"kawasekit": "^0.8.0"` (the released version that ships the helper).

- [ ] **Step 2: Install + confirm + re-verify the gates against the published package**

Run: `pnpm install && grep -c "createSponsoredKernelClient" node_modules/kawasekit/dist/index.d.ts && pnpm typecheck:rfc0001 && pnpm test:rfc0001`
Expected: helper present (≥ 1); typecheck + tests PASS against the **published** dep.

- [ ] **Step 3: Commit** (maintainer runs)

Stage `package.json`, `pnpm-lock.yaml`. Message:
`chore(example): bump kawasekit to 0.8.0 for createSponsoredKernelClient`

---

## Self-Review

**Spec coverage (design doc §2/§3/§4/§6):**
- D1 thin constructor, errors propagate as-is → Task 2 (`return client`, no wrapping) + Task 1 (`sponsorWithObservability` re-throws raw). ✅
- D2 `zerodevRpc: string` (one URL) → Task 2 params. ✅
- D3 location `src/client/sponsored-kernel-client.ts` + name → Task 1/2. ✅
- D4 option B (`observability` hook; harness adopts) → Task 2 (`observability` param) + Tasks 5 (harness maps spans + decline flag). ✅
- §5 testing: observability seam unit-tested (Task 1); type/return validated by `typecheck` (Task 2) + the consumer typecheck (Task 5 Step 4); integration via the harness suite (Task 5 Step 5). Construction-against-a-fake-account unit test is **intentionally omitted** — `createKernelAccountClient` needs a real account shape, so the real construction is covered by the harness integration rather than a brittle fake. ✅ (documented deviation)
- §6 rollout: changeset minor (Task 3); 4-point gate (Task 3 Step 3); release gate before Phase 2; harness adoption + README (Tasks 4–6). ✅

**Placeholder scan:** none — every code/step is concrete.

**Type consistency:** `SponsoredKernelClientObservability` (onSponsor/onSponsorError with `{ account }` / `{ account, error }`) is defined in Task 1 and consumed identically in Task 2 (helper) and Task 5 (harness maps `({ account }) => …`). `CreateSponsoredKernelClientParams.account: CreateKernelAccountReturnType<"0.7">` matches `restoreSessionAccount`'s return (Task 5). `createSponsoredKernelClient` and `sponsorWithObservability` names are stable across tasks. `ConfiguredKernelClient` is the existing exported alias. ✅
