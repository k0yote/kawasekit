# RFC-0003 Cycle 2 — Non-Custodial Recovery (Approach B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Supersedes** the earlier Approach-A plan (bare passkey sudo + separate weighted-ecdsa guardian) — that design is un-buildable on Amoy. This is **Approach B** (the owner IS a weighted validator), revised RFC §6 + recovery **gate-proven on Amoy 2026-06-20**.

> **✅ COMPLETE — Amoy 2026-06-20.** All tasks done; the full acceptance is green and re-runnable
> (`pnpm exec vitest run zerodev-passkey-jpyc/recovery.test.ts` → **6/6**: 2 unit + R2/R3+R4a/R4b/R4c).
> **C1-revalidate ✅** (U-B1: session-key floor under the weighted sudo — needs the weighted enable
> signature `approvePlugin`+`encodeSignatures`, the default single-signer enable fails `EnableNotApproved`).
> **R2 ✅** the non-custodial de-risk (Hub-alone 50<100 rejected on-chain paymaster-less — threw the weighted
> threshold/AA24, **not** an AA21 prefund artifact). **R3/R4a ✅** config-reset + address-invariant + no JPYC moved.
> **R4b ✅** new owner re-provisions a session key → agent pays. **R4c ✅** (U-B2 resolved: kawasekit's
> `revokeSessionKey` calls `uninstallPlugin`, which hardcodes the single-signer send the weighted validator
> rejects → reproduce the inner `uninstallValidation` call and submit via `sendWeighted`).

**Goal:** Implement RFC-0003 Cycle 2 (Approach B) on Amoy: the account owner is one **weighted validator** `[passkey 100, Hub 50, backup 50, threshold 100]`; **non-custodial recovery** = the guardian quorum (Hub+backup = 100) config-resets the owner to a new passkey; and the RFC-0001 session-key floor is **re-validated under the weighted sudo**.

**Architecture:** The Cycle-1 bare-passkey owner is replaced by a weighted-validator owner whose primary signer is the passkey (weight 100 → signs alone normally). Multi-signer ops use the approve/aggregate flow (`createWeightedValidator` per signer → `approveUserOperation` → `sendUserOperationWithSignatures`). Recovery resets the weighted config via `doRecovery(weightedAddr, newWeighted.getEnableData())`, with the recovery executor installed as a **fallback module** (`getRecoveryFallbackActionInstallModuleData` + `pluginMigrations`). The agent floor (session keys) is enabled under the weighted sudo, then the agent (session key) pays as in RFC-0001.

**Tech Stack:** `@zerodev/weighted-validator` 5.5.1 (`createWeightedValidator`, `toWebAuthnSigner`, `toECDSASigner`, `createWeightedKernelAccountClient`, `approveUserOperation`, `sendUserOperationWithSignatures`, `getValidatorAddress`, `getRecoveryFallbackActionInstallModuleData`; module `0x144F…`, executor `0xe884…`+hook `0xb230…`, all on Amoy), `ox` passkeys (`webAuthnKeyForPasskey`), `@zerodev/sdk` 5.5.10, kawasekit session/policy, viem.

---

## Gate already proven (the mechanism is NOT a spike)

`probe-recovery.ts` proved B's recovery end-to-end on Amoy (2026-06-20): deploy weighted-sudo [`0xcbfb7298…`], guardians-only `doRecovery` config-reset to a new passkey [`0xd35fcf9a…`], new passkey signs alone at the same address [`0x87b2b0a7…`]. So R1/R3/R4a are gate-backed; this plan **formalizes** them and builds the parts the gate did NOT cover.

**The two things the gate did NOT prove — front-loaded as the early tasks:**
- **U-B1 (Task 1, the real risk): does the RFC-0001 session-key floor work under the weighted sudo?** Cycle 1 issued the session key under a *bare passkey* sudo (`serializePermissionAccount` over `{sudo: passkeyValidator, regular: permissionValidator}`). Under B the sudo is a **weighted validator** — enabling the regular permission validator now requires the weighted sudo's signature (the passkey signer, via the approve flow). `serializePermissionAccount` / `restoreSessionAccount` may or may not handle a weighted sudo. **Prove it before anything else** (it is the "C1-revalidate" the RFC §8 calls for, and the gate is silent on it).
- **U-B2 (Task 3): R2 — Hub-alone (50 < 100) rejected on-chain, paymaster-less.** The gate only ran *successful* quorum ops; the negative (under-threshold rejected on-chain) is the de-risk and must be shown paymaster-less (a sponsored Hub-alone would mask as `sponsor_reject`, per RFC-0001 F1).

---

## File structure

