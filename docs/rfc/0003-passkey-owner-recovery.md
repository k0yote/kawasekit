# RFC-0003 — Passkey Owner + Non-Custodial Recovery (R3a)

| | |
|---|---|
| **Status** | **Cycle 1 (passkey owner) — DONE on Amoy 2026-06-18 (P1+P2, 20/20).** **Cycle 2 recovery — PIVOTED to Approach B (2026-06-20); recovery GATE PROVEN on Amoy.** The original A (bare passkey sudo + separate `WeightedECDSAValidator`) is un-buildable on Amoy (module not deployed; the new `@zerodev/weighted-validator` does 2-of-2 only as the SUDO) → **owner = a weighted validator [passkey 100, Hub 50, backup 50, threshold 100]; recovery = guardian-quorum config-reset to a new passkey** (gate txs in §6). **NOTE: this reopens Cycle 1's owner model** (bare passkey → weighted sudo) → re-validate the session-key floor under the weighted sudo. Headless `ox` signing reused via `toWebAuthnSigner`. Next: fresh Cycle-2 plan for B + RFC §7/§8/§11 align. |
| **Author** | k0yote (with Claude) |
| **Date** | 2026-06-16 |
| **Realizes** | STATUS step 4 (passkey owner + recovery — launch-critical, L1/L3) |
| **Anchored to** | `agent-commerce-hub-reference-architecture.md` §1 (L1 signer), §3 (L3 custody), §5 scope table; **depends on RFC-0001** (the on-chain session-key floor) |
| **SDK baseline** | kawasekit + ZeroDev Kernel v3.1 / EntryPoint 0.7; **`@zerodev/weighted-validator` 5.5.1** (`createWeightedValidator` + `toWebAuthnSigner`/`toECDSASigner` + the `approveUserOperation`/`sendUserOperationWithSignatures` 2-of-2 flow + `getRecoveryFallbackActionInstallModuleData`; module `0x144F…` + recovery executor `0xe884…`+hook `0xb230…`, all verified on Amoy); `@zerodev/webauthn-key` 5.5.0; **`ox` 0.14.29** (headless P256). **Cycle-2 recovery proven on Amoy.** (`@zerodev/weighted-ecdsa-validator` was the wrong/older package — its module isn't on Amoy — and is being dropped.) **Pin + verify symbols at implementation** (they drift). |
| **Locked decisions** | **owner = a weighted-validator multisig** [passkey signer 100, Hub ECDSA 50, user-backup ECDSA 50, **threshold 100**] (Approach B); recovery = **guardian-quorum (Hub+backup = 100) config-reset to a new passkey**; **Hub alone (50) cannot act at all**; the quorum holds **full owner power** but **requires the user's backup** (non-custodial via the user-required threshold + O-4 out-of-band auth — see §6.5, honest). testnet **Amoy**; harness in **`kawasekit-example`**. Deferred: capability-scoped (recover-not-spend) guardians (O-3), timelock-veto (R3b), broader social recovery. |

---

## 1. Summary

Make the agent wallet **launch-ready for consumers** by (a) replacing the ECDSA owner with a **weighted-validator owner whose primary signer is a passkey** (weight 100 of threshold 100 — frictionless biometric login, no seed phrase; normal use = the passkey signs alone), and (b) **non-custodial account recovery**: a user who loses their primary passkey regains control via a **guardian quorum** (Hub + user-backup, 50 + 50 = 100) that **config-resets the weighted owner to a new passkey**, **without the Hub (or any single party) ever being able to seize the account** — the Hub alone (50 < 100) cannot act. The on-chain session-key floor proven in RFC-0001 is **re-rooted under the weighted sudo and re-validated** (§8 C1-revalidate). *(Design pivoted A→B 2026-06-20 — see the §6 banner; recovery gate proven on Amoy.)*

## 2. Motivation

A single ECDSA owner with no recovery (the RFC-0001 L1/L3 posture) is acceptable for a valueless testnet de-risk but **cannot ship to consumers**: losing the key loses the funds, and a raw private key is the wrong UX. Launch needs passkey login (the consumer-grade auth the whole AA stack exists for) and a recovery path. The hard constraint is the project's **non-custodial invariant**: recovery is the classic place a non-custodial design leaks (whoever can recover can seize), so the recovery mechanism must keep the user in control and **structurally prevent the Hub from unilaterally rotating the owner**.

## 3. Goals

- G1. The account's **owner is a weighted validator whose primary signer is a passkey** (weight 100); **normal use = the passkey signs alone** (P256 via RIP-7212 / Daimo fallback — ZeroDev's duo-mode). A passkey-signed userOp lands on Amoy.
- G2. **The RFC-0001 floor survives the owner change.** The session-key path (`createBuyListPolicies` issuance) works under the **weighted sudo** (re-validated, not assumed); RFC-0001's H1/H2 + N1–N4 still hold (§8 C1-revalidate).
- G3. **Recovery is non-custodial (R3a).** The guardians {Hub, user-backup} are **signers within the weighted owner** (weight 50 each); together (50 + 50 = 100) they config-reset the owner to a new passkey, **and the Hub alone (50 < 100) cannot act at all** — proven on-chain.
- G4. The harness lives in `kawasekit-example` and consumes kawasekit as an external dependency (the RFC-0001 boundary-test discipline).

