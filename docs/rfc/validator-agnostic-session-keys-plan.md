# Validator-Agnostic Session-Key Issuance & Revocation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Maintainer-commits convention (this repo):** the maintainer runs all `git commit`/`push`. Each "Commit" step means **stage the listed files + hand the maintainer the conventional-commit message**, not run git yourself.

**Goal:** Generalize kawasekit's owner-side session-key primitives so the agent account's sudo owner can be any pre-built Kernel validator (ECDSA today, weighted for launch), closing RFC-0003 U-B1 (weighted issuance) + U-B2 (weighted revoke) in one additive PR.

**Architecture:** A shared internal seam (`resolveSudoValidator` + `buildSessionPermissionValidator`) lets `createAgentSmartAccount` / `issueSessionKey` accept an injected `sudoValidator` (the `AgentOwner` airtight union) and an injected `approveEnable` callback for the weighted enable signature; a new `buildRevokeSessionKeyCall` exposes the `uninstallValidation` callData for the caller to submit via their aggregate flow. No new core dependency — the caller brings the validator package.

**Tech Stack:** TypeScript (strict, ESM), `@zerodev/sdk` + `@zerodev/permissions` + `@zerodev/ecdsa-validator` (core deps), viem, Vitest. Design: `docs/rfc/validator-agnostic-session-keys-design.md`.

**Empirically pinned (probes, 2026-06-20):** `toPermissionValidator` construction + `getIdentifier()` (`= 0xd8d6ee30` for the fixtures below) + `getEnableData()` are **offline-deterministic** → the revoke golden is a real unit. `createKernelAccount` + `serializePermissionAccount` **need the chain** → issuance assembly/bytes are proven on Amoy (§6.2), matching the existing `issue-restore.test.ts` discipline.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/account/session-key.ts` | account builder + the shared seam | add `AgentOwner`, `resolveSudoValidator`, `buildSessionPermissionValidator`; refactor `createAgentSmartAccount`; add `address?` |
| `src/session/issue.ts` | issuance + envelope | add `AgentOwner` + `address?` + `approveEnable?`; thread enable signature |
| `src/session/revoke.ts` | revoke + the new builder | add `buildRevokeSessionKeyCall` (revoke single-signer fn unchanged) |
| `src/index.ts` | public surface | export `buildRevokeSessionKeyCall` + `AgentOwner` |
| `src/account/session-key.test.ts` | **new** | seam units (offline): identifier determinism + owner guard |
| `src/session/revoke.test.ts` | extend | `buildRevokeSessionKeyCall` golden-bytes (offline) |
| `src/session/issue-restore.test.ts` | extend | issuance owner-guard fail-fast (offline) |
| `.changeset/*.md` | release | minor |

The helpers live in `src/account/session-key.ts` (it already builds both validators); `src/session/*` import them — no import cycle (account never imports session). They are module-exported for cross-module use but NOT added to the public `src/index.ts` (internal).

---

## Task 1: Shared seam — `AgentOwner` + `resolveSudoValidator` + `buildSessionPermissionValidator`

**Files:**
- Modify: `src/account/session-key.ts`
- Test: `src/account/session-key.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/account/session-key.test.ts`:

```ts
/**
 * Offline seam units. These never reach `createKernelAccount` (which needs the
 * on-chain EntryPoint), so they run without a chain. The full owner-injection /
 * issuance path is proven on Amoy (design §6.2).
 */
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { polygonAmoy } from "../chains";
import { buildSessionPermissionValidator, resolveSudoValidator } from "./session-key";

const SK = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PC = createPublicClient({ chain: polygonAmoy, transport: http() });
const EP = getEntryPoint("0.7");

describe("buildSessionPermissionValidator — deterministic, offline", () => {
	it("derives a stable permission-validator identifier for fixed (signer, policies)", async () => {
		const pv = await buildSessionPermissionValidator({
			publicClient: PC,
			sessionKeySigner: SK,
			policies: [toSudoPolicy({})],
			entryPoint: EP,
			kernelVersion: KERNEL_V3_1,
		});
		expect(pv.getIdentifier()).toBe("0xd8d6ee30");
	});
});