Reused unchanged (Cycle 1): `passkey.ts` (ox), `account.ts` (`webAuthnKeyForPasskey`, `passkeySignMessageCallback`), `env.ts` (`loadConfig`, `guardiansFromConfig`, `makePublicClient`, `sessionFromConfig`, `loadOrCreatePasskey`), `errors.ts`, `observability.ts`.

- **Create `weighted-account.ts`** — the Approach-B owner: `ownerConfig(passkeyWebAuthnKey, hub, backup)` (the `[100,50,50]/100` config), `weightedClientFor({ config, signer, address? })` (createWeightedValidator + createKernelAccount with the recovery fallback + createWeightedKernelAccountClient), `sendWeighted(clients, callData)` (approve each → send-with-signatures), `recoveryCallData(publicClient, newPasskey, hub, backup, rpID)` (the `doRecovery` reset calldata). Consolidates the proven `probe-recovery.ts` logic into reusable functions.
- **Rewrite `recovery.ts`** onto `weighted-account.ts` — drop `@zerodev/weighted-ecdsa-validator` and the A wiring (`GuardianSet`, `buildGuardianValidator`, `createRecoverableAccount`, `recoverOwner`, `buildLostPasskeyValidator`); export the B `recoverOwner` (guardian-quorum config-reset).
- **Modify `harness.ts`** — `issueSessionKeyUnderWeightedSudo({ publicClient, ownerConfig, passkeySigner, sessionSigner, buyList })` (issue the buy-list session key under the weighted sudo) + keep `agentPay` (session key signs — unchanged) + `preflight`.
- **Rewrite `recovery.test.ts`** — C1-revalidate / R1 / R2 / R3 / R4a/b/c on the weighted sudo.
- **`probe-recovery.ts`** — keep as the runnable gate proof (`pnpm recovery:probe`); it is the empirical anchor.
- **Remove** `@zerodev/weighted-ecdsa-validator` from `package.json` once `recovery.ts` no longer imports it.

---

## Task 1 — C1-revalidate: the session-key floor under the weighted sudo (FRONT-LOADED RISK)

**The gate did not touch this; it is the highest remaining risk. Do it first; do not build the rest until it passes (mirrors the Cycle-1 / gate discipline).**

**Files:** Create `weighted-account.ts`; modify `harness.ts`; create the C1-revalidate part of `recovery.test.ts`.

- [x] **Step 1: `weighted-account.ts` — the owner builders (from the proven gate probe)**

```ts
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import {
	createWeightedKernelAccountClient, createWeightedValidator,
	getRecoveryFallbackActionInstallModuleData,
	getValidatorAddress as getWeightedValidatorAddress,
	toECDSASigner, toWebAuthnSigner, type WeightedSigner, WeightedValidatorContractVersion,
} from "@zerodev/weighted-validator";
import { type Address, type Chain, http, type LocalAccount, type PublicClient, type Transport } from "viem";
import { webAuthnKeyForPasskey } from "./account.ts";
import type { SoftwarePasskey } from "./passkey.ts";

export const entryPoint = getEntryPoint("0.7");
export const WV = WeightedValidatorContractVersion.V0_0_2_PATCHED;
export const weightedValidatorAddress = getWeightedValidatorAddress(entryPoint.version, WV);

// biome-ignore lint/suspicious/noExplicitAny: weighted config signer publicKey union is internal.
export type OwnerConfig = { threshold: number; signers: { publicKey: any; weight: number }[] };

/** The Approach-B owner config: passkey 100 / Hub 50 / backup 50, threshold 100. */
export async function ownerConfig(passkey: SoftwarePasskey, rpID: string, hub: Address, backup: Address): Promise<OwnerConfig> {
	const webAuthnKey = await webAuthnKeyForPasskey(passkey, rpID);
	return { threshold: 100, signers: [{ publicKey: webAuthnKey, weight: 100 }, { publicKey: hub, weight: 50 }, { publicKey: backup, weight: 50 }] };
}

/** A weighted-kernel client for one signer on the weighted-sudo account (recovery executor as a fallback). */
export async function weightedClientFor(params: {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly chain: Chain; readonly zerodevRpc: string;
	readonly config: OwnerConfig; readonly signer: WeightedSigner; readonly address?: Address;
}) {
	const validator = await createWeightedValidator(params.publicClient, {
		entryPoint, kernelVersion: KERNEL_V3_1, validatorContractVersion: WV, signer: params.signer, config: params.config,
	});
	const account = await createKernelAccount(params.publicClient, {
		entryPoint, kernelVersion: KERNEL_V3_1,
		...(params.address !== undefined ? { address: params.address } : {}),
		plugins: { sudo: validator },
		pluginMigrations: [getRecoveryFallbackActionInstallModuleData(entryPoint.version)],
	});
	return createWeightedKernelAccountClient({ account, chain: params.chain, bundlerTransport: http(params.zerodevRpc) });
	// NOTE: add a `paymaster` here (createZeroDevPaymasterClient) for sponsored ops; omit for the §9 paymaster-less R2.
}

export const passkeyOwnerSigner = (pc: PublicClient<Transport, Chain>, passkey: SoftwarePasskey, rpID: string) =>
	webAuthnKeyForPasskey(passkey, rpID).then((webAuthnKey) => toWebAuthnSigner(pc, { webAuthnKey }));
export const guardianSigner = (g: LocalAccount) => toECDSASigner({ signer: g });
```
(Add the sponsored paymaster wiring; the gate probe used `createZeroDevPaymasterClient` — reuse it.)