## 4. Non-goals (deferred / out of scope)

- **R3b** (time-locked Hub recovery + user veto) — deferred (more custom; subtler non-custodial argument). O-1.
- **R2** (broader social recovery, M-of-N with N>2, third-party guardians) — deferred. O-2.
- **Passkey-only guardians** (a custom WebAuthn-guardian recovery validator) — deferred; would require a custom audited contract (over-build). The **owner** is a passkey regardless, so login UX is unaffected. O-3.
- x402, AP2, `kawasekit-mpc-2p`, multi-chain, mainnet, real value, the off-chain Hub policy engine (RFC-0002).

## 5. Background — layer positions for this RFC

| Layer | This RFC (BUILD NOW → LAUNCH) |
|---|---|
| **L1 signer** | **Weighted-validator owner, passkey primary signer** (weight 100), duo-mode (RIP-7212 native / Daimo fallback). Replaces the ECDSA sudo. Session-key path **re-validated under the weighted sudo**. |
| **L2 permission** | Unchanged from RFC-0001 — `createBuyListPolicies` session keys, now issued under the weighted-sudo owner. |
| **L3 custody** | **Non-custodial recovery (R3a)**: the guardians {Hub ECDSA, user-backup ECDSA} are **signers in the weighted owner** (weight **50/50**, **threshold 100**); the owner is reset only by meeting the threshold — passkey alone (100) or Hub+backup (100), never a single guardian. |

## 6. Design

> **DESIGN PIVOT (empirical, 2026-06-20) — Approach B.** The original draft (a bare passkey sudo + a *separate* `WeightedECDSAValidator` recovery validator) is **not buildable on Amoy**: the deprecated `@zerodev/weighted-ecdsa-validator` module isn't deployed there, and the current `@zerodev/weighted-validator` does multi-signature **only via an approve/aggregate flow with the weighted validator AS the sudo** (proven on Amoy) — bolting it on as a *regular* guardian reverts (the passkey-sudo + enable + approve combo crashes the SDK). So a 2-of-2 recovery on Amoy ⇒ **the weighted validator IS the owner**. The recovery **gate is proven on Amoy** (2026-06-20): deploy [`0xcbfb7298…`], guardians-only config-reset to a new passkey [`0xd35fcf9a…`], new passkey signs at the same address [`0x87b2b0a7…`]. §6 below is the revised (Approach B) design.

### 6.1 Actors

- **User** — holds a **primary passkey** (the owner *signer*; cloud-synced via iCloud Keychain / Google) and a **backup ECDSA recovery key** (a recovery guardian *signer*; rare-use).
- **Hub** — holds **one ECDSA guardian key** (weight 50, below the threshold). Assists recovery; cannot act alone.
- **Account** — Kernel v3.1; sudo = **one weighted validator** (`@zerodev/weighted-validator`) whose signers are {**passkey** (weight 100), **Hub** ECDSA (50), **user-backup** ECDSA (50)}, **threshold 100**; the recovery executor installed as a **fallback module**.
- **Passkey server** *(PRODUCT component — OUT of harness scope; deferred → O-5)* — in production, stores passkey **public keys** for multi-device login. The **testnet harness does not build it**: it holds the credential/pubkey locally and reconstructs the account from the stored pubkey.

### 6.2 Owner = a weighted validator with the passkey as the primary signer

