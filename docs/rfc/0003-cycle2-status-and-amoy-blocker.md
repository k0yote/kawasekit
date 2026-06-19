# RFC-0003 Cycle 2 — Status + the Amoy blocker (external-review brief)

**Date:** 2026-06-19 (updated 2026-06-20) · **Status:** **RESOLVED + recovery GATE PROVEN on Amoy.** The "Amoy blocker" was a wrong-package mistake; the corrected design (**Approach B — weighted validator AS the owner**) is proven on Amoy and RFC §6 is revised to it (see §0′). **Audience:** external reviewer (optional sanity-check, post-gate). **Chain:** Polygon Amoy (testnet), zero-value, UNAUDITED.

## 0′. OUTCOME (2026-06-20) — Approach B, gate proven, RFC pivoted

The confirming probes resolved the A-vs-B question empirically: a 2-of-2 on Amoy with the current `@zerodev/weighted-validator` works **only with the weighted validator AS the sudo** (the approve/aggregate flow); bolting it on as a *regular* guardian (Approach A: bare passkey sudo + weighted guardian) crashes the SDK on the passkey-sudo+enable combo. So **Approach B**: the account sudo is one weighted validator **[passkey 100, Hub 50, backup 50, threshold 100]**; recovery = the guardian quorum (Hub+backup = 100) resets the weighted config to a **new passkey** (the U4 "recover to a passkey" question → **YES, via config-reset**, not a separate-validator rotation). **Gate PROVEN on Amoy 2026-06-20:** deploy `0xcbfb7298…`, guardians-only reset-to-new-passkey `0xd35fcf9a…`, new passkey signs at the same address `0x87b2b0a7…`. One install gotcha the gate caught: the recovery executor must be installed as a **fallback module** (`getRecoveryFallbackActionInstallModuleData` + `pluginMigrations`), not `plugins.action` (→ `InvalidSelector`). **RFC `0003-passkey-owner-recovery.md` §6.1–6.6 + header + §8/§9 are revised to Approach B.** Cost: it **reopens Cycle 1's owner model** (bare passkey → weighted sudo) → the session-key floor is re-validated under the weighted sudo (§8 "C1-revalidate"). Honest non-custodial note (RFC §6.5): the Hub+backup quorum holds **full owner power** (not recovery-only), non-custodial via the **user-required threshold** (Hub alone = 50 < 100) + O-4. §0/§3/§4 below are retained as the diagnostic record.

This brief is self-contained. Full code: `kawasekit-example` branch `feat/rfc-0003-cycle2-recovery`, dir `zerodev-passkey-jpyc/`. Design: `kawasekit/docs/rfc/0003-passkey-owner-recovery.md` (§6.3–6.5, §8 Cycle 2) + plan `0003-cycle2-recovery-plan.md`.

## 0. RESOLUTION (2026-06-19) — it was the wrong package, not an Amoy gap

The `AA23 reverted 0x` was caused by building on **`@zerodev/weighted-ecdsa-validator`** — the *older, deprecated* multisig package used by `zerodevapp/zerodev-examples/guardians/recovery.ts` (which this work copied). Its module `0xeD89…dfeEEE` is genuinely not deployed on Amoy. **But that is not the package the current ZeroDev docs use.** The documented multisig plugin (linked directly from the recovery page: `/advanced/multisig`) is **`@zerodev/weighted-validator`** (`createWeightedValidator`, `WeightedValidatorContractVersion.V0_0_2_PATCHED`), whose module **`0x144F02c15a8CB2E01D35bf2af8e9eFD96401e44b` IS deployed on Amoy (10 452 B, verified by `getCode`).** It also ships the proper multi-signer aggregation API (`approveUserOperation` / `sendUserOperationWithSignatures` / `encodeSignatures`) for the 2-of-2 — which the old package never gave us (the latent U2 risk) — and supports **both ECDSA and passkey signers** (`toECDSASigner` / `toWebAuthnSigner`). **Fix: migrate `recovery.ts` from `weighted-ecdsa-validator` → `weighted-validator`.** No chain switch, no contract deployment. §3/§4 below are retained as the record of how the blocker was diagnosed; the decision in §4 is now moot.

