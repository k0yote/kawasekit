# Validator-Agnostic Session-Key Issuance & Revocation — Design

| | |
|---|---|
| **Status** | Draft — design approved, pending spec review → implementation plan |
| **Author** | k0yote (with Claude) |
| **Date** | 2026-06-20 |
| **Realizes** | RFC-0003 §8 SDK gaps **U-B1** (weighted-capable issuance) + **U-B2** (weighted-capable revoke) — consolidated into one kawasekit PR |
| **Supersedes** | The Cycle-1 SDK gap **G1** (bare-passkey issuance) is **NOT** a deliverable here — the launch owner is a weighted sudo whose primary signer is the passkey, so bare-passkey issuance is absorbed by U-B1. The generic `sudoValidator` door admits a passkey validator, but passkey is not a tested/documented case in this PR. |
| **SDK baseline** | kawasekit core deps only: `@zerodev/ecdsa-validator`, `@zerodev/permissions`, `@zerodev/sdk`, viem. **No new core dependency.** |

---

## 1. Goal & non-goals

**Goal.** Generalize kawasekit's owner-side session-key primitives so the agent account's **sudo owner can be any pre-built Kernel validator** (ECDSA today, **weighted** for launch, passkey/MPC later) — closing RFC-0003 U-B1 (issue under a weighted sudo) and U-B2 (revoke under a weighted sudo) in one additive, backward-compatible change.

**Root cause being fixed.** `createAgentSmartAccount` hardcodes `signerToEcdsaValidator(ownerSigner)` (`src/account/session-key.ts:93`), so the SDK can only issue/revoke under an ECDSA EOA owner. A weighted (or passkey) owner cannot use `issueSessionKey` / `revokeSessionKey` today; the RFC-0003 example works around this with raw `@zerodev` code (`issueSessionKeyUnderWeightedSudo`, `uninstallSessionKeyData`, `approveSessionKeyEnable`). This design lifts those proven patterns into the SDK.