- [x] **Step 2: `harness.ts` — issue the buy-list session key UNDER the weighted sudo**

The owner action: enable a `createBuyListPolicies` permission validator (regular) on the weighted-sudo account. The enable is signed by the **passkey owner signer** (weight 100, alone). Build the permission account `{ sudo: <weighted validator built with the passkey signer>, regular: <permission validator> }` → `serializePermissionAccount` → kawasekit envelope. **This is the unproven part** — if `serializePermissionAccount` rejects a weighted sudo, resolve here (e.g. issue via an explicit `installModule` signed by the passkey-owner weighted client instead of the embedded enable).
```ts
// Sketch — the exact shape is what Task 1 proves:
const sudo = await createWeightedValidator(publicClient, { entryPoint, kernelVersion: KERNEL_V3_1,
	validatorContractVersion: WV, signer: await passkeyOwnerSigner(publicClient, passkey, cfg.rpID), config: ownerCfg });
const permission = await toPermissionValidator(publicClient, { signer: await toECDSASigner({ signer: sessionSigner }),
	policies: [...createBuyListPolicies(...)], entryPoint, kernelVersion: KERNEL_V3_1 });
const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_1,
	plugins: { sudo, regular: permission }, pluginMigrations: [getRecoveryFallbackActionInstallModuleData(entryPoint.version)] });
const serialized = await serializePermissionAccount(account);
return serializeSessionEnvelope({ kawasekitVersion: KAWASEKIT_SESSION_ENVELOPE_VERSION, chainId: AMOY_CHAIN_ID,
	smartAccountAddress: account.address, sessionKeyAddress: sessionSigner.address, serialized, expiresAt: BigInt(buyList.validUntil) });
```
`agentPay` is **unchanged** from Cycle 1 (the session key signs via the permission validator; the weighted sudo is not used on the agent path).

- [x] **Step 3: C1-revalidate test (the gate for the rest of the plan)**

`recovery.test.ts`, integration (live env), the analog of Cycle-1 P2 under the weighted sudo:
- Build the weighted-sudo account (passkey owner signer) at a dedicated persisted passkey; issue a buy-list session key (Step 2); the agent pays the merchant 0.001 JPYC (H1) sponsored — **lands**.
- One §9 paymaster-less negative (e.g. recipient ∉ allowlist) → `validation_reject` (the floor still rejects under the weighted sudo).
- Assert: the session-key floor works under the weighted sudo (issuance + enable + agent pay + on-chain policy rejection).

- [x] **Step 4: Run + STOP for owner review**

`pnpm typecheck:rfc0003` clean; off-chain unit green. The owner runs the live C1-revalidate (needs JPYC + sponsor policy + **~0.1 POL** on the account for the §9 paymaster-less negative — NOT consumed). **If issuance under the weighted sudo fails, STOP** and resolve the issuance path before building R1–R4 — the whole agent floor depends on it.

---

## Task 2 — `recovery.ts` rewritten onto `@zerodev/weighted-validator`

**Files:** Rewrite `recovery.ts`; modify `package.json` (drop `@zerodev/weighted-ecdsa-validator`).

- [x] **Step 1: `recoverOwner` (guardian-quorum config-reset → new passkey) — from the proven gate**