The sudo is **`@zerodev/weighted-validator`** (`WeightedValidatorContractVersion.V0_0_2_PATCHED`; module `0x144F02c15a8CB2E01D35bf2af8e9eFD96401e44b`, verified deployed on Amoy) configured with three signers — **passkey weight 100, Hub 50, user-backup 50, threshold 100**. So **normal operation = the passkey alone** (weight 100 ≥ 100), same login UX as a bare passkey owner; the recovery quorum = Hub + user-backup (50 + 50 = 100). The passkey is a weighted signer via **`toWebAuthnSigner({ webAuthnKey })`**; P256 verification is ZeroDev's duo-mode (RIP-7212 precompile when present, else the Daimo verifier `0xc2b78104907F722DABAc4C69f826a522B2754De4`), so it works on Amoy. Account address = f(the weighted sudo + its initial config). The multi-signer flow is the approve/aggregate one (`approveUserOperation` per signer → `sendUserOperationWithSignatures`), proven on Amoy across V3_1/V3_3.

**Headless passkey signing — unchanged from Cycle 1, now consumed by `toWebAuthnSigner`.** WebAuthn is normally browser-bound, but the `webAuthnKey` carries the same generic **`signMessageCallback`** seam, contract `(message: SignableMessage, rpId, chainId, allowCredentials?) => Promise<Hex>` returning a single ZeroDev-encoded `Hex`. The harness builds the headless `WebAuthnKey` with the shared `webAuthnKeyForPasskey(passkey, rpID)` helper (the same **`ox`** software P256 authenticator proven in Cycle 1: `WebAuthnP256.getSignPayload` assembles `authenticatorData`+`clientDataJSON`+indices+UP|UV, `P256.sign` produces `{r,s}`; off-chain verified by `ox/WebAuthnP256.verify`, `passkey.test.ts` 3/3). The only change vs Cycle 1 is the consumer: `toWebAuthnSigner({ webAuthnKey })` (a weighted signer) instead of `toPasskeyValidator` (a bare sudo). Pure Node, no browser.

**The session-key floor** runs under the weighted sudo: `createBuyListPolicies` → permission validator (regular) → the RFC-0001 agent path, now rooted on the weighted sudo instead of a bare passkey validator. This re-rooting is **re-validated** under Approach B (§8 / plan; the regular permission validator is independent of the sudo type, but it is proven, not assumed).

### 6.3 Recovery — guardians are signers in the weighted sudo