**The one real design question that survives** (for review): the recovery executor + docs recover the owner to an **ECDSA** key (`doRecovery(ECDSA_VALIDATOR_ADDRESS, newSigner.address)`). Our design wants to recover to a **new passkey**. Whether `doRecovery` can re-init a **passkey** validator (vs only ECDSA) is the remaining U4 question — to be settled by a confirming probe on the correct package; if unsupported, recovery would land on an ECDSA owner (a real model change worth a second opinion).

---

## 1. What Cycle 2 is

Cycle 1 (DONE on Amoy, 20/20) proved a **WebAuthn passkey** can be the sudo owner of a ZeroDev Kernel v3.1 account and drive the agent payment floor. Cycle 2 adds **non-custodial recovery (R3a)**: if the passkey is lost, a **2-of-2 guardian set `{Hub ECDSA, user-backup ECDSA}`** (weight 1 each, threshold 2) can rotate the sudo to a **new passkey** — and crucially, **the Hub alone (weight 1 < 2) cannot** (the non-custodial guarantee, enforced on-chain).

The mechanism (per ZeroDev's docs + the `zerodevapp/zerodev-examples/guardians/recovery.ts` example) is:
- guardian validator = `@zerodev/weighted-ecdsa-validator`'s `createWeightedECDSAValidator` (installed as the Kernel **`regular`** plugin),
- `getRecoveryAction(entryPoint.version)` installed as the **`action`**,
- recovery = a `doRecovery(address _validator, bytes _data)` userOp **signed by the guardians**, where `_validator` is the sudo validator's module address and `_data` is the new owner's enable-data → it re-initializes the sudo with the new owner.

The de-risk we set out to prove (RFC-0003 §8): **R2 — a Hub-alone (1-of-2) recovery userOp is rejected on-chain, paymaster-less** (the immutable threshold boundary, analog of Cycle 1's `validation_reject`), plus R1/R3/R4 happy-paths.

## 2. What was built (Task 1) — and it is correct

The recovery wiring is implemented and **typechecks against the real installed `@zerodev` packages**:

- `recovery.ts` — `buildGuardianValidator` (configurable `GuardianSet`), `createRecoverableAccount` (`{sudo: passkey, regular: guardian, action: recovery}`), `buildDoRecoveryCallData` (passkey→passkey via the validator's `getEnableData()`), `recoverOwner` (sponsored / paymaster-less), `bindNewOwnerAccount` (transact as the new owner at the same address via the `createKernelAccount` `address` override).
- `account.ts` — `buildLostPasskeyValidator` (a passkey sudo whose `signMessageCallback` **throws**, so a probe can prove recovery never uses the "lost" key rather than silently passing).
- `env.ts` — the two guardian keys (`optionalHex32`, so the shared `loadConfig` doesn't break Cycle-1 runs) + `guardiansFromConfig`.
- `recovery.test.ts` — off-chain unit test: the `doRecovery` calldata selector is pinned (`0xac39fd0f`) and `buildDoRecoveryCallData` encodes offline.

We verified the API empirically (not from training data): `createWeightedECDSAValidator({config:{threshold,signers:[{address,weight}]}, signers:[LocalAccount]})`, `getRecoveryAction(version)`, the passkey validator's `getEnableData()` returns the `{x,y}+authenticatorIdHash` blob, the ECDSA validator's `getEnableData()` returns the bare owner address (confirming `getEnableData()` is the right `_data` source for `doRecovery`), and `createKernelAccount` accepts an `address` override.

## 3. What the live spike found — the blocker

Every recovery userOp on Amoy reverted **`AA23 reverted 0x`** (the account's `validateUserOp` reverting, empty reason). We isolated it methodically rather than guessing:

1. The throwing-passkey probe first revealed **enable-on-first-use** (the guardian needs the sudo to co-sign its install the first time) — consistent with ZeroDev's docs. Expected; not the blocker.
2. A staged diagnostic with a **control** (replicating ZeroDev's *proven* ECDSA→ECDSA example on our Amoy setup) showed the control **also** fails `AA23 reverted 0x`. → **Not passkey-specific, not 2-of-2-specific, not our code.** Environmental.
3. Direct on-chain `getCode` on Amoy of the three modules the recovery uses:

| Module | Address | Code on Amoy |
|---|---|---|
| ECDSA validator (known-good, used by RFC-0001/Cycle-1) | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` | ✅ 1819 B |
| **WeightedECDSAValidator (the guardian)** | `0xeD89244160CfE273800B58b1B534031699dFeEEE` | ❌ **NONE** |
| Recovery action | `0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E` | ✅ 513 B |

**Root cause: the `WeightedECDSAValidator` module is not deployed on Polygon Amoy.** Kernel's enable-mode tries to call that module to install it as the `regular` validator → no code → revert → `AA23 reverted 0x`. The failing module address even matches the validator-nonce-key prefix in the first failed userOp.

Cross-chain check (same module address): **Sepolia ✅, Base Sepolia ✅, Amoy ❌** (Polygon mainnet RPC was unreachable for the check). So it is an **Amoy-specific deployment gap**, not a code or version problem.

## 4. The open decision (what we want a second opinion on)

The recovery code is correct but unrunnable on Amoy until that module exists there. Options under consideration:

- **(A) Deploy `WeightedECDSAValidator` to Amoy** at its deterministic address `0xeD89…dfeEEE` (ZeroDev contracts use CREATE2). Keeps everything on Amoy (faithful to RFC-0003 + Cycle 1). Cost: obtaining ZeroDev's exact bytecode + salt and running a one-time permissionless deployment. **Is this the right call, and is it as straightforward as "CREATE2 the published bytecode with the published salt"?**
- **(B) Prove the recovery de-risk on Base Sepolia** (modules deployed). The recovery mechanism (R1/R2/R3/R4a/R4c) is chain-agnostic; only R4b (the JPYC floor under the new owner) is JPYC/Amoy-specific and was already proven in Cycle 1 (P2). Fast, but splits the harness across chains.
- **(C) Use a different, Amoy-deployed recovery primitive** (e.g. a Rhinestone social-recovery module, or another guardian validator) achieving the same 2-of-2 rotation — if one exists on Amoy.

## 5. Specific questions for the reviewer

1. **Is the recovery wiring correct** per ZeroDev Kernel v3.1 / EntryPoint 0.7? In particular: `{sudo: passkey, regular: weighted-guardian, action: getRecoveryAction}`, and rotating a **passkey** sudo via `doRecovery(passkeyValidatorAddr, newPasskey.getEnableData())` (the example only showed ECDSA→ECDSA — is the passkey re-init via the recovery executor sound, or does it need a different path?).
2. **Is the diagnosis airtight?** Anything else that produces `AA23 reverted 0x` here that we've mis-attributed to the missing module?
3. **Best path for the missing Amoy module** — (A) deploy it (and how, exactly), (B) move the de-risk to Base Sepolia, or (C) an alternative module already on Amoy? Any precedent for deploying ZeroDev validator modules to an unsupported chain?
4. **Non-custodial model**: once recovery runs, is the guardian validator scoped to `doRecovery` only ("recover but not spend"), or can the 2-of-2 authorize arbitrary userOps? (We planned a probe for this — RFC-0003 §6.5 / plan U5 — but couldn't reach it behind the blocker.)

## 6. Where the code is

- Implementation (uncommitted working tree → to be committed for review): `kawasekit-example` `feat/rfc-0003-cycle2-recovery`, files `zerodev-passkey-jpyc/{recovery.ts, account.ts, env.ts, recovery.test.ts, probe-recovery.ts}` + `package.json`, `.env.example`, `.gitignore`.
- `probe-recovery.ts` is currently the **AA23 isolation diagnostic** (the ECDSA control + passkey splits) that produced §3, not the final R1+R3 probe — it will revert to the recovery probe once the chain question is resolved.
- Off-chain gate is green: `pnpm typecheck:rfc0003` clean; `pnpm test:rfc0003` 8/8 (Cycle-1 unaffected + the Cycle-2 unit). Integration suite (R1–R4) is intentionally **not** written yet — it was gated behind this live spike (the plan's STOP gate), which is exactly what caught the blocker.