describe("resolveSudoValidator — owner guard (no chain)", () => {
	it("throws when both ownerSigner and sudoValidator are passed", async () => {
		await expect(
			resolveSudoValidator({
				publicClient: PC,
				ownerSigner: SK,
				// biome-ignore lint/suspicious/noExplicitAny: a stand-in validator; the guard throws before it is used.
				sudoValidator: {} as any,
				entryPoint: EP,
				kernelVersion: KERNEL_V3_1,
			}),
		).rejects.toThrow(/exactly one/);
	});

	it("returns the injected sudoValidator unchanged (no chain access)", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: opaque stand-in; resolve returns it verbatim.
		const injected = { id: "fake-validator" } as any;
		await expect(
			resolveSudoValidator({ publicClient: PC, sudoValidator: injected, entryPoint: EP, kernelVersion: KERNEL_V3_1 }),
		).resolves.toBe(injected);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/account/session-key.test.ts`
Expected: FAIL — `resolveSudoValidator`/`buildSessionPermissionValidator` are not exported.

- [ ] **Step 3: Implement the seam in `src/account/session-key.ts`**

Add the `KernelValidator` import and the new exports; refactor `createAgentSmartAccount`. Add to the imports block:

```ts
import type { Address, Chain, LocalAccount, PublicClient, Transport } from "viem";
import type { KernelValidator } from "@zerodev/sdk";
```

Add the union type + helpers (above `createAgentSmartAccount`):

```ts
/** Owner = ECDSA convenience XOR a pre-built sudo validator (weighted / passkey / MPC). */
export type AgentOwner =
	| { readonly ownerSigner: LocalAccount; readonly sudoValidator?: never }
	| { readonly sudoValidator: KernelValidator; readonly ownerSigner?: never };

/**
 * Resolve the sudo validator: a caller-injected `sudoValidator`, or the ECDSA
 * convenience path from `ownerSigner`. Throws (before any chain access) if both
 * or neither is supplied — the runtime guard behind the {@link AgentOwner} union.
 */
export async function resolveSudoValidator(params: {
	readonly publicClient: PublicClient<Transport, Chain | undefined>;
	readonly ownerSigner?: LocalAccount;
	readonly sudoValidator?: KernelValidator;
	readonly entryPoint: EntryPointType<"0.7">;
	readonly kernelVersion: GetKernelVersion<"0.7">;
}): Promise<KernelValidator> {
	if (params.ownerSigner !== undefined && params.sudoValidator !== undefined) {
		throw new Error("kawasekit: pass exactly one of `ownerSigner` or `sudoValidator`, not both.");
	}
	if (params.sudoValidator !== undefined) return params.sudoValidator;
	if (params.ownerSigner === undefined) {
		throw new Error("kawasekit: pass one of `ownerSigner` (ECDSA) or `sudoValidator` (pre-built).");
	}
	return signerToEcdsaValidator(params.publicClient, {
		signer: params.ownerSigner,
		entryPoint: params.entryPoint,
		kernelVersion: params.kernelVersion,
	});
}

/**
 * Build the session-key permission validator. SHARED by issuance and revocation
 * so both derive the identical validator identifier from the same
 * `(sessionKeySigner, policies)` (identical policies in identical ORDER — the
 * identifier hashes the ordered policy array). A mismatch makes revoke target
 * the wrong validator.
 */
export async function buildSessionPermissionValidator(params: {
	readonly publicClient: PublicClient<Transport, Chain | undefined>;
	readonly sessionKeySigner: LocalAccount;
	readonly policies: readonly Policy[];
	readonly entryPoint: EntryPointType<"0.7">;
	readonly kernelVersion: GetKernelVersion<"0.7">;
}): Promise<KernelValidator> {
	const signer = await toECDSASigner({ signer: params.sessionKeySigner });
	return toPermissionValidator(params.publicClient, {
		signer,
		policies: [...params.policies],
		entryPoint: params.entryPoint,
		kernelVersion: params.kernelVersion,
	});
}
```

Replace `CreateAgentSmartAccountParams` so the owner becomes the union + add `address?`:

```ts
/** Parameters for {@link createAgentSmartAccount}. */
export type CreateAgentSmartAccountParams = {
	readonly publicClient: PublicClient<Transport, Chain | undefined>;
	readonly sessionKeySigner: LocalAccount;
	readonly policies: readonly Policy[];
	/** Bind to an existing deployed account (e.g. re-provision after recovery). */
	readonly address?: Address;
	readonly entryPoint?: EntryPointType<"0.7">;
	readonly kernelVersion?: GetKernelVersion<"0.7">;
} & AgentOwner;
```

Replace the body of `createAgentSmartAccount` to use the helpers:

```ts
export async function createAgentSmartAccount(
	params: CreateAgentSmartAccountParams,
): Promise<CreateKernelAccountReturnType<"0.7">> {
	const entryPoint = params.entryPoint ?? getEntryPoint("0.7");
	const kernelVersion = params.kernelVersion ?? KERNEL_V3_1;

	const sudoValidator = await resolveSudoValidator({
		publicClient: params.publicClient,
		ownerSigner: params.ownerSigner,
		sudoValidator: params.sudoValidator,
		entryPoint,
		kernelVersion,
	});
	const permissionValidator = await buildSessionPermissionValidator({
		publicClient: params.publicClient,
		sessionKeySigner: params.sessionKeySigner,
		policies: params.policies,
		entryPoint,
		kernelVersion,
	});

	return createKernelAccount(params.publicClient, {
		plugins: { sudo: sudoValidator, regular: permissionValidator },
		...(params.address !== undefined ? { address: params.address } : {}),
		entryPoint,
		kernelVersion,
	});
}
```

Delete the now-unused `import { signerToEcdsaValidator }` only if it is no longer referenced — it IS still used inside `resolveSudoValidator`, so keep it. Keep `toECDSASigner`, `toPermissionValidator` imports (used by `buildSessionPermissionValidator`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/account/session-key.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean. Confirms the `AgentOwner` union value-assigns for existing `ownerSigner` callers (backward-compat).

- [ ] **Step 6: Commit (stage + message for maintainer)**

Stage: `src/account/session-key.ts src/account/session-key.test.ts`
Message:
```
refactor(account): extract resolveSudoValidator + buildSessionPermissionValidator; AgentOwner union

createAgentSmartAccount now accepts an injected sudoValidator (AgentOwner airtight
union: ownerSigner XOR sudoValidator) + an optional address override, via shared
seam helpers. Backward-compatible (ownerSigner path unchanged). Offline units pin
the permission-validator identifier (0xd8d6ee30) + the owner guard.
```

---

## Task 2: `issueSessionKey` — `AgentOwner` union + `address?` + `approveEnable`

**Files:**
- Modify: `src/session/issue.ts`
- Test: `src/session/issue-restore.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/session/issue-restore.test.ts` (it already imports `createPublicClient`, `http`, `privateKeyToAccount`, `polygonAmoy`, `describe/expect/it`; add `toSudoPolicy` + `issueSessionKey` imports at the top):

```ts
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { issueSessionKey } from "./issue";
```

```ts
describe("issueSessionKey — owner guard (no chain)", () => {
	const pc = createPublicClient({ chain: polygonAmoy, transport: http() });
	const sk = privateKeyToAccount(`0x${"11".repeat(32)}`);
	const owner = privateKeyToAccount(`0x${"33".repeat(32)}`);

	it("throws when both ownerSigner and sudoValidator are passed", async () => {
		await expect(
			issueSessionKey({
				publicClient: pc,
				ownerSigner: owner,
				// biome-ignore lint/suspicious/noExplicitAny: stand-in; the guard throws before it is used.
				sudoValidator: {} as any,
				sessionKeySigner: sk,
				policies: [toSudoPolicy({})],
			}),
		).rejects.toThrow(/exactly one/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/session/issue-restore.test.ts`
Expected: FAIL — `issueSessionKey` does not yet accept `sudoValidator` (type error / no guard).

- [ ] **Step 3: Implement in `src/session/issue.ts`**

Update imports. `issue.ts` currently imports `createAgentSmartAccount` from `../account/session-key` and `Chain, LocalAccount, PublicClient, Transport` from viem, but **not** `createKernelAccount`. Replace the `createAgentSmartAccount` import with the seam helpers, add `createKernelAccount`, and add `Address`, `Hex`, `KernelValidator`:

```ts
import { createKernelAccount } from "@zerodev/sdk";
import type { KernelValidator } from "@zerodev/sdk";
import type { Address, Chain, Hex, LocalAccount, PublicClient, Transport } from "viem";
import {
	type AgentOwner,
	buildSessionPermissionValidator,
	resolveSudoValidator,
} from "../account/session-key";
```

(`createAgentSmartAccount` is no longer imported or called here — `issueSessionKey` now builds the account inline via the seam helpers so it holds the permission validator for `approveEnable`.)

Replace `IssueSessionKeyParams` so the owner is the union + `address?` + `approveEnable?` (remove the old `ownerSigner: LocalAccount` line — it now comes from `AgentOwner`):

```ts
/** Parameters for {@link issueSessionKey}. */
export type IssueSessionKeyParams = {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly sessionKeySigner: LocalAccount;
	readonly policies: readonly Policy[];
	/** Bind issuance to an existing deployed account (re-provision after recovery). */
	readonly address?: Address;
	/**
	 * Weighted-enable seam (RFC-0003 U-B1). Called with the SDK-built permission
	 * validator; returns the enable signature for `serializePermissionAccount`'s
	 * 3rd arg. Omit for an ECDSA owner (the default single-signer enable). For a
	 * weighted sudo this is `approvePlugin(plugin)` + `encodeSignatures([approval], true)`,
	 * computed by the caller with their weighted client. A mismatch surfaces on-chain
	 * as `EnableNotApproved` at first use.
	 */
	readonly approveEnable?: (permissionValidator: KernelValidator) => Promise<Hex>;
	readonly expiresAt?: bigint;
	readonly policySummary?: KawasekitSessionPolicySummary;
	readonly entryPoint?: EntryPointType<"0.7">;
	readonly kernelVersion?: GetKernelVersion<"0.7">;
} & AgentOwner;
```

Rewrite the build/serialize portion of `issueSessionKey` so it owns the permission validator (needed for `approveEnable`) instead of delegating opaquely to `createAgentSmartAccount`:

```ts
	const supportedChainId: SupportedChainId = chainId;
	const entryPoint = params.entryPoint ?? getEntryPoint("0.7");
	const kernelVersion = params.kernelVersion ?? KERNEL_V3_1;

	const sudoValidator = await resolveSudoValidator({
		publicClient: params.publicClient,
		ownerSigner: params.ownerSigner,
		sudoValidator: params.sudoValidator,
		entryPoint,
		kernelVersion,
	});
	const permissionValidator = await buildSessionPermissionValidator({
		publicClient: params.publicClient,
		sessionKeySigner: params.sessionKeySigner,
		policies: params.policies,
		entryPoint,
		kernelVersion,
	});
	const account = await createKernelAccount(params.publicClient, {
		plugins: { sudo: sudoValidator, regular: permissionValidator },
		...(params.address !== undefined ? { address: params.address } : {}),
		entryPoint,
		kernelVersion,
	});

	const enableSignature = params.approveEnable ? await params.approveEnable(permissionValidator) : undefined;
	const serialized = enableSignature
		? await serializePermissionAccount(account, undefined, enableSignature)
		: await serializePermissionAccount(account);
```

Add the now-needed imports at the top of `issue.ts`: `createKernelAccount` from `@zerodev/sdk`. (The previously-used `createAgentSmartAccount` import is no longer called here — remove it from the import if unused, but keep `resolveSudoValidator` + `buildSessionPermissionValidator`.) The `base`/envelope construction below `serialized` is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/session/issue-restore.test.ts`
Expected: PASS (existing fail-fast tests + the new owner-guard test).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean (the union + the new optional params value-assign for existing `ownerSigner` callers).

- [ ] **Step 6: Commit (stage + message)**

Stage: `src/session/issue.ts src/session/issue-restore.test.ts`
Message:
```
feat(session): issueSessionKey accepts a pre-built sudoValidator + approveEnable (U-B1)

issueSessionKey gains the AgentOwner union (ownerSigner XOR sudoValidator), an
address override, and an injected approveEnable callback whose result is threaded
into serializePermissionAccount's 3rd arg — enabling issuance under a weighted sudo.
Backward-compatible; the weighted enable signature is the caller's (no weighted dep
in core). Offline owner-guard unit added; the on-chain path is the §6.2 Amoy gate.
```

---

## Task 3: `buildRevokeSessionKeyCall` + golden bytes (U-B2)

**Files:**
- Modify: `src/session/revoke.ts`
- Test: `src/session/revoke.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/session/revoke.test.ts` (add the imports it needs at the top):

```ts
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "../chains";
import { buildRevokeSessionKeyCall } from "./revoke";
```

```ts
describe("buildRevokeSessionKeyCall — offline golden bytes", () => {
	// Fixed inputs → deterministic output (construction + getIdentifier/getEnableData
	// are offline-deterministic; verified by probe). Pins real vId + real deinitData,
	// not just the selector. Byte-faithfulness to the on-chain path is the §6.2 gate.
	const SK = privateKeyToAccount(`0x${"11".repeat(32)}`);
	const ADDR = `0x${"22".repeat(20)}` as const;
	const GOLDEN =
		"0xe6f3d50a02d8d6ee30000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000016000067b436caD8a6D025DF6C82C5BB43fbF11fC5B9B700000000000000000000000000000000000000000000000000000000000000000000000000000000002a00006A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

	it("reproduces the exact uninstallValidation call for fixed inputs", async () => {
		const pc = createPublicClient({ chain: polygonAmoy, transport: http() });
		const data = await buildRevokeSessionKeyCall({
			publicClient: pc,
			sessionKeySigner: SK,
			policies: [toSudoPolicy({})],
			smartAccountAddress: ADDR,
			entryPoint: getEntryPoint("0.7"),
			kernelVersion: KERNEL_V3_1,
		});
		expect(data).toBe(GOLDEN);
		expect(data.slice(0, 10)).toBe("0xe6f3d50a"); // uninstallValidation(bytes21,bytes,bytes)
		expect(data.slice(10, 52)).toBe(`02d8d6ee30${"00".repeat(16)}`); // vId = PERMISSION ‖ pad(id,20)
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/session/revoke.test.ts`
Expected: FAIL — `buildRevokeSessionKeyCall` is not exported.

- [ ] **Step 3: Implement `buildRevokeSessionKeyCall` in `src/session/revoke.ts`**

Add imports. `revoke.ts` currently imports `getEntryPoint, KERNEL_V3_1` from `@zerodev/sdk/constants`, `Policy` from `@zerodev/permissions`, `EntryPointType, GetKernelVersion` from `@zerodev/sdk/types`, and only `getAddress, Hash, LocalAccount` from viem — it does **not** import `PublicClient/Transport/Chain`. Add `VALIDATOR_TYPE` to the constants import and the missing viem names:

```ts
import { getEntryPoint, KERNEL_V3_1, VALIDATOR_TYPE } from "@zerodev/sdk/constants";
import {
	type Address, type Chain, concatHex, encodeFunctionData, getAddress,
	type Hash, type Hex, type LocalAccount, pad, parseAbi, type PublicClient, type Transport,
} from "viem";
import { buildSessionPermissionValidator } from "../account/session-key";
```

(`Policy`, `EntryPointType`, `GetKernelVersion` are already imported — reuse them. Merge the viem names into the existing `from "viem"` line rather than duplicating it.)

Add the ABI constant + the function (export it):

```ts
const UNINSTALL_VALIDATION_ABI = parseAbi([
	"function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)",
]);

/** Parameters for {@link buildRevokeSessionKeyCall}. */
export interface BuildRevokeSessionKeyCallParams {
	readonly publicClient: PublicClient<Transport, Chain>;
	/** The session-key signer the key was ISSUED with. */
	readonly sessionKeySigner: LocalAccount;
	/**
	 * The policies the key was issued with — identical policies in identical
	 * ORDER, since the validator identifier hashes the ordered policy array.
	 * A mismatch reverts at `uninstallValidation`.
	 */
	readonly policies: readonly Policy[];
	/** The deployed agent smart-account address. */
	readonly smartAccountAddress: Address;
	readonly entryPoint?: EntryPointType<"0.7">;
	readonly kernelVersion?: GetKernelVersion<"0.7">;
}

/**
 * Build the `uninstallValidation(vId, deinitData, hookDeinitData)` call that
 * removes a session-key permission validator — a byte-exact reproduction of
 * `@zerodev/sdk`'s `uninstallPlugin` inner call, which the SDK cannot call
 * directly because it hardcodes the single-signer `sendUserOperation` path a
 * weighted/passkey/MPC owner rejects.
 *
 * Submit it yourself: single-signer owners via {@link revokeSessionKey};
 * weighted/passkey/MPC owners via their aggregate flow —
 * `account.encodeCalls([{ to: smartAccountAddress, value: 0n, data }])` →
 * `sendUserOperationWithSignatures`.
 *
 * @example
 * ```ts
 * const data = await buildRevokeSessionKeyCall({
 *   publicClient, sessionKeySigner, policies, smartAccountAddress,
 * });
 * const callData = await weightedAccount.encodeCalls([{ to: smartAccountAddress, value: 0n, data }]);
 * // …approveUserOperation per signer → sendUserOperationWithSignatures(callData, signatures)
 * ```
 */
export async function buildRevokeSessionKeyCall(
	params: BuildRevokeSessionKeyCallParams,
): Promise<Hex> {
	const entryPoint = params.entryPoint ?? getEntryPoint("0.7");
	const kernelVersion = params.kernelVersion ?? KERNEL_V3_1;
	const plugin = await buildSessionPermissionValidator({
		publicClient: params.publicClient,
		sessionKeySigner: params.sessionKeySigner,
		policies: params.policies,
		entryPoint,
		kernelVersion,
	});
	// vId = VALIDATOR_TYPE.PERMISSION ‖ getIdentifier() right-padded to 20 bytes (bytes21).
	const vId = concatHex([VALIDATOR_TYPE.PERMISSION, pad(plugin.getIdentifier(), { size: 20, dir: "right" })]);
	const deinitData = await plugin.getEnableData(getAddress(params.smartAccountAddress));
	return encodeFunctionData({
		abi: UNINSTALL_VALIDATION_ABI,
		functionName: "uninstallValidation",
		args: [vId, deinitData, "0x"],
	});
}
```

`getEntryPoint` / `KERNEL_V3_1` (constants), `Policy` (`@zerodev/permissions`), and `EntryPointType` / `GetKernelVersion` (`@zerodev/sdk/types`) are already imported in `revoke.ts` — reuse them; the `PublicClient` / `Transport` / `Chain` / `Address` / `Hex` / etc. added above are the new ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/session/revoke.test.ts`
Expected: PASS — `data === GOLDEN`, selector + vId assertions hold.

- [ ] **Step 5: Export from `src/index.ts`**

In the revoke export block, add the new symbols:

```ts
export {
	type BuildRevokeSessionKeyCallParams,
	buildRevokeSessionKeyCall,
	type RevokeSessionKeyParams,
	type RevokeSessionKeyResult,
	revokeSessionKey,
} from "./session/revoke";
```

In the account export block, add the `AgentOwner` type:

```ts
export {
	type AgentOwner,
	type CreateAgentSmartAccountParams,
	createAgentSmartAccount,
} from "./account/session-key";
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit (stage + message)**

Stage: `src/session/revoke.ts src/session/revoke.test.ts src/index.ts`
Message:
```
feat(session): buildRevokeSessionKeyCall — uninstallValidation callData for non-single-signer owners (U-B2)

New export building the byte-exact uninstallValidation(vId, deinitData, "0x") call
(reproducing @zerodev's uninstallPlugin inner call) for weighted/passkey/MPC owners
to submit via their aggregate flow; the single-signer revokeSessionKey is unchanged.
Reuses the shared permission-validator helper so issue and revoke derive the same
vId. Offline golden-bytes test pins real vId + deinitData (selector 0xe6f3d50a).
```

---

## Task 4: Changeset + 4-point gate

**Files:**
- Create: `.changeset/validator-agnostic-session-keys.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/validator-agnostic-session-keys.md`:

```md
---
"kawasekit": minor
---

feat: validator-agnostic session-key issuance + revocation (RFC-0003 U-B1/U-B2)

`issueSessionKey` / `createAgentSmartAccount` now accept a pre-built `sudoValidator`
(the `AgentOwner` union: `ownerSigner` XOR `sudoValidator`) plus an optional `address`
override and an injected `approveEnable` callback for the weighted enable signature —
enabling issuance under a weighted (or passkey/MPC) sudo without kawasekit depending on
those validator packages. New export `buildRevokeSessionKeyCall` returns the
`uninstallValidation` callData for non-single-signer owners to submit via their
aggregate flow. Fully additive: existing ECDSA `ownerSigner` callers are unchanged.
```

- [ ] **Step 2: Run the 4-point pre-push gate**

Run each and confirm all green (the project's pre-push discipline — do not skip lint):
```
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
Expected: typecheck clean; lint exit 0 (Biome); all vitest tests pass incl. the new units + the existing ECDSA / daily-limit / issue-restore / envelope suites; build emits dual ESM/CJS.

- [ ] **Step 3: Commit (stage + message)**

Stage: `.changeset/validator-agnostic-session-keys.md`
Message:
```
chore(changeset): validator-agnostic session keys (minor)
```

---

## Task 5: On-chain validation gate (REQUIRED before stable — cross-repo)

This is the load-bearing byte/integration proof for everything that reaches
`createKernelAccount` (issuance assembly, the weighted-enable threading, the serialized
blob, restore + pay). It is **not** a colocated unit (design §6.2). It runs in the
`kawasekit-example` repo against Amoy and **gates the stable promotion**.

- [ ] **Step 1: Publish a release candidate** of kawasekit from this branch (e.g. `0.9.0-rc.0`) — do NOT promote to `latest` yet.

- [ ] **Step 2: Re-point the RFC-0003 example onto the SDK** — in `kawasekit-example/zerodev-passkey-jpyc`, replace the inline `issueSessionKeyUnderWeightedSudo` with `issueSessionKey({ sudoValidator: <weighted>, approveEnable, sessionKeySigner, policies, address })` and `uninstallSessionKeyData` with `buildRevokeSessionKeyCall(...)`, consuming `kawasekit@0.9.0-rc.0` (or a `link:` to this branch's `dist/`). The example's `approveEnable` wraps `approvePlugin` + `encodeSignatures` (document the Kernel-v3.1 `address = f(sudo)` assumption in the comment — design F5).

- [ ] **Step 3: Run the live recovery suite on Amoy** — `pnpm exec vitest run zerodev-passkey-jpyc/recovery.test.ts`. Expected: **R2 / R3+R4a / R4b / R4c green (6/6)**, proving the SDK functions reproduce the harness behavior on-chain (issue under the weighted sudo via `approveEnable`; revoke via `buildRevokeSessionKeyCall` + `sendWeighted`).

- [ ] **Step 4: Promote** — only on a green Amoy re-run, promote the rc to a stable `0.9.0` (changeset version + release). A failed or skipped re-run blocks promotion.

---

## Self-review

**Spec coverage (design §1–§9):**
- §2 seam (SDK owns encoding, caller injects sign/submit) → Tasks 1–3 (`resolveSudoValidator`/`buildSessionPermissionValidator` shared; `approveEnable` + `buildRevokeSessionKeyCall` are the caller seams). ✓
- §3 issuance (union + `address?` + `approveEnable`) → Tasks 1–2. ✓
- §4 revoke (`buildRevokeSessionKeyCall`) → Task 3. ✓
- §5 unchanged (`restoreSessionAccount`, single-signer `revokeSessionKey`, envelope, no new dep) → no task touches them; revoke fn body untouched. ✓
- §6.1 offline units (revoke golden, same-vId invariant via `getIdentifier`, owner guard) → Task 1 (identifier `0xd8d6ee30` + guard) + Task 3 (golden). ✓
- §6.2 required Amoy gate → Task 5. ✓
- §7 minor changeset + named exports + JSDoc `@example` → Task 4 + the `@example` on `buildRevokeSessionKeyCall`. ✓
- §8 files → all covered. ✓
- §9 risks (vId order, enable mismatch, union ergonomics, Kernel address assumption) → encoded in JSDoc/comments + the F5 comment requirement in Task 5 step 2. ✓

**Placeholder scan:** golden bytes are the real computed value (906 chars); identifier `0xd8d6ee30` is real; no TBD/TODO. ✓

**Type consistency:** `AgentOwner`, `resolveSudoValidator`, `buildSessionPermissionValidator`, `buildRevokeSessionKeyCall`, `BuildRevokeSessionKeyCallParams`, `approveEnable` used identically across Tasks 1–4. `CreateAgentSmartAccountParams`/`IssueSessionKeyParams` are intersections with `AgentOwner` in both. ✓

**Sequencing:** Task 1 (seam) → Task 2 (issue, depends on the seam) → Task 3 (revoke builder, depends on the seam) → Task 4 (changeset + gate) → Task 5 (Amoy, cross-repo, gates stable). Tasks 2 and 3 both depend only on Task 1 and are independent of each other.
