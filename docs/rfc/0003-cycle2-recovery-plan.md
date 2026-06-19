# RFC-0003 Cycle 2 — Non-Custodial Recovery (R3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Scope:** RFC-0003 **Cycle 2 only** (recovery R3a), built ON the proven Cycle 1 passkey owner (`kawasekit-example/zerodev-passkey-jpyc/`, branch `feat/rfc-0003-cycle2-recovery` off the merged Cycle 1). Cycle 1 (P1+P2) is DONE on Amoy (20/20). This plan does NOT touch the published kawasekit SDK except to consume it.

**Goal:** Prove on Amoy that R3a recovery is **non-custodial** under the passkey owner — **R2 (the step-4 de-risk): a Hub-alone (1-of-2) recovery userOp is rejected on-chain, paymaster-less** — and that the full flow works: R1 setup, R3 2-of-2 rotation (passkey → new passkey), R4a (no funds move / same address), R4b (new owner re-provisions a session key), R4c (new owner revokes the old session key → no stale delegation survives).

**Architecture:** Extend the Cycle 1 harness. The recoverable account = the Cycle-1 passkey-sudo account with a **guardian validator** (`@zerodev/weighted-ecdsa-validator`, guardians `{Hub, user-backup}` weight 1 each, threshold 2) installed as the `regular` plugin plus the `getRecoveryAction` as the `action`. Recovery is a `doRecovery(_validator, _data)` userOp signed by the guardians (NOT the passkey); `_validator` = the passkey-validator module address, `_data` = the **new** passkey's `getEnableData()` blob, so the sudo rotates passkey→passkey. The address is fixed at deploy (`address = f(sudo)` in Kernel v3.1), so recovery changes the root validator, not the address; transacting/revoking as the new owner uses `createKernelAccount`'s `address` override. The Cycle-1 agent floor (P2) is reused verbatim under the recovered owner.

**Tech Stack:** Cycle 1 deps (ox 0.14.29 P256 passkeys, `@zerodev/passkey-validator` 5.6.0, `@zerodev/sdk` 5.5.10, viem 2.50.4) + **`@zerodev/weighted-ecdsa-validator` 5.4.1** (`createWeightedECDSAValidator`, `getRecoveryAction`), `@zerodev/ecdsa-validator` (already installed) for the guardian ECDSA signers.

---

## Spike outcome (resolved during research, 2026-06-19) — the C2 mechanism is pinned

Verified against the installed packages + `zerodevapp/zerodev-examples/guardians/recovery.ts`:

1. **Recovery primitive** — `@zerodev/weighted-ecdsa-validator` 5.4.1: `createWeightedECDSAValidator(publicClient, { entryPoint, kernelVersion, config: { threshold, signers: [{address, weight}…] }, signers: [LocalAccount…] })` (the on-chain weighted set is `config.signers`; the *local* accounts that actually sign now are top-level `signers` — a **subset** signs for R2) + `getRecoveryAction(entryPoint.version)` (the recovery action plugin).
2. **Install shape** — `createKernelAccount(publicClient, { plugins: { sudo: passkeyValidator, regular: guardianValidator, action: getRecoveryAction("0.7") }, entryPoint, kernelVersion: KERNEL_V3_1 })`.
3. **Rotate-call argument** — `doRecovery(address _validator, bytes _data)`: `_validator` = `getValidatorAddress(entryPoint, KERNEL_V3_1, PasskeyValidatorContractVersion.V0_0_3_PATCHED)` (exported by `@zerodev/passkey-validator`), `_data` = `await newPasskeyValidator.getEnableData()`. **`getEnableData()` is the verified-correct `_data` source** — the installed `@zerodev/ecdsa-validator` `getEnableData()` returns the bare `signer.address`, which is exactly what ZeroDev's recovery example passes as `_data`, so the passkey analog (the `{x,y}` + `authenticatorIdHash` blob, confirmed in the passkey-validator dist) is the right generalization. **Whether the on-chain recovery executor re-initializes the PASSKEY validator with this blob (vs reverting on re-init) is NOT verified — ZeroDev's example only showed ECDSA→ECDSA → see U4.**
4. **Address invariant** — Kernel v3.1 counterfactual address depends ONLY on the sudo validator (confirmed in kawasekit `src/session/revoke.ts` JSDoc). Recovery changes the root validator; the deployed address is unchanged (R4a). Transacting/revoking as the new owner uses `createKernelAccount({ …, address: recoveredAddress })` (the `address?: Address` override, confirmed in the installed `@zerodev/sdk` `createKernelAccount` params).

**Residual unknowns the foundation spike (Task 1) MUST resolve empirically — "I don't know yet" until the probe runs:**
- **U1 (the crux): can `doRecovery` be authorized by the guardians WITHOUT the passkey signature?** A `regular` validator normally needs the `sudo` to co-sign its *enable* on first use — but at recovery time the passkey is "lost." Two viable designs: (a) the deploy initData installs the guardian+action so the first guardian-signed `doRecovery` deploys + acts with **no** passkey sig; (b) the guardian is **pre-enabled at R1 while the passkey still works** (an explicit passkey-signed install), then recovery at R3 needs no passkey. **The probe must PROVE independence, not just "it rotated": build the recoverable account with a passkey sudo whose `signMessageCallback` THROWS ("lost"), and require `doRecovery` (guardians only) to still succeed.** If the SDK reaches for the passkey, the throwing callback surfaces it immediately. If neither (a) nor (b) lets recovery proceed with the passkey provably disabled, the R3a design is broken → **STOP and report** (the legitimate "spike says no").
- **U2: co-located 2-of-2 aggregation.** Does passing `signers: [hub, backup]` auto-produce one combined 2-of-2 signature, or is the distributed `approveUserOperation` flow required? (In the harness both keys are local, so auto-aggregation is expected.)
- **U3 (R2 mechanics): does an under-threshold (Hub-alone) signature SUBMIT and get rejected on-chain (paymaster-less `validation_reject`)**, or does the SDK block it locally before submission? R2 wants the on-chain rejection (the immutable boundary); if the SDK blocks locally, document that as the boundary and still assert no rotation occurred. (R2 must run against an **already-enabled, deployed** guardian — see Task 3 — so the rejection is purely weight 1 < 2, not a missing enable.)
- **U4: does the recovery executor re-initialize the PASSKEY validator on-chain?** `getEnableData()` is the correct `_data` (verified via the ECDSA analog), but ZeroDev's example only rotated ECDSA→ECDSA. The passkey validator's on-chain `onInstall`/enable may revert if re-applied to an already-deployed account. Resolved by R3 in the probe; if it reverts, report the exact error before proceeding.
- **U5 (least-authority precision, F3): is the guardian validator scoped to the `doRecovery` action only, or can the 2-of-2 guardians authorize ANY userOp (e.g., a transfer)?** Either way R3a stays non-custodial (Hub alone is weight 1 < threshold; the 2-of-2 necessarily includes the user, so no new seizure surface). But the precise claim differs — doRecovery-only = "guardians can recover but not spend" (strongest story); unscoped = "the 2-of-2 holds more than recovery authority". The probe (Task 1 Step 5b) tries one non-`doRecovery` 2-of-2 userOp and the result is stated accurately in RFC §6.5 — do not over-claim.