**Non-goals.**
- Bare-passkey issuance as a named deliverable (G1) — out (see header).
- Touching the **agent side** (`restoreSessionAccount` / `agentPay`) — unchanged; it is already owner-type-agnostic (proven by RFC-0003 R4b/R4c, which paid from weighted-issued envelopes).
- `rotateSessionKey` generalization — out of scope for this PR. `rotateSessionKey` stays ECDSA-only; **weighted rotation composes from the two new primitives** (`buildRevokeSessionKeyCall` + `sendWeighted` to revoke the old, then `issueSessionKey({ sudoValidator, approveEnable })` to issue the new), so the Hub can rotate today without a dedicated helper. A first-class weighted `rotateSessionKey` is **deferred** (F4 — confirmed 2026-06-20: the Hub's session keys are disposable/scoped, so rotation = issue-new + revoke-old composes; no atomic helper needed soon). Fast-follow only if that changes.
- Adding `@zerodev/weighted-validator` / `@zerodev/passkey-validator` to core — forbidden (tree-shakeable / pluggable-AA).

---

## 2. The seam principle (dependency boundary)

kawasekit core must not depend on any specific validator package. Therefore:

> **The SDK owns the error-prone *encoding*; the caller owns the *signing/submission*.**

| Concern | Owner | Why |
|---|---|---|
| permission-validator construction (from session signer + policies) | **SDK** | deterministic; must be identical at issue and revoke |
| `serializePermissionAccount` (envelope blob) | **SDK** | the portable artifact |
| `uninstallValidation` byte layout (vId / deinitData / hook) | **SDK** | byte-exact reproduction of `@zerodev/sdk`'s `uninstallPlugin` inner call |
| **weighted enable signature** (`approvePlugin` + `encodeSignatures`) | **caller** | needs `@zerodev/weighted-validator` |
| **weighted aggregate submit** (`approveUserOperation` → `sendUserOperationWithSignatures`) | **caller** | needs the weighted client |

The caller brings the validator dependency and injects the two weighted-specific pieces through narrow seams (a callback for enable, a callData builder for revoke).

**Correctness invariant (the core of the design).** Issue and revoke MUST derive the **same permission-validator identifier**, which is a function of `(sessionKeySigner, policies)` — and because the identifier hashes the **ordered** policy array, that means **the same policies in the same order** (F3). A shared internal helper `buildSessionPermissionValidator(...)` guarantees this when both call it with the same `policies` array — the SDK analog of the example's shared `buyListPolicies`. The caller must pass the *identical, identically-ordered* policy array to issue and revoke; a mismatch makes `uninstallValidation` target the wrong validator and revert.

---

## 3. Component A — generalized issuance (U-B1)

### 3.1 Owner = an airtight union (additive, backward-compatible)

```ts
import type { KernelValidator } from "@zerodev/sdk"; // exact generic pinned at impl

/** ECDSA convenience XOR a pre-built sudo validator (weighted / passkey / MPC). */
type AgentOwner =
  | { ownerSigner: LocalAccount;      sudoValidator?: never }
  | { sudoValidator: KernelValidator; ownerSigner?: never };
```

Existing callers passing `ownerSigner` keep working unchanged. New callers pass a pre-built `sudoValidator`. The `?: never` arms make the union airtight (cannot pass both).

### 3.2 Internal helpers (small refactor, DRY)

```ts
// Resolve the sudo validator: convenience ECDSA path, or the injected validator.
async function resolveSudoValidator(params): Promise<KernelValidator> {
  return params.sudoValidator ?? signerToEcdsaValidator(params.publicClient, {
    signer: params.ownerSigner, entryPoint, kernelVersion,
  });
}

// The session-key permission validator. SHARED by issue + revoke → identical vId.
async function buildSessionPermissionValidator(params): Promise<KernelValidator> {
  const signer = await toECDSASigner({ signer: params.sessionKeySigner });
  return toPermissionValidator(params.publicClient, {
    signer, policies: [...params.policies], entryPoint, kernelVersion,
  });
}
```

`createAgentSmartAccount` is refactored to use both (its public return stays `CreateKernelAccountReturnType<"0.7">` — backward-compatible) and gains the `AgentOwner` union + an optional `address?: Address`.

**It does NOT take `approveEnable` (F2).** `createAgentSmartAccount` builds the **account object only** — it never serializes or embeds an enable signature. The session-key (regular) validator is enabled at first use, and for a weighted sudo that enable signature is baked into the serialized envelope by **`issueSessionKey`** (the only function that serializes). So the weighted enable is exclusively an `issueSessionKey` concern; `createAgentSmartAccount` stays enable-free. (A caller who uses the returned account object directly with a weighted client owns the first-use enable themselves at send time — kawasekit's documented flow is always issue → serialize → restore → agent-send.)

### 3.3 `issueSessionKey` — the union + `approveEnable` + `address`

```ts
interface IssueSessionKeyParams /* & AgentOwner */ {
  publicClient: PublicClient<Transport, Chain>;
  sessionKeySigner: LocalAccount;
  policies: readonly Policy[];
  /** Bind issuance to an existing deployed account (e.g. re-provision after recovery, RFC-0003 R4b). */
  address?: Address;
  /**
   * Injected weighted-enable seam (U-B1). Called with the SDK-built permission
   * validator; returns the enable signature for `serializePermissionAccount`'s
   * 3rd arg. Omit for ECDSA (the default single-signer enable). For a weighted
   * sudo this is `approvePlugin(plugin)` + `encodeSignatures([approval], true)`,
   * computed by the caller with their weighted client.
   */
  approveEnable?: (permissionValidator: KernelValidator) => Promise<Hex>;
  entryPoint?: EntryPointType<"0.7">;
  kernelVersion?: GetKernelVersion<"0.7">;
  expiresAt?: bigint;
  policySummary?: KawasekitSessionPolicySummary;
}
```

Flow:
```ts
const sudo = await resolveSudoValidator(params);
const permissionValidator = await buildSessionPermissionValidator(params);
const account = await createKernelAccount(publicClient, {
  plugins: { sudo, regular: permissionValidator },
  ...(params.address !== undefined ? { address: params.address } : {}),
  entryPoint, kernelVersion,
});
const enableSig = params.approveEnable ? await params.approveEnable(permissionValidator) : undefined;
const serialized = enableSig
  ? await serializePermissionAccount(account, undefined, enableSig)  // weighted (U-B1)
  : await serializePermissionAccount(account);                       // ECDSA / default
// …wrap in KawasekitSessionEnvelope exactly as today (envelope format UNCHANGED).
```

**Caller-side (the Hub / example) `approveEnable`** — the existing `approveSessionKeyEnable`, refactored to receive the plugin:
```ts
approveEnable: async (plugin) => {
  // Kernel v3.1: address = f(sudo + initial config), REGULAR-independent — so a
  // sudo-only client points at the SAME account as the {sudo, regular} account
  // issueSessionKey builds. (This breaks if Kernel ever makes address depend on
  // the regular validator; document the assumption in the caller's code — F5.)
  const client = createWeightedKernelAccountClient({ account: <weighted sudo-only @ address>, ... });
  const approval = await client.approvePlugin({ plugin, validatorContractVersion: WV });
  return encodeSignatures([approval], true);
}
```

**Failure mode.** A mismatched `approveEnable` (wrong signer set / wrong account) surfaces on-chain as `EnableNotApproved` (`0xc48cf8ee`) at first use — documented; the SDK cannot verify it offline.

---

## 4. Component B — generalized revoke (U-B2)

A new exported builder returns the **inner `uninstallValidation` callData** — the byte-exact reproduction of `@zerodev/sdk`'s `uninstallPlugin` action (`actions/account-client/uninstallPlugin.js`), which the SDK cannot call directly because it hardcodes the single-signer `sendUserOperation` path the weighted validator rejects.

```ts
/**
 * The `uninstallValidation(vId, deinitData, hookDeinitData)` call that removes a
 * session-key permission validator. Submit it yourself: single-signer owners via
 * the existing `revokeSessionKey`; weighted/passkey/MPC owners via their aggregate
 * flow (`account.encodeCalls([{to, value:0n, data}])` → `sendUserOperationWithSignatures`).
 *
 * `sessionKeySigner` + `policies` MUST match what the key was issued with —
 * identical policies in identical ORDER, since the validator identifier hashes
 * the ordered policy array (a mismatch reverts at uninstall).
 */
export async function buildRevokeSessionKeyCall(params: {
  publicClient: PublicClient<Transport, Chain>;
  sessionKeySigner: LocalAccount;
  policies: readonly Policy[];
  smartAccountAddress: Address;
  entryPoint?: EntryPointType<"0.7">;
  kernelVersion?: GetKernelVersion<"0.7">;
}): Promise<Hex>;
```

Encoding (all from core deps — `@zerodev/sdk/constants` `VALIDATOR_TYPE` + viem):
```ts
const plugin = await buildSessionPermissionValidator(params);          // SAME helper as issue → same vId
const validatorId = concatHex([VALIDATOR_TYPE.PERMISSION, pad(plugin.getIdentifier(), { size: 20, dir: "right" })]);
const deinitData = await plugin.getEnableData(params.smartAccountAddress);
return encodeFunctionData({
  abi: parseAbi(["function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)"]),
  functionName: "uninstallValidation",
  args: [validatorId, deinitData, "0x"],
});
```

- **single-signer caller** → existing `revokeSessionKey` (signature **unchanged**; optionally refactored to delegate to this builder internally + `uninstallPlugin`/send).
- **weighted/passkey/MPC caller** → `buildRevokeSessionKeyCall()` → `account.encodeCalls([{ to: address, value: 0n, data }])` → `sendWeighted([passkeyOwnerClient])` (caller-side).

**Asymmetry (intentional).** Issuance injects at the *middle* (enable → callback); revoke injects at the *end* (submit → caller owns it entirely → builder). The SDK exposes each operation's hard, byte-exact part and lets the caller sign/submit with their validator dep.

---

## 5. What is explicitly unchanged

- `restoreSessionAccount` / `agentPay` / the agent side — untouched (owner-type-agnostic; RFC-0003 R4b/R4c proof).
- `revokeSessionKey` (single-signer) — signature unchanged; still the ECDSA convenience.
- `KawasekitSessionEnvelope` format + version — unchanged (the `serialized` blob now may carry a weighted enable, transparently).
- No new core dependency; `rotateSessionKey` untouched.

---

## 6. Testing & validation

**The chain boundary decides where each claim lives (F1, empirically resolved 2026-06-20).** The project's existing discipline (`issue-restore.test.ts` / `revoke.test.ts`): colocated SDK tests do **no chain interaction**, because anything reaching `createKernelAccount` queries the on-chain EntryPoint v0.7 and bare anvil lacks it (`InvalidEntryPointError`). Two probes pin which half of this feature is offline:

| Path | Touches `createKernelAccount`? | Offline-deterministic? | Where its byte-correctness is proven |
|---|---|---|---|
| `buildRevokeSessionKeyCall` (permission validator + `uninstallValidation` encode) | **No** | **Yes — proven** (construction never hit a throw-transport; `getIdentifier()` = `0xd8d6ee30` and `getEnableData()` both deterministic across rebuilds) | **§6.1 golden-bytes unit** |
| `issueSessionKey` / `createAgentSmartAccount` (`createKernelAccount` + `serializePermissionAccount`) | **Yes** | **No — proven** (throw-transport → RPC error) | **§6.2 Amoy** (matches `issue-restore.test.ts`) |

So the revoke byte-correctness is front-loaded to an offline unit; the issuance byte/assembly correctness is **necessarily** the on-chain gate — not a shortcut, a property of `createKernelAccount`. A bare mock validator is explicitly **not** used for revoke bytes — a real permission validator (offline, deterministic) pins the real `vId`/`deinitData`.

### 6.1 SDK colocated unit tests (no chain — matching `issue-restore.test.ts` / `revoke.test.ts`)

1. **`buildRevokeSessionKeyCall` golden-bytes** — build a real permission validator offline from fixed `(sessionKeySigner, policies, smartAccountAddress)` and assert the **full `uninstallValidation` Hex byte-for-byte** against a golden captured from the Amoy-proven harness output (pins real `vId` **and** real `deinitData`, not just selector `0xe6f3d50a`).
2. **Same-vId invariant** — the shared `buildSessionPermissionValidator` yields the **identical** validator identifier for the same `(sessionKeySigner, policies)` in the **same order** (F3; offline, deterministic). This is the issue=revoke correctness guard.
3. **Airtight-union runtime guard** — `issueSessionKey` / `createAgentSmartAccount` throw a clear error when **both** `ownerSigner` and `sudoValidator` are passed (the type-level `?: never` blocks it at compile time; the guard catches a JS caller). This runs **before** `createKernelAccount`, so it is a no-chain unit.

The existing ECDSA `issueSessionKey` / `revokeSessionKey` / daily-limit / `issue-restore` / `envelope` tests must stay green (backward-compat gate).

> Not unit-testable offline (→ §6.2): sudo injection producing the same address, the `approveEnable` weighted-enable threading, and the issuance serialized blob — all reach `createKernelAccount`.

### 6.2 On-chain validation gate (before stable — REQUIRED, load-bearing)

§6.1 proves the revoke bytes (golden), the issue=revoke vId invariant, and the union guard — all offline. It does **not** prove anything that reaches `createKernelAccount`: that the `sudoValidator` door yields the same account as `ownerSigner`, the `approveEnable` weighted-enable threading, the issuance serialized blob, the agent restoring a weighted-issued envelope, and on-chain `validateUserOp` accept/reject. That proof exists only here, so **this gate is required, not a confidence boost** — skipping it ships unproven plumbing to stable.

**Before promoting to a stable release**, the RFC-0003 example is re-pointed onto the new SDK functions (replacing its inline `issueSessionKeyUnderWeightedSudo` / `uninstallSessionKeyData` with `issueSessionKey({ sudoValidator, approveEnable })` / `buildRevokeSessionKeyCall`) and the existing **R4b/R4c live suite is re-run on Amoy (6/6)**.

Release flow (cross-repo, mandatory): **publish an `rc` → example consumes the `rc` → on-chain re-run on Amoy (6/6) → only on green, promote `rc` → stable.** (Same rc-gate discipline as the mpc-2p file-link → npm-dep switch.) A failed or skipped re-run blocks the stable promotion.

---

## 7. Semver, changeset, naming

- **Additive → minor** (`0.8.0` → `0.9.0`). Changeset required.
- Public API delta: `issueSessionKey` / `createAgentSmartAccount` gain the `AgentOwner` union + `address?` + `approveEnable?`; **new export** `buildRevokeSessionKeyCall`. All named exports with JSDoc + `@example` (CLAUDE.md convention).
- Names are provisional, finalized in the plan: `buildRevokeSessionKeyCall` (alt: `getRevokeSessionKeyCallData`), `approveEnable` (alt: `getEnableSignature`).

---

## 8. Files touched

| File | Change |
|---|---|
| `src/account/session-key.ts` | `AgentOwner` union + `address?`; extract `resolveSudoValidator` + `buildSessionPermissionValidator`; keep return type |
| `src/session/issue.ts` | `AgentOwner` union + `address?` + `approveEnable?`; thread enable signature into `serializePermissionAccount` |
| `src/session/revoke.ts` | add `buildRevokeSessionKeyCall`; optionally delegate `revokeSessionKey` to it |
| `src/index.ts` | export `buildRevokeSessionKeyCall` + the `AgentOwner` type |
| `*.test.ts` (colocated) | unit tests §6.1 — assembly (real ECDSA validator injected) + byte-correctness (real permission validator vs golden fixtures) + airtight-union + invariant |
| `test/fixtures/` (or colocated) | captured golden-bytes fixtures from the Amoy-proven harness output (`buildRevokeSessionKeyCall` Hex; issue serialized-enable blob) |
| `.changeset/*.md` | minor |

---

## 9. Risks

- **Issuance byte-correctness rests on the on-chain gate (F1)** — `revoke` bytes are pinned offline by the §6.1 golden (proven deterministic), but anything through `createKernelAccount` (issuance assembly, the weighted-enable threading, the serialized blob, restore+pay) is provable only on-chain. The rc → verify → promote gate is therefore **required and load-bearing**, not an optional confidence boost; skipping it ships unproven issuance plumbing to stable.
- **Enable/sudo mismatch** — caller's `approveEnable` must correspond to the installed `sudoValidator`; mismatch → `EnableNotApproved` on-chain. Documented; not offline-verifiable.
- **vId drift** — if a caller passes different `policies` (or a different *order*) to issue vs revoke, the uninstall targets the wrong validator. Mitigated by the shared helper + the doc note (identical, identically-ordered policies) + the §6.1 invariant test.
- **Type-union ergonomics** — the airtight union must value-assign cleanly for existing `ownerSigner` callers; covered by the backward-compat tests and the `[type-level-breaking-change-discipline]`.
- **Kernel address-derivation assumption (F5)** — the caller's sudo-only `approveEnable` client only hits the same account because Kernel v3.1 derives the address from the sudo (regular-independent). Harness-proven, so not a live risk, but the assumption must be stated in the caller's code comment — it breaks if a future Kernel makes the address depend on the regular validator.