The guardians {Hub, user-backup} are **signers within the weighted validator** (weight 50 each), **not** a separate validator. Threshold 100 ⇒ the passkey alone (100) **or** Hub+backup together (100) can act; **no single guardian (50) can**. The earlier "guardians must be ECDSA because a passkey cannot be a guardian" premise is **retracted** — `@zerodev/weighted-validator` supports passkey signers too (`toWebAuthnSigner`); we choose **ECDSA** guardians by design (the user's backup factor and the Hub key are ECDSA; rare-use, simpler than a second passkey).

Recovery = the guardian quorum (Hub + user-backup = 100) **resets the weighted config** — swapping the lost passkey signer for a NEW passkey — via `doRecovery(weightedValidatorAddr, newWeightedValidator.getEnableData())`. The recovery executor (`0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E` + hook `0xb230f0A1…`, both on Amoy) **must** be installed as a **fallback module** via `getRecoveryFallbackActionInstallModuleData(...)` + `pluginMigrations` — **not** `plugins.action` (which leaves the `doRecovery` selector unregistered → on-chain `InvalidSelector()` / `0x7352d91c`, the bug the gate caught and fixed).

### 6.4 Recovery flow

1. **Setup (at account creation).** Sudo = the weighted validator [passkey 100, Hub 50, backup 50], threshold 100, with the recovery executor installed as a fallback module. The user securely retains the backup ECDSA key.
2. **Loss.** The user loses the primary passkey beyond cloud-sync (cloud-sync handles the common device-loss case; recovery is the backstop).
3. **Recover.** The user authenticates to the Hub out-of-band; Hub + user-backup (50 + 50 = 100) sign a `doRecovery` userOp that **resets the weighted config to a NEW passkey** (+ the same guardians) the user registers on a new device.
4. **Result.** The new passkey (weight 100) is the owner; the old passkey is removed from the config. **No funds move; the account stays at the same address** (proven by the gate's R3). Session keys issued under the old owner are **not relied upon to survive** — by design (recovery may follow compromise): the new owner re-provisions the agent (§8 R4).

### 6.5 The non-custodial argument (HONEST about the quorum's power)

**Claim.** No single party — in particular **not the Hub** — can act on the account.

**Proof.** Any userOp requires signer weight ≥ threshold 100. Hub = 50 < 100 and user-backup = 50 < 100, so **neither guardian alone can do anything at all** (not merely "cannot recover"). The passkey owner alone = 100 (normal use); Hub + user-backup = 100 (the recovery quorum). Enforced **on-chain** by the weighted validator. ∎

**Honest scope of the guardian quorum — NOT recovery-only (per review F3/U5).** The Hub+backup quorum (100) holds **full owner authority**: it can authorize **any** userOp — spend, transfer, rotate — not just `doRecovery`. We do **not** claim "guardians can recover but not spend." Non-custodial nonetheless holds because **(a)** Hub alone (50) is below threshold for *everything*, and **(b)** the quorum **requires the user's backup key** — the user is a **mandatory co-signer**, so the Hub can never act without the user's participation. A malicious Hub cannot seize; it can at most refuse to assist. The safeguard is the **user-required threshold** plus the Hub's **out-of-band user authentication before co-signing** (O-4, a procedural control) — **not** an on-chain capability restriction. A capability-scoped (recover-but-not-spend) guardian would require a different module (deferred, O-3).

**Target safety.** Because the user is a required co-signer, the user controls the recovery target (the new passkey) — a malicious Hub cannot redirect ownership to itself, only refuse to assist.

### 6.6 What is new vs RFC-0001 + the design pivot

New: the owner is a **weighted-validator multisig** (passkey primary signer + two ECDSA guardian signers); recovery is a **guardian-quorum config reset** to a new passkey. This **pivots** from the earlier draft (bare passkey sudo + a separate weighted-ecdsa recovery validator) for the empirical reasons in the §6 banner (Amoy module deployment + the SDK's multi-sig-as-sudo model), proven by the Amoy gate. **Reused from RFC-0001:** the session-key floor + agent path (now under the weighted sudo, re-validated). **Reused from Cycle 1:** the headless `ox` passkey signing (now via `toWebAuthnSigner`).

## 7. Configuration (pin / verify at implementation)

- **Chain**: Amoy (80002). WebAuthn P256 via RIP-7212 if present else Daimo verifier — assert which path is live and the verifier address.
- **Passkey**: WebAuthn `rpID` / origin binding (must match the deployment origin); set `userVerification = "required"` and check the UV flag; check the BE/BS (backup-eligible / backup-state) flags so the user is warned if the passkey is not cloud-synced.
- **Passkey server**: a store for passkey public keys (account reconstruction). Treat as a privacy/availability surface (O-5).
- **Weighted owner config**: signers = { **passkey** (weight 100), **Hub** ECDSA (50), **user-backup** ECDSA (50) }, **threshold 100** (passkey alone or Hub+backup; no single guardian).
- **SDK**: `@zerodev/webauthn-key` 5.5.0 + **`ox` 0.14.29** (headless passkey, proven Cycle 1) + **`@zerodev/weighted-validator` 5.5.1** — installed + **gate-proven on Amoy 2026-06-20** (module `0x144F…`, recovery executor `0xe884…`+hook `0xb230…`; `createWeightedValidator` / `toWebAuthnSigner` / `toECDSASigner` / `approveUserOperation` / `sendUserOperationWithSignatures` / `getRecoveryFallbackActionInstallModuleData`). **NOT `@zerodev/weighted-ecdsa-validator`** (wrong/older, module not on Amoy) nor `@zerodev/recovery`.
- **Foundation spikes (one per cycle, pin+verify at impl):** **C1 — CLOSED.** the `ox` (`P256`/`WebAuthnP256`) → `signMessageCallback` adapter, off-chain verified + on-chain **P1**. **C2 — CLOSED (gate-proven on Amoy 2026-06-20).** the weighted-validator recovery mechanism (guardian-quorum config-reset to a new passkey via `doRecovery` + the fallback-installed executor), proven by the gate **R1/R2/R3** (deploy `0xcbfb7298…` / reset `0xd35fcf9a…` / new-passkey-signs `0x87b2b0a7…`).

## 8. Test plan / acceptance criteria

Following RFC-0001: every negative (the security claim) is **proven on-chain**, not inferred. **Two slices** (§11): Cycle 1 = passkey owner; Cycle 2 = recovery.

### Cycle 1 — passkey owner — ✅ DONE on Amoy 2026-06-18 (20/20 PASS)
- **P1 (foundation spike) — ✅ PASS.** Account address derives from the passkey public key; a **passkey-signed userOp landed on Amoy** (P256 via RIP-7212 / Daimo fallback). The harness signs **headless** — `ox` (`P256.sign` + `WebAuthnP256.getSignPayload`) mapped to ZeroDev's `signMessageCallback` (§6.2). C1 glue/format adapter closed. Owner-direct tx [`0xeff3008c…cebdd`](https://amoy.polygonscan.com/tx/0xeff3008c4e233e46021aec4b8d0284df35ea66427d7b8f3beabecfd707fcebdd) (account `0xEc2D…F889`).
- **P2 (floor regression) — ✅ PASS.** `createBuyListPolicies` issued **by the passkey owner** → re-ran the full RFC-0001 acceptance: H1/H2 + sponsored N1–N4 (durable invariant; N1–N3 `sponsor_reject`, N4 `validation_reject` per RFC-0001 F1) + the §9 **paymaster-less** N1–N4 (all `validation_reject`, immutable on-chain boundary) + I1/I2/preflight. **All held — the floor survives the ECDSA→passkey owner swap** (no rotation; pure owner change). Demo H1 tx [`0x509c806c…3567`](https://amoy.polygonscan.com/tx/0x509c806c440b549c49a3a6f73a884303a67ac5526e4932261e4ccccb0bbc3567). **SDK boundary finding:** kawasekit's `issueSessionKey` is ECDSA-only (`signerToEcdsaValidator`) → the harness builds the passkey-sudo + permission account raw; a passkey-capable issuance helper is the Cycle-1 SDK follow-up (analog of RFC-0001 G1). Harness: `kawasekit-example/zerodev-passkey-jpyc/` (branch `feat/rfc-0003-cycle1-passkey`).

### Cycle 2 — recovery (R3a, Approach B) — gate PROVEN on Amoy 2026-06-20
Foundation gate (the prerequisite for this revision) PASSED on Amoy: deploy the weighted-sudo account [`0xcbfb7298…`], **guardians-only** config-reset to a new passkey [`0xd35fcf9a…`], new passkey signs at the same address [`0x87b2b0a7…`]. The full acceptance suite below is re-cast for Approach B (built on the proven gate; integration on Amoy).
- **C1-revalidate (NEW — the reopened Cycle-1 owner path).** The session-key floor (RFC-0001 P2) must hold under the **weighted sudo** [passkey 100, Hub 50, backup 50], not just a bare passkey sudo: `createBuyListPolicies` issued under the weighted-sudo owner → H1/H2 + the §9 paymaster-less N1–N4 still pass. Proves the agent floor survives the bare-passkey → weighted-sudo owner change.
- **R1 (setup).** Account created with sudo = weighted [passkey 100, Hub 50, backup 50, threshold 100] + the recovery executor installed as a **fallback module** (`getRecoveryFallbackActionInstallModuleData` + `pluginMigrations`; NOT `plugins.action` → else `InvalidSelector`). Passkey alone signs normally (weight 100). ✅ gate R1.
- **R2 (non-custodial negative — the core claim).** A userOp signed by **the Hub alone** (weight 50 < 100) is **rejected on-chain** — and not merely for recovery: Hub alone is below threshold for **every** action. **Run paymaster-LESS** (self-paid POL), exactly as RFC-0001 §9: a *sponsored* Hub-alone rejection would surface as `sponsor_reject` (the verifying paymaster simulate-and-declines the threshold-reverting `validateUserOp`), masking the boundary — so the airtight proof is a `validation_reject` on the paymaster-less path. Assert via the controlled pair (Hub-alone rejected / Hub+backup succeeds). (Approach B has no separate recovery validator; the boundary is the weighted threshold itself.)
- **R3 (happy path) — ✅ gate-proven.** Primary passkey "lost" → **Hub + user-backup (50+50=100)** sign `doRecovery` → the weighted config is reset to a **new passkey** (fresh `ox` credential) → the new passkey signs alone (weight 100); the **old passkey is gone** from the config.
- **R4 (post-recovery safety):**
  - **R4a.** Recovery moves **no funds**; the account stays at the **same address** (✅ gate R3, same-address).
  - **R4b.** The **new** passkey owner issues a **fresh** session key under the (reset) weighted sudo → the agent pays.
  - **R4c (positive security).** The new owner **revokes the old session key** → the old session key is rejected on-chain (no stale delegation survives).

A passing run = **Cycle 1**: P1 + P2 (already done, but P2 re-validated under the weighted sudo = **C1-revalidate**); **Cycle 2**: R1 / R3 / R4(a,b,c) succeed **and R2 (Hub-alone) is rejected on-chain** — on Amoy. (The gate already proved R1/R3/R4a.)

## 9. Risks & mitigations

- **Quorum total-loss limit** → recovery needs Hub + user-backup together (50 + 50 = 100); if the user loses the backup key too, Hub alone (50 < 100) cannot recover and the account is unrecoverable (the price of non-custody). Mitigated for the common case by **cloud-synced passkeys** (device loss → cloud restore, no recovery needed); R3a is the backstop beyond that. Adding a third user guardian (a lower per-key weight so any two-of-three guardian subset reaches a recovery sub-threshold) is a later option (O-2).
- **Hub guardian-key compromise** → an attacker with the Hub's key still has only weight 50 < 100; cannot act alone (recovery or otherwise). Defense in depth holds.
- **Stolen user backup key** → weight 50 < 100; cannot act alone. The Hub must authenticate the user before co-signing (O-4). **Note (§6.5):** if BOTH the Hub key and the user-backup key are compromised, the quorum = 100 = full owner power (spend, not just recover) — this is the honest cost of a full-power 2-of-2; mitigated by O-4 + keeping the guardian keys well-separated.
- **Passkey UX** → enforce `userVerification="required"`, verify UV; warn on non-synced passkeys (BE/BS); handle WebAuthn browser/origin quirks; Windows-10 P256 gap → CDA/QR fallback.
- **Daimo fallback gas** → first passkey op is expensive without RIP-7212; sponsored by the paymaster (D6); confirm the gas policy covers it.
- **Passkey server** → availability + privacy surface; losing it loses account reconstruction (O-5).

## 10. Open questions

- **O-1 (R3b):** time-locked Hub recovery + user veto — a different non-custodial profile; deferred.
- **O-2 (R2 / 2-of-3):** broader social / additional user guardians for stronger total-loss resistance.
- **O-3 (passkey-only guardians):** a custom WebAuthn-guardian recovery validator so the user's backup is also a passkey (UX unification) — custom audited contract; deferred.
- **O-4 (Hub recovery-authorization policy):** how the Hub authenticates the user before co-signing (account login, KYC, etc.) — operational; gates the Hub's role at launch.
- **O-5 (passkey server custody/privacy):** where public keys live, who runs it, what it leaks; relation to the Hub.
- **O-6 (multi-chain):** guardian/owner consistency across chains (ZeroDev multi-chain validator) when the product goes beyond Amoy/Polygon.

## 11. Rollout

1. Approve this RFC.
2. **Cycle 1 — passkey owner — ✅ DONE (Amoy 2026-06-18, 20/20).** (`kawasekit-example/zerodev-passkey-jpyc`, consuming `kawasekit@0.8.0`.) Foundation spike = the **`ox`**→`signMessageCallback` adapter (C1 closed); **P1** (passkey userOp on Amoy) ✅ + **P2** (RFC-0001 floor under the passkey owner, incl. the §9 paymaster-less negatives) ✅. Passkey server **out of scope** (§6.1). SDK boundary finding surfaced (issueSessionKey ECDSA-only → passkey-issuance helper = follow-up). See §8.
3. **Cycle 2 — recovery (R3a, Approach B)**, on the **weighted-sudo owner**. The recovery mechanism is **gate-proven on Amoy** (§8 banner; deploy/reset/new-passkey txs), so the C2 spike is closed. Remaining: **C1-revalidate** (the session-key floor under the weighted sudo), **R2 (Hub-alone) rejected on-chain, paymaster-less** (self-paid POL, as RFC-0001 §9 — a sponsored Hub-alone would mask as `sponsor_reject`), and **R4(b/c)** (re-provision + revoke old). POL-fund for the paymaster-less negatives. Rewrite the example `recovery.ts` onto `@zerodev/weighted-validator`.
4. Run §8 on Amoy; record results per cycle (each cycle is its own spec → plan → implementation slice).
5. On both cycles green → the wallet is launch-ready (L1 passkey owner + L3 non-custodial recovery). Next: RFC-0002 (layered policy / Hub engine), with the boundary findings + O-4/O-5 as input.