---

## File structure

Reused from Cycle 1 **unchanged**: `passkey.ts`, `env.ts` core (`loadConfig`, `makePublicClient`, `assertJpycOnChain`, `sessionFromConfig`, `loadOrCreatePasskey`), `errors.ts`, `observability.ts`, `harness.ts` reused (`agentPay`, `buildBuyList`, `buildSelfPaidKernelClient`, `buildSponsoredKernelClient`, `preflight`).

- **Modify `account.ts`** — add `buildLostPasskeyValidator` (same as `buildPasskeyValidator` but the `signMessageCallback` THROWS), so the probe/R3 can build the recoverable account's sudo with the passkey **provably disabled** — the C1 passkey-independence proof.
- **Create `recovery.ts`** — the recovery wiring: `buildGuardianValidator`, `createRecoverableAccount`, `buildDoRecoveryCallData`, `recoverOwner`, `bindNewOwnerAccount`.
- **Modify `env.ts`** — add `hubGuardianKey` + `userBackupKey` to `RfcConfig` + loadConfig; add `guardiansFromConfig(cfg)`; add a second persisted passkey loader for the post-recovery passkey (`loadOrCreatePasskey` is reusable with a different file URL).
- **Modify `harness.ts`** — give `issuePasskeyScopedSessionKey` (and `preflight`) an optional `address?: Address` override so a session key can be issued on the *recovered* account under the new passkey (R4b).
- **Create `probe-recovery.ts`** — the runnable foundation spike (R1 setup → R3 2-of-2 rotation → new passkey transacts → old rejected). `pnpm recovery:probe`.
- **Create `recovery.test.ts`** — R1/R2/R3/R4a/R4b/R4c acceptance (unit always; integration gated on the live env, like Cycle 1).
- **Modify `package.json`** — add `recovery:probe` script; add `@zerodev/weighted-ecdsa-validator` dep.
- **Modify `README.md`** — add the Cycle 2 section (guardians, the R2 de-risk, prereqs, the non-custodial argument).
- **Modify the repo-root `.env.example`** — add `HUB_GUARDIAN_PRIVATE_KEY` + `USER_BACKUP_PRIVATE_KEY`.
- **Modify `.gitignore`** — add `zerodev-passkey-jpyc/.passkey-recovered.json` (the post-recovery passkey).

---

## Task 1 — Foundation spike: install + the recovery primitive (R1 setup + R3 rotation) via a probe