```ts
import { encodeFunctionData, parseAbi } from "viem";
import { createWeightedValidator } from "@zerodev/weighted-validator";
import { entryPoint, WV, weightedValidatorAddress, weightedClientFor, guardianSigner, type OwnerConfig } from "./weighted-account.ts";

const RECOVERY_FN = "function doRecovery(address _validator, bytes calldata _data)" as const;

/** Guardians (Hub+backup = 100) reset the weighted config to `newConfig` (a new passkey). */
export async function recoverOwner(params: {
	readonly publicClient; readonly cfg; readonly currentConfig: OwnerConfig; readonly newConfig: OwnerConfig;
	readonly hub: LocalAccount; readonly backup: LocalAccount; readonly address?: Address; readonly selfPaid?: boolean;
}): Promise<{ transactionHash: Hex | null }> {
	const newWeighted = await createWeightedValidator(params.publicClient, { entryPoint, kernelVersion: KERNEL_V3_1,
		validatorContractVersion: WV, signer: await guardianSigner(params.hub), config: params.newConfig });
	const callData = encodeFunctionData({ abi: parseAbi([RECOVERY_FN]), functionName: "doRecovery",
		args: [weightedValidatorAddress, await newWeighted.getEnableData()] });
	const hubClient = await weightedClientFor({ ...params, config: params.currentConfig, signer: await guardianSigner(params.hub) });
	const backupClient = await weightedClientFor({ ...params, config: params.currentConfig, signer: await guardianSigner(params.backup) });
	const s1 = await hubClient.approveUserOperation({ callData, validatorContractVersion: WV });
	const s2 = await backupClient.approveUserOperation({ callData, validatorContractVersion: WV });
	const hash = await backupClient.sendUserOperationWithSignatures({ callData, signatures: [s1, s2] });
	const r = await backupClient.waitForUserOperationReceipt({ hash });
	return { transactionHash: r.receipt.transactionHash };
}
```
(For R2's paymaster-less Hub-alone, the harness builds the hub client without a paymaster and sends `signatures:[s1]` only — see Task 3.)

- [x] **Step 2: drop the old package**

Remove `@zerodev/weighted-ecdsa-validator` from `package.json` once nothing imports it (`grep -r weighted-ecdsa` returns only the old probe history). `pnpm install`; `pnpm typecheck:rfc0003` clean.

---

## Task 3 — R2: the de-risk (Hub-alone rejected on-chain, paymaster-less)

**Files:** modify `recovery.test.ts`.

- [x] **Step 1: R2 controlled pair — Hub-alone (50 < 100) REVERTED on-chain, paymaster-less; Hub+backup succeeds**

On the **same deployed weighted-sudo account** (so the rejection is purely the threshold), paymaster-less. **The op MUST be a benign, non-rotating owner op — a no-op self-call (`encodeCalls([{ to: account.address, value: 0n, data: "0x" }])`), NOT `doRecovery`.** R2 only needs to exercise the threshold boundary (Hub alone 50 < 100), which *any* owner op shows; using `doRecovery` would config-reset the owner mid-suite, and since R2 (Task 3) runs before R3/R4 (Task 4/5), the positive control's rotation could clobber the R3→R4 chain's on-chain config (if the weighted validator keys by config-hash, `recoverOwner(currentConfig=passkey-A)` would then hash-mismatch → R3 fails). A benign op keeps R2 pure (threshold only) and **mutates no state** (test hygiene; F-1).
- **Negative:** build only the Hub weighted client (no paymaster), `approveUserOperation` once, `sendUserOperationWithSignatures({ callData: noop, signatures: [hubSig] })` → the weighted validator reverts at `validateUserOp` (weight 50 < 100) → `validation_reject`. Assert it threw + the owner config is unchanged.
- **Positive control:** the **same benign no-op** with Hub+backup (`[s1,s2]`) succeeds — attributing the (negative) rejection to the threshold, without rotating the owner.
- Per RFC-0001 §9: run paymaster-less so a sponsored decline can't mask the on-chain boundary as `sponsor_reject`. If the SDK refuses to build an under-threshold signature locally, hand-build the single-partial userOp and submit raw to obtain the on-chain revert (the load-bearing evidence is the **chain** revert).

---

## Task 4 — R3 + R4a (recovery happy path + invariants) — gate-backed, formalize

**Files:** modify `recovery.test.ts`.

- [x] **Step 1: R3 + R4a integration test (mirror the proven probe)**

- **R3:** `recoverOwner({ currentConfig, newConfig: <passkey-B>, hub, backup })` (sponsored) → tx; then a `weightedClientFor` built with **passkey-B's owner signer** at the **same address** (override) signs a no-op alone (weight 100) → the new passkey owns the account; a passkey-A client is rejected.
- **R4a:** the account address is unchanged across recovery (address = f(weighted sudo + initial config)); `jpyc.balanceOf(account)` unchanged (value invariant — recovery moves no JPYC; sponsored so no POL either).

---

## Task 5 — R4b + R4c (re-provision + revoke old, under the new weighted owner)

**Files:** modify `harness.ts` (address override on issuance), `recovery.test.ts`.

- [x] **Step 1: R4b — the NEW passkey owner issues a fresh session key → the agent pays**

After R3, issue a buy-list session key under the **reset** weighted sudo (passkey-B owner signer) bound to the recovered address (address override) → the agent pays. Proves the floor works under the recovered owner.

- [x] **Step 2: R4c — the new owner revokes the OLD session key → rejected on-chain**

Sequence (per the M1 lesson): the old session key must be **enabled (used once) before recovery** to be a live delegation. After recovery, the new owner revokes it. **`revokeSessionKey` needs a SUDO-only client** — under B that is a weighted-sudo client with the passkey-B owner signer at the recovered address (no regular plugin). Match `RevokeSessionKeyParams` (`ownerKernelClient`, `envelope`, `sessionKeySigner`, `policies` = the same `createBuyListPolicies` inputs). Then the old session key is rejected on-chain. **Open sub-risk:** `revokeSessionKey` was written for a single-signer sudo client; confirm it accepts a weighted-kernel client (or do the `uninstallValidation` directly via `sendWeighted` with the passkey-B owner signer). Resolve in this step.

---

## Task 6 — README + scripts + live run + records

**Files:** modify `README.md`, `package.json`.

- [x] **Step 1: README — the Approach-B section**

Owner = weighted validator [passkey 100, Hub 50, backup 50, threshold 100]; recovery = guardian-quorum config-reset; the **honest non-custodial note** (Hub+backup = full owner power, non-custodial via the user-required threshold + O-4 — RFC §6.5); prereqs (the guardian keys; JPYC; sponsor-all gas policy; **~0.1 POL on the account for the paymaster-less negatives — R2 and the C1-revalidate §9 case — as in RFC-0001's "Both" run; NOT consumed, they revert at validation**); a "Live run result" placeholder.

- [x] **Step 2: Live run on Amoy (owner) — record C1-revalidate + R1/R2/R3/R4**

Fund the account (JPYC + **~0.1 POL** for the paymaster-less negatives) + the sponsor-all gas policy, then `pnpm recovery:probe` (the gate, already green) + `pnpm test:rfc0003`. Expected: C1-revalidate green (incl. its §9 paymaster-less negative); R2 Hub-alone reverted paymaster-less; R3/R4(a,b,c) green. Record in README + RFC §8.

- [x] **Step 3: Stage + conventional-commit message (maintainer commits)**

Stage `zerodev-passkey-jpyc/{weighted-account.ts,recovery.ts,harness.ts,recovery.test.ts,probe-recovery.ts,README.md}` + `package.json` + `pnpm-lock.yaml`. Message:
`feat(zerodev-passkey-jpyc): RFC-0003 Cycle 2 Approach B — weighted-validator owner + recovery`

---

## Self-review

**Spec coverage (RFC §8 Cycle 2, Approach B):** C1-revalidate → Task 1. R1 setup (weighted sudo + recovery fallback) → Task 1/Task 2 (gate-proven deploy). R2 (Hub-alone rejected, paymaster-less) → Task 3. R3 (config-reset to new passkey) → Task 4 (gate-proven). R4a (same address / no funds) → Task 4. R4b (re-provision) → Task 5. R4c (revoke old) → Task 5. ✅

**Known unknowns (front-loaded):** **U-B1** — the session-key floor under the weighted sudo (`serializePermissionAccount` over a weighted sudo) is Task 1, the first gate. **U-B2** — `revokeSessionKey` with a weighted-kernel sudo client is Task 5 Step 2 (fallback: direct `uninstallValidation` via `sendWeighted`). The recovery mechanism itself is **gate-proven**, not assumed. No placeholders: the weighted-account helpers + `recoverOwner` are lifted from the proven `probe-recovery.ts`; `pluginMigrations`/`InvalidSelector`, the `[100,50,50]/100` config, and the approve/aggregate flow are all empirically pinned.

**Type consistency:** `OwnerConfig`, `weightedClientFor`, `recoverOwner`, `ownerConfig` share the `WeightedValidatorContractVersion.V0_0_2_PATCHED` + `entryPoint("0.7")` + `KERNEL_V3_1` constants from `weighted-account.ts`; the passkey-owner vs guardian signers via `passkeyOwnerSigner`/`guardianSigner`.

**Sequencing:** Task 1 (C1-revalidate, STOP gate) → Task 2 (recovery.ts) → Task 3 (R2) → Task 4 (R3/R4a) → Task 5 (R4b/c) → Task 6 (docs + live). Tasks 3–5 all edit `recovery.test.ts`; do them in order.