**This is the highest-risk task — it resolves U1/U2 + the passkey rotation on-chain. Do it first; do not write the test suite (Task 2+) until the probe passes (mirrors Cycle 1's P1).**

**Files:**
- Modify: `kawasekit-example/package.json`
- Modify: `kawasekit-example/zerodev-passkey-jpyc/env.ts`
- Create: `kawasekit-example/zerodev-passkey-jpyc/recovery.ts`
- Create: `kawasekit-example/zerodev-passkey-jpyc/probe-recovery.ts`
- Modify: `kawasekit-example/.gitignore`, repo-root `.env.example`

- [ ] **Step 1: Install the guardian/recovery package (pinned, supply-chain aware)**

Run (from `kawasekit-example/`):
```sh
pnpm add @zerodev/weighted-ecdsa-validator@5.4.1
```
`5.4.1` was published ~2 months ago, so pnpm's `minimumReleaseAge` (1 day) does not block it. Expected: it resolves against the installed `@zerodev/sdk` 5.5.x line. Verify the two exports exist (the Cycle-1 F2 symbol-pin gate — do NOT proceed if either is missing):
```sh
node -e 'const w=require("@zerodev/weighted-ecdsa-validator"); console.log(typeof w.createWeightedECDSAValidator, typeof w.getRecoveryAction)'
```
Expected: `function function`. (The `config.signers` vs top-level `signers` split and the `getRecoveryAction` arity stay U2-flagged until the probe builds a real validator.)

- [ ] **Step 2: Add guardian config to `env.ts`**

Add two required hex keys to `RfcConfig` and a `guardiansFromConfig` helper. In `env.ts`, extend the interface and `loadConfig` return:
```ts
// in RfcConfig:
	/** Hub recovery guardian (ECDSA, weight 1). */
	readonly hubGuardianKey: Hex;
	/** User backup recovery guardian (ECDSA, weight 1). */
	readonly userBackupKey: Hex;
```
```ts
// in loadConfig()'s returned object:
		hubGuardianKey: requiredHex32("HUB_GUARDIAN_PRIVATE_KEY"),
		userBackupKey: requiredHex32("USER_BACKUP_PRIVATE_KEY"),
```
Add the helper (after `sessionFromConfig`):
```ts
/** The two ECDSA recovery guardians (Hub + user backup). Each gets weight 1; threshold 2. */
export function guardiansFromConfig(cfg: RfcConfig): {
	readonly hub: ReturnType<typeof privateKeyToAccount>;
	readonly userBackup: ReturnType<typeof privateKeyToAccount>;
} {
	return { hub: privateKeyToAccount(cfg.hubGuardianKey), userBackup: privateKeyToAccount(cfg.userBackupKey) };
}
```

- [ ] **Step 3: Write `recovery.ts` — the recovery wiring**

```ts
/**
 * RFC-0003 Cycle 2 — R3a non-custodial recovery wiring (ZeroDev).
 *
 * The recoverable account = the Cycle-1 passkey-sudo account with a weighted
 * guardian validator (regular) + the recovery action installed. Recovery is a
 * `doRecovery(_validator, _data)` userOp signed by the GUARDIANS (not the passkey):
 * `_validator` = the passkey-validator module address, `_data` = the NEW passkey's
 * getEnableData() → the sudo rotates passkey→passkey. Guardians = {Hub, user backup},
 * weight 1 each, threshold 2 → neither alone can rotate (the non-custodial proof).
 */
import { getValidatorAddress as getPasskeyValidatorAddress, PasskeyValidatorContractVersion } from "@zerodev/passkey-validator";
import { type CreateKernelAccountReturnType, createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createWeightedECDSAValidator, getRecoveryAction } from "@zerodev/weighted-ecdsa-validator";
import { type Address, type Chain, encodeFunctionData, type Hex, type LocalAccount, parseAbi, type PublicClient, type Transport } from "viem";
import { buildLostPasskeyValidator, buildPasskeyValidator } from "./account.ts";
import type { SoftwarePasskey } from "./passkey.ts";

const entryPoint = getEntryPoint("0.7");

/** The doRecovery executor (verbatim from ZeroDev's guardians/recovery.ts example). */
const RECOVERY_EXECUTOR_FN = "function doRecovery(address _validator, bytes calldata _data)" as const;

/**
 * Build the weighted guardian validator. `config` is the ON-CHAIN weighted set
 * (Hub + user backup, weight 1 each, threshold 2). `signers` is which LOCAL accounts
 * actually sign NOW — pass both for a valid 2-of-2 (R3), or a single guardian to build
 * an under-threshold signature (R2).
 */
export async function buildGuardianValidator(
	publicClient: PublicClient<Transport, Chain>,
	params: { readonly hub: Address; readonly userBackup: Address; readonly signers: readonly LocalAccount[] },
) {
	return createWeightedECDSAValidator(publicClient, {
		entryPoint,
		kernelVersion: KERNEL_V3_1,
		config: {
			threshold: 2,
			signers: [
				{ address: params.hub, weight: 1 },
				{ address: params.userBackup, weight: 1 },
			],
		},
		signers: [...params.signers],
	});
}

/**
 * The recoverable account: sudo = the passkey, regular = the guardian validator,
 * action = the recovery action. `signers` selects who co-signs a recovery userOp
 * built from this account.
 */
export async function createRecoverableAccount(params: {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly passkey: SoftwarePasskey;
	readonly rpID: string;
	readonly hub: Address;
	readonly userBackup: Address;
	readonly signers: readonly LocalAccount[];
	/** Build the sudo with a THROWING passkey signer (recovery must not use the "lost" key). */
	readonly lostPasskey?: boolean;
}): Promise<CreateKernelAccountReturnType<"0.7">> {
	const sudo = params.lostPasskey
		? await buildLostPasskeyValidator(params.publicClient, params.passkey, params.rpID)
		: await buildPasskeyValidator(params.publicClient, params.passkey, params.rpID);
	const guardian = await buildGuardianValidator(params.publicClient, {
		hub: params.hub,
		userBackup: params.userBackup,
		signers: params.signers,
	});
	return createKernelAccount(params.publicClient, {
		entryPoint,
		kernelVersion: KERNEL_V3_1,
		plugins: { sudo, regular: guardian, action: getRecoveryAction(entryPoint.version) },
	});
}

/** Build the doRecovery callData that rotates the sudo to a NEW passkey. */
export async function buildDoRecoveryCallData(
	publicClient: PublicClient<Transport, Chain>,
	newPasskey: SoftwarePasskey,
	rpID: string,
): Promise<Hex> {
	const passkeyValidatorAddress = getPasskeyValidatorAddress(entryPoint, KERNEL_V3_1, PasskeyValidatorContractVersion.V0_0_3_PATCHED);
	const newValidator = await buildPasskeyValidator(publicClient, newPasskey, rpID);
	const newEnableData = await newValidator.getEnableData();
	return encodeFunctionData({
		abi: parseAbi([RECOVERY_EXECUTOR_FN]),
		functionName: "doRecovery",
		args: [passkeyValidatorAddress, newEnableData],
	});
}
```

- [ ] **Step 3b: Add `buildLostPasskeyValidator` to `account.ts` (the C1 passkey-independence proof)**

Same as `buildPasskeyValidator` but the `signMessageCallback` THROWS — so a recoverable account can be built with its passkey sudo **provably unable to sign**. If the SDK reaches for the passkey at recovery time, this throws immediately (surfacing the dependency); if recovery proceeds, it is provably passkey-independent. Address derivation only needs the public key, so the account address is identical to the live-passkey one.
```ts
/** A passkey validator whose signer THROWS — for proving recovery never uses the "lost" passkey. */
export async function buildLostPasskeyValidator(
	publicClient: PublicClient<Transport, Chain>,
	passkey: SoftwarePasskey,
	rpID: string,
) {
	const entryPoint = getEntryPoint("0.7");
	const authenticatorIdHash = keccak256(uint8ArrayToHexString(b64ToBytes(passkey.id)));
	const webAuthnKey = await toWebAuthnKey({
		webAuthnKey: {
			pubX: passkey.publicKey.x,
			pubY: passkey.publicKey.y,
			authenticatorId: passkey.id,
			authenticatorIdHash,
			rpID,
			signMessageCallback: () => {
				throw new Error("passkey lost — recovery MUST NOT use the owner key");
			},
		},
		rpID,
		mode: WebAuthnMode.Login,
	});
	return toPasskeyValidator(publicClient, {
		webAuthnKey,
		entryPoint,
		kernelVersion: KERNEL_V3_1,
		validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
	});
}
```
Give `createRecoverableAccount` (recovery.ts) a `lostPasskey?: boolean` flag that selects `buildLostPasskeyValidator` over `buildPasskeyValidator` for the sudo.

- [ ] **Step 4: Write `probe-recovery.ts` — the runnable foundation spike (R1 + R3)**

The probe must **prove passkey-independence**, not just "it rotated": the recoverable account's sudo uses the **throwing** passkey validator (`lostPasskey: true`), so a successful `doRecovery` proves the guardians acted without the owner. Primary attempt = the deploy-time-install path (U1 (a)); if it throws on the passkey callback, fall back to the R1 pre-enable path (Step 5). R1/R3 run **sponsored** (Cycle-1 pattern; paymaster-less is reserved for R2).

> **Write `recoverOwner` + `bindNewOwnerAccount` now** — the probe imports both. `recovery.ts` is one file, so add all five functions (`buildGuardianValidator`, `createRecoverableAccount`, `buildDoRecoveryCallData`, `recoverOwner`, `bindNewOwnerAccount`) in this task; their bodies are in Task 2 Step 1.

```ts
/**
 * RFC-0003 Cycle 2 foundation spike (R1 + R3). Reads repo-root `.env`.
 *
 *   pnpm recovery:probe
 *
 * R3 (passkey "LOST"): build the recoverable account with a THROWING passkey sudo
 *     (lostPasskey:true) + both guardians; send doRecovery (2-of-2). If it succeeds,
 *     recovery is PROVEN independent of the passkey (U1) and the executor re-inits the
 *     passkey validator on-chain (U4). Then bind the NEW passkey at the SAME address and
 *     prove it controls the account; the OLD passkey is rejected.
 */
import "dotenv/config";

import { polygonAmoy, transferJpyc, zerodevRpcUrl } from "kawasekit";
import { parseUnits } from "viem";
import { assertJpycOnChain, guardiansFromConfig, loadConfig, loadOrCreatePasskey, makePublicClient } from "./env.ts";
import { bindNewOwnerAccount, createRecoverableAccount, recoverOwner } from "./recovery.ts";
import { createSoftwarePasskey } from "./passkey.ts";
import { buildSponsoredKernelClient } from "./harness.ts";

const PASSKEY_FILE = new URL(".passkey-cycle1.json", import.meta.url);

async function main(): Promise<void> {
	const cfg = loadConfig();
	const publicClient = makePublicClient(cfg);
	await assertJpycOnChain(publicClient, cfg);
	const passkey = loadOrCreatePasskey(PASSKEY_FILE);
	const { hub, userBackup } = guardiansFromConfig(cfg);

	// Address preview (throwing sudo derives the same address — public key only).
	const preview = await createRecoverableAccount({
		publicClient, passkey, rpID: cfg.rpID, hub: hub.address, userBackup: userBackup.address,
		signers: [hub, userBackup], lostPasskey: true,
	});
	console.log(`RFC-0003 Cycle 2 probe — recoverable account: ${preview.address}`);

	// R3 — rotate to a fresh passkey, signed by BOTH guardians, passkey PROVABLY disabled.
	const newPasskey = createSoftwarePasskey();
	const { transactionHash } = await recoverOwner({
		publicClient, cfg, passkey, hub: hub.address, userBackup: userBackup.address,
		signers: [hub, userBackup], newPasskey, lostPasskey: true, // sponsored inside recoverOwner
	});
	console.log(`R3 doRecovery tx: ${transactionHash} (passkey signer was disabled — guardians only)`);

	// Prove the NEW owner controls the account at the SAME address.
	const newOwner = await bindNewOwnerAccount({ publicClient, newPasskey, rpID: cfg.rpID, address: preview.address });
	const client = buildSponsoredKernelClient({ account: newOwner, cfg });
	const res = await transferJpyc(client, { to: cfg.merchant, amount: parseUnits("0.001", cfg.jpycDecimals) });
	console.log(`new-owner transfer success=${res.success} tx=${res.transactionHash}`);
	console.log("✅ R1+R3 PASS — guardians rotated the passkey sudo with the passkey provably disabled");
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
	process.exit(1);
});
```
(Give `recoverOwner` a `lostPasskey?: boolean` and a `newPasskey` param — see Task 2 Step 1; default the probe to **sponsored** by building the client via `buildSponsoredKernelClient` inside `recoverOwner` unless `selfPaid` is set.)

- [ ] **Step 5: Resolve U1 + U4 — run the probe; the throwing passkey makes the result honest**

Run (owner, live env + a sponsor-all gas policy so R3 needs no account POL):
```sh
pnpm recovery:probe
```
**Outcomes:**
- **(a) deploy-time install (best):** the guardian-signed `doRecovery` deploys + rotates in one userOp; the throwing passkey is never invoked → **U1 + U4 resolved, recovery is passkey-independent.** Done.
- **(b) enable-on-first-use:** the probe throws from the passkey callback (the SDK tried to produce the sudo enable signature). Then add an **R1 pre-enable step** — while the passkey WORKS, send a passkey-signed userOp that explicitly installs/enables the guardian validator + recovery action (an `installModule` / first benign guardian op), THEN rerun R3 with `lostPasskey: true`. If it now succeeds, recovery is passkey-independent **after a setup performed while the key was available** (the realistic R3a model). Record which path held + the doRecovery tx.
- **(c) neither works** (R3 still needs the passkey even after a pre-enable, or the executor reverts re-initializing the passkey validator → U4 fails): **STOP and report.** That breaks the R3a non-custodial premise — do not build the rest of Cycle 2 on a false foundation. **Next directions to try before declaring dead-end (F4, probe-result-gated, speculative):** if the revert is specifically the passkey validator rejecting *re-install of the same module*, rotate instead to a **fresh passkey-validator instance** (a different validator address / `validatorAddress` override) rather than re-`onInstall`-ing the same one; or check whether `@zerodev/passkey-validator` exposes a dedicated **change-pubkey / update** path (distinct from `onInstall`) that the recovery executor can target. Pick after seeing the actual revert reason.

- [ ] **Step 5b: Resolve U5 (least-authority scope, F3) — can the 2-of-2 guardians do more than recover?**

In the same probe run, try ONCE to send a **non-`doRecovery`** userOp (e.g. a 0.001 JPYC `transfer`) signed by the 2-of-2 guardians from the recoverable account, and record the result:
- **rejected** → the guardian validator is **scoped to the `doRecovery` action only** = "guardians can recover but not spend" (the strongest non-custodial story). Note it in RFC §6.5.
- **accepted** → the 2-of-2 guardians can authorize arbitrary userOps. R3a is **still non-custodial** (Hub alone is weight 1 < threshold so cannot act; the 2-of-2 necessarily includes the user, so it is no new seizure surface), but RFC §6.5 must state precisely that the guardian set holds *more than recovery* authority. Record it; do not over-claim "recover but not spend".

- [ ] **Step 6: Add the gitignore + `.env.example` entries**

`.gitignore` (append): `zerodev-passkey-jpyc/.passkey-recovered.json` and `zerodev-passkey-jpyc/.passkey-r2.json` (the dedicated R2 account's passkey — F2 isolation)
Repo-root `.env.example` (append, with testnet-only comments):
```
# RFC-0003 Cycle 2 recovery guardians (testnet ECDSA keys, never value-bearing)
HUB_GUARDIAN_PRIVATE_KEY=0x...
USER_BACKUP_PRIVATE_KEY=0x...
```

- [ ] **Step 7: Record the probe result + STOP for owner review**

The probe's on-chain tx hash + which U1 path held = the Cycle-2 foundation DoD. Record it (analog of Cycle 1's P1 tx). Do not commit (maintainer commits). Confirm with the owner before writing the test suite.

---

## Task 2 — `recovery.test.ts`: R1 + R3 + R4a (formalize the probe; happy rotation + invariants)

**Files:**
- Create: `kawasekit-example/zerodev-passkey-jpyc/recovery.test.ts`
- (`recovery.ts` `recoverOwner` + `bindNewOwnerAccount` were written in Task 1 — the probe needs them; their bodies are shown here.)

- [ ] **Step 1: `recoverOwner` + `bindNewOwnerAccount` (written in Task 1; shown here for reference)**

```ts
/**
 * Send the doRecovery userOp from the recoverable account, signed by `signers`.
 * Pass both guardians for a valid 2-of-2 (R3); pass one for an under-threshold
 * attempt (R2). `lostPasskey` builds the sudo with a throwing passkey (proves the
 * recovery never uses the owner key). `selfPaid` runs paymaster-LESS (R2's on-chain
 * boundary, RFC §9); default = sponsored (R1/R3, the Cycle-1 pattern, no account POL).
 */
export async function recoverOwner(params: {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly cfg: RfcConfig;
	readonly passkey: SoftwarePasskey;
	readonly hub: Address;
	readonly userBackup: Address;
	readonly signers: readonly LocalAccount[];
	readonly newPasskey: SoftwarePasskey;
	readonly lostPasskey?: boolean;
	readonly selfPaid?: boolean;
}): Promise<{ readonly transactionHash: Hex | null }> {
	const account = await createRecoverableAccount({
		publicClient: params.publicClient, passkey: params.passkey, rpID: params.cfg.rpID,
		hub: params.hub, userBackup: params.userBackup, signers: params.signers,
		lostPasskey: params.lostPasskey,
	});
	const client = params.selfPaid
		? buildSelfPaidKernelClient({ account, cfg: params.cfg })
		: buildSponsoredKernelClient({ account, cfg: params.cfg });
	const callData = await buildDoRecoveryCallData(params.publicClient, params.newPasskey, params.cfg.rpID);
	const hash = await client.sendUserOperation({ callData });
	const receipt = await client.waitForUserOperationReceipt({ hash });
	return { transactionHash: receipt.receipt.transactionHash };
}
```
(Import `RfcConfig` from `./env.ts` and `buildSponsoredKernelClient`/`buildSelfPaidKernelClient` from `./harness.ts` at the top of `recovery.ts`.) `bindNewOwnerAccount` binds to the recovered address with the new passkey sudo:
```ts
/** Build a kernel account at the EXISTING recovered address, owned by the new passkey. */
export async function bindNewOwnerAccount(params: {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly newPasskey: SoftwarePasskey;
	readonly rpID: string;
	readonly address: Address;
}): Promise<CreateKernelAccountReturnType<"0.7">> {
	const sudo = await buildPasskeyValidator(params.publicClient, params.newPasskey, params.rpID);
	return createKernelAccount(params.publicClient, {
		entryPoint, kernelVersion: KERNEL_V3_1, address: params.address, plugins: { sudo },
	});
}
```

- [ ] **Step 2: Write the unit half of `recovery.test.ts` (always-run; no chain)**

```ts
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { polygonAmoy } from "kawasekit";
import { describe, expect, it } from "vitest";
import { buildDoRecoveryCallData } from "./recovery.ts";
import { createSoftwarePasskey } from "./passkey.ts";

describe("RFC-0003 Cycle 2 unit (no chain)", () => {
	it("buildDoRecoveryCallData encodes doRecovery(passkeyValidator, newEnableData)", async () => {
		// A REAL public client — but doRecovery encoding (getValidatorAddress + getEnableData) is
		// OFFLINE; no RPC call is made, so the test is deterministic with no network.
		const publicClient = createPublicClient({ chain: polygonAmoy, transport: http() });
		const callData = await buildDoRecoveryCallData(publicClient, createSoftwarePasskey(), "kawasekit.local");
		// selector of doRecovery(address,bytes) — pinned in Step 3
		expect(callData.slice(0, 10)).toBe("0x0c7ac7b6"); // VERIFY in Step 3 and replace with the real selector
		expect(callData.length).toBeGreaterThan(200); // address + dynamic bytes (the webAuthn blob)
	});
});
```
If `getValidatorAddress`/`getEnableData` turn out to make any RPC call (they should not — pure encoding), gate this case as integration instead. Verify by running it with no network reachable.

- [ ] **Step 3: Pin the real `doRecovery` selector**

Run a one-liner to compute the selector and replace the placeholder in Step 2:
```sh
node -e 'const {toFunctionSelector}=require("viem"); console.log(toFunctionSelector("doRecovery(address,bytes)"))'
```
Put the printed value into the `expect(callData.slice(0,10)).toBe(...)` assertion. Run `pnpm test:rfc0003 -t "Cycle 2 unit"` → PASS.

- [ ] **Step 4: Write the integration half — R3 (happy rotation) + R4a (invariants)**

Gated `describe.skipIf(!LIVE)` (LIVE = the Cycle-1 var set + `HUB_GUARDIAN_PRIVATE_KEY` + `USER_BACKUP_PRIVATE_KEY`). The new passkey is persisted to `.passkey-recovered.json` so the test is re-runnable. Assertions:
- **R3 (passkey provably disabled):** `recoverOwner({ signers: [hub, userBackup], newPasskey, lostPasskey: true })` (sponsored) returns a tx hash — proving the guardians rotated the sudo with the passkey signer throwing; then `bindNewOwnerAccount` + a sponsored `transferJpyc` of 0.001 JPYC succeeds (new owner controls the account); a transfer built from the OLD passkey account at the same address (`createPasskeyAccount` + `address` override, real callback) **throws** (old owner rejected).
- **R4a (value invariant, scoped to JPYC):** the recoverable account address before recovery `===` the bound-new-owner address after (address = f(sudo) is fixed at deploy). Assert **`jpyc.balanceOf(account)` is unchanged** across the recovery userOp — recovery moves **no value (JPYC)**. Gas is consumed only as POL, and R3 runs **sponsored**, so neither JPYC nor the account's POL is spent on the rotation.

Use the Cycle-1 `balanceOf` helper pattern + `createSponsoredKernelClient`. Timeout 180_000 per case.

- [ ] **Step 5: Run + commit-point**

`pnpm typecheck:rfc0003` clean; `pnpm test:rfc0003 -t "Cycle 2 unit"` PASS (integration auto-skips off-live). Do not commit. Owner runs the live R3/R4a.

---

## Task 3 — R2: the de-risk (Hub-alone recovery rejected on-chain, paymaster-less)

**Files:** Modify: `recovery.test.ts`

**Prerequisite (H2 + F2 — DEDICATED account, NOT the R3→R4 chain's): R2 MUST run on its own recoverable account** (its own original passkey, persisted to `.passkey-r2.json`, + the same guardians), deployed + guardian-enabled in a `beforeAll`. **Why a dedicated account (the F2 state bug):** R2's positive control rotates *its* account's owner; if R2 shared the R3→R4 chain's account, that rotation would overwrite R3's `newPasskey` owner (to `hubAloneTargetPasskey`), and the later **R4b/R4c — which build userOps under `newPasskey` — would run against a stale on-chain owner and fail**. Vitest runs in definition order (R3→R2→R4), so a shared account is silently corrupted. A dedicated account fully isolates R2's rotations from the R3→R4 chain, and (H2) being pre-deployed + guardian-enabled makes the hub-only rejection purely weight 1 < 2.

- [ ] **Step 1: Write R2 as a CONTROLLED PAIR on the dedicated account — Hub-alone REVERTED ON-CHAIN, Hub+backup rotates**

```ts
const R2_PASSKEY_FILE = new URL(".passkey-r2.json", import.meta.url);
// In a beforeAll: r2Passkey = loadOrCreatePasskey(R2_PASSKEY_FILE); deploy r2's recoverable account
// + enable its guardian (per U1's resolved path) so the hub-only op below fails ONLY on the threshold.

it("R2: Hub-ALONE (1-of-2) is REVERTED ON-CHAIN paymaster-less; Hub+backup (2-of-2) rotates (THE de-risk)", async () => {
	const r2Account = await createRecoverableAccount({ publicClient, passkey: r2Passkey, rpID: cfg.rpID,
		hub: hub.address, userBackup: userBackup.address, signers: [hub, userBackup], lostPasskey: true });
	const before = await ownerIdentifier(r2Account.address); // current on-chain root validator config

	// (a) NEGATIVE — only the Hub signs. THE LOAD-BEARING EVIDENCE IS AN ON-CHAIN REVERT (the analog
	//     of Cycle 1's paymaster-less validation_reject), NOT "the SDK refused to sign" — see Step 2.
	let threw = false;
	try {
		await recoverOwner({
			publicClient, cfg, passkey: r2Passkey, hub: hub.address, userBackup: userBackup.address,
			signers: [hub], newPasskey: hubAloneTargetPasskey, lostPasskey: true, selfPaid: true, // paymaster-less
		});
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);                                       // recovery did NOT succeed
	expect(await ownerIdentifier(r2Account.address)).toBe(before);  // owner UNCHANGED (no rotation)

	// (b) POSITIVE control — the SAME op with BOTH guardians rotates, attributing (a) to the threshold.
	const ok = await recoverOwner({
		publicClient, cfg, passkey: r2Passkey, hub: hub.address, userBackup: userBackup.address,
		signers: [hub, userBackup], newPasskey: hubAloneTargetPasskey, lostPasskey: true,
	});
	expect(ok.transactionHash).not.toBeNull();
}, 300_000);
```

- [ ] **Step 2: U3 — the Hub-alone rejection MUST be ON-CHAIN (F1: a local SDK block does NOT satisfy R2)**

R2 is the Cycle-2 de-risk and must reach the **same caliber as Cycle 1's paymaster-less `validation_reject`**: the load-bearing evidence is that **the chain reverts the under-threshold userOp**, not that the SDK declined to build it. "The SDK won't sign a 1-of-2" is client-side kindness, not chain enforcement, and does not reach RFC §8 R2's caliber. Run the live R2 (owner), paymaster-less:
- **If `recoverOwner` submits the hub-only userOp and the bundler/EntryPoint reverts at `validateUserOp` (weight 1 < 2) → DONE.** Record the on-chain revert (the immutable, paymaster-independent boundary).
- **If the SDK refuses to build the under-threshold signature locally → REQUIRED follow-through (not optional):** hand-construct the single-guardian userOp — sign the userOpHash with the Hub key only, assemble the weighted-validator signature with one partial — and submit it **raw** (prepared userOp via the bundler / EntryPoint `handleOps`) to obtain the actual on-chain `validation_reject`. **Only an on-chain revert closes R2.** Record the revert reason + tx.

The controlled pair (hub-only does not rotate / hub+backup does) stays as the attribution control, but the headline proof of R2 is the **on-chain revert of the under-threshold op**.

---

## Task 4 — R4b + R4c (new owner re-provisions; old session key revoked)

**Files:**
- Modify: `kawasekit-example/zerodev-passkey-jpyc/harness.ts` (address override on `issuePasskeyScopedSessionKey`)
- Modify: `recovery.test.ts`

- [ ] **Step 1: Add an `address` override to `issuePasskeyScopedSessionKey` (and `preflight`)**

So a session key can be issued on the *recovered* account (same address, new passkey sudo). In `harness.ts`, add `readonly address?: Address;` to the `issuePasskeyScopedSessionKey` params and pass it through to `createKernelAccount`:
```ts
	const account = await createKernelAccount(publicClient, {
		plugins: { sudo: sudoValidator, regular: permissionValidator },
		entryPoint,
		kernelVersion: KERNEL_V3_1,
		...(params.address !== undefined ? { address: params.address } : {}),
	});
```
(omitted ⇒ byte-identical to Cycle 1 — backward compatible.)

- [ ] **Step 2: Write R4b — the new owner issues a fresh session key → the agent pays**

In the integration `describe`, after R3 has rotated to `newPasskey`:
```ts
it("R4b: the NEW passkey owner issues a fresh session key → the agent pays (floor under new owner)", async () => {
	const approval = await issuePasskeyScopedSessionKey({
		cfg, publicClient, passkey: newPasskey, sessionSigner: session,
		buyList: buildBuyList(cfg), address: recoveredAddress,
	});
	const out = await agentPay({ cfg, publicClient, serializedApproval: approval, sessionSigner: session,
		to: cfg.merchant, amount: parseUnits("0.001", cfg.jpycDecimals),
		identity: { conversationId: "rfc-0003-r4b", stepId: "pay-1" }, cache: new Map() });
	expect(out.result.success).toBe(true);
}, 180_000);
```

- [ ] **Step 3: Write R4c — the new owner revokes the OLD session key → it is rejected on-chain**

**Sequencing (M1) — R4c only proves something if the old key was a LIVE delegation:** a never-used session key is enabled lazily by an enable signature from the OLD root, which becomes invalid after rotation — so it dies automatically and revoking it proves nothing. The faithful sequence is: **(1)** issue the old session key under the ORIGINAL passkey and **use it once** (so it is enabled on-chain) — do this BEFORE recovery; **(2)** recover (rotate to `newPasskey`); **(3)** optionally show the old key STILL works post-rotation (the stale-delegation risk is real — regular validators persist across a root rotation); **(4)** the new owner revokes it; **(5)** the old key is now rejected.

**The `revokeSessionKey` call MUST match `RevokeSessionKeyParams` (`kawasekit/src/session/revoke.ts:37`)** — it requires `ownerKernelClient` (a **SUDO-ONLY** client — no `regular` plugin), `envelope`, `sessionKeySigner` (the old session `LocalAccount`), and **`policies`** (the EXACT array from issue time — `createBuyListPolicies` with the same `buildBuyList(cfg)` inputs; a mismatch reverts at validation). Not `sudoClient`/`envelope`-only.
```ts
import { createBuyListPolicies, parseSessionEnvelope, revokeSessionKey } from "kawasekit";

it("R4c: the new owner revokes the OLD session key → no stale delegation survives", async () => {
	// (1)+(2) done earlier in the suite: oldApproval issued under the OLD passkey + used once
	//         (enabled on-chain) BEFORE recovery; recovery rotated to newPasskey. oldBuyList is the
	//         SAME ResolvedBuyList used to issue oldApproval (policies must byte-match at revoke).

	// (4) SUDO-ONLY client at the recovered address under the NEW passkey (no regular plugin).
	const sudoOnly = await bindNewOwnerAccount({ publicClient, newPasskey, rpID: cfg.rpID, address: recoveredAddress });
	const ownerKernelClient = buildSponsoredKernelClient({ account: sudoOnly, cfg });
	await revokeSessionKey({
		ownerKernelClient,
		envelope: parseSessionEnvelope(oldApproval),
		sessionKeySigner: oldSession, // LocalAccount whose address === envelope.sessionKeyAddress
		policies: createBuyListPolicies({
			jpycAddress: cfg.jpycAddress, merchants: oldBuyList.merchants,
			maxPerTransfer: oldBuyList.maxPerTransfer, maxTransfers: oldBuyList.maxTransfers,
			validUntil: oldBuyList.validUntil,
			...(oldBuyList.validAfter !== undefined ? { validAfter: oldBuyList.validAfter } : {}),
		}),
	});

	// (5) the OLD session key can no longer pay:
	let rejected = false;
	try {
		await agentPay({ cfg, publicClient, serializedApproval: oldApproval, sessionSigner: oldSession,
			to: cfg.merchant, amount: parseUnits("0.001", cfg.jpycDecimals),
			identity: { conversationId: "rfc-0003-r4c", stepId: "after-revoke" }, cache: new Map() });
	} catch { rejected = true; }
	expect(rejected).toBe(true);
}, 300_000);
```
R4c thus proves **revocation kills an enabled delegation under the new owner** — the positive "no stale delegation survives recovery" guarantee. (`createBuyListPolicies` is the same SDK call `issuePasskeyScopedSessionKey` uses internally, so the policy array matches by construction when fed the same `oldBuyList`.)

- [ ] **Step 4: Run the off-chain gate + commit-point**

`pnpm typecheck:rfc0003` clean; `pnpm test:rfc0003 -t "Cycle 2 unit"` PASS. Do not commit. Owner runs the live R4b/R4c.

---

## Task 5 — README + scripts + live run + records

**Files:** Modify: `README.md`, `package.json`

- [ ] **Step 1: Add `recovery:probe` to `package.json` scripts**

```json
    "recovery:probe": "tsx zerodev-passkey-jpyc/probe-recovery.ts",
```

- [ ] **Step 2: Extend `README.md` with the Cycle 2 section**

Add: the guardian model (`{Hub, user backup}`, weight 1 each, threshold 2), the **non-custodial argument** (Hub weight 1 < 2 → cannot rotate alone, RFC §6.5) **stated to match the U5 finding** (recover-only vs broader 2-of-2 authority — whichever the probe showed), the R2 de-risk, the new prereqs (`HUB_GUARDIAN_PRIVATE_KEY`, `USER_BACKUP_PRIVATE_KEY`; the **R2 dedicated account** funded with ~0.1 POL for the paymaster-less under-threshold op; JPYC for R4b), and a "Live run result" placeholder (analog of Cycle 1's "20/20").

- [ ] **Step 3: Live run on Amoy (owner) — record R1/R2/R3/R4a/R4b/R4c**

Fund the R3→R4 recoverable account (JPYC + ~0.1 POL) **and the dedicated R2 account** (~0.1 POL for the paymaster-less under-threshold op), fill the two guardian keys + a sponsor-all gas policy, then `pnpm recovery:probe` (foundation incl. U5 scope check) and `pnpm test:rfc0003` (full). Expected: **R2 (Hub-alone) REVERTED ON-CHAIN paymaster-less; R1/R3/R4(a,b,c) green.** Record the result + the U1/U3/U4/U5 resolutions in the README + RFC §8/§6.5 (analog of Cycle 1's 20/20).

- [ ] **Step 4: Stage + provide the conventional-commit message (maintainer commits)**

Stage `zerodev-passkey-jpyc/{recovery.ts,recovery.test.ts,probe-recovery.ts,account.ts,env.ts,harness.ts,README.md}` + `package.json` + `pnpm-lock.yaml` + `.gitignore` + root `.env.example`. Message:
`feat(zerodev-passkey-jpyc): RFC-0003 Cycle 2 — R3a non-custodial recovery (R2 Hub-alone rejected on-chain)`

---

## Self-review

**Spec coverage (RFC-0003 §8 Cycle 2):** R1 setup → Task 1 (+ formalized Task 2). R2 (Hub-alone rejected, paymaster-less) → Task 3 (THE de-risk). R3 (2-of-2 passkey→passkey rotation) → Task 1 probe + Task 2. R4a (no funds / same address) → Task 2. R4b (new owner re-provisions) → Task 4. R4c (revoke old) → Task 4. Foundation spike (the rotation mechanism) → Task 1. ✅

**Known unknowns (front-loaded, NOT placeholders):** U1 (recovery without the passkey signature / enable timing), U2 (co-located 2-of-2 aggregation), U3 (R2 on-chain vs local rejection), U4 (does the executor re-init the PASSKEY validator on-chain) are explicit Task-1/Task-3 investigation steps with expected outcomes + a STOP condition if U1/U4 fail — exactly the Cycle-1 foundation-spike pattern. The probe builds the recoverable sudo with a **throwing** passkey (`buildLostPasskeyValidator`) so a green R3 *proves* passkey-independence rather than masking it (the SDK can't silently use the owner key). The `doRecovery` selector + exact `revokeSessionKey` params are pinned by a verify step, not guessed.

**web3-cto-review incorporated (2026-06-19):** C1 (probe proves passkey-independence via the throwing sudo) · H1 (R4c `revokeSessionKey` call matches the real `ownerKernelClient`/`sessionKeySigner`/`policies` params) · H2 (R2 runs against an already-enabled account as a controlled pair) · H3 (passkey→passkey on-chain rotation moved to U4; `getEnableData()`-is-correct kept as verified) · M1 (R4c sequencing: old key enabled pre-recovery) · M2 (R4a scoped to JPYC) · M3 (probe/R1/R3 sponsored, paymaster-less only for R2) · L1 (post-install symbol gate) · L2 (real offline public client in the unit test). Verdict was Conditional Approval; all gating items applied.

**Owner review incorporated (2026-06-19):** **F1** — R2's load-bearing proof MUST be an **on-chain** revert of the under-threshold op (Cycle-1 caliber); a local SDK refusal is not enough → hand-build + raw-submit the single-guardian userOp if needed (Task 3 Step 2). **F2** (state bug) — R2 runs on a **dedicated** account (`.passkey-r2.json`), because its positive-control rotation would otherwise overwrite R3's `newPasskey` owner and break the definition-order-later R4b/R4c (Task 3 prerequisite). **F3** — added **U5** + probe Step 5b: test whether the 2-of-2 guardians can authorize a non-`doRecovery` userOp, and state the guardian's authority scope accurately in RFC §6.5. **F4** — the U4 STOP now carries forward directions (fresh validator instance / change-pubkey path) instead of dead-ending.

**Type consistency:** `createRecoverableAccount`/`recoverOwner`/`bindNewOwnerAccount` all return `CreateKernelAccountReturnType<"0.7">` or a tx-hash object; `buildGuardianValidator` config uses `{threshold, signers:[{address,weight}]}` + top-level `signers:[LocalAccount]` (matches the verified ZeroDev API); `issuePasskeyScopedSessionKey` gains an optional `address?` (backward compatible). `entryPoint`/`KERNEL_V3_1`/`getEntryPoint("0.7")` consistent across files.

**Sequencing:** Task 1 (spike, STOP-gate) → Task 2 (happy + invariants) → Task 3 (the de-risk) → Task 4 (re-provision/revoke) → Task 5 (docs + live). Tasks 2–4 all edit `recovery.test.ts` so run them in order to avoid churn.
