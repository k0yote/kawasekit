# RFC-0003 — Passkey Owner + Non-Custodial Recovery (R3a)

| | |
|---|---|
| **Status** | **Cycle 1 (passkey owner) — DONE + de-risked on Amoy 2026-06-18 (P1+P2, 20/20 PASS).** Headless passkey signing via **`ox`** (`P256.sign` + `WebAuthnP256.getSignPayload`) + `signMessageCallback` — corrected from `webauthn-p256` during execution (that pkg is only a `navigator` wrapper; see §6.2). **2-slice** (Cycle 1 owner ✅ / Cycle 2 recovery — next); **R2 paymaster-less**; **R4→a/b/c** (re-issue fresh + revoke old = security-correct); passkey-server **deferred**. Cycle 2 (recovery R1–R4) = separate spec → plan. |
| **Author** | k0yote (with Claude) |
| **Date** | 2026-06-16 |
| **Realizes** | STATUS step 4 (passkey owner + recovery — launch-critical, L1/L3) |
| **Anchored to** | `agent-commerce-hub-reference-architecture.md` §1 (L1 signer), §3 (L3 custody), §5 scope table; **depends on RFC-0001** (the on-chain session-key floor) |
| **SDK baseline** | kawasekit + ZeroDev Kernel v3.1 / EntryPoint 0.7; `@zerodev/webauthn-key` 5.5.0 + `@zerodev/passkey-validator` 5.6.0 (duo-mode); `@zerodev/recovery` / WeightedECDSAValidator (ECDSA guardians — Cycle 2); **`ox` 0.14.29** (the headless Node passkey signer actually used — `P256` + `WebAuthnP256`; **not** `webauthn-p256`, which is only a `navigator` wrapper). Cycle-1 deps installed + proven on Amoy; recovery deps still pending. **Pin + verify symbols at implementation** (they drift). |
| **Locked decisions** | passkey (WebAuthn duo-mode) **sudo owner**; recovery = **R3a** — 2-of-2 threshold, guardians = {Hub ECDSA, user backup ECDSA}, **Hub alone cannot recover**; testnet **Amoy**; harness in **`kawasekit-example`**. Deferred: R2 (broader social), R3b (timelock-veto), passkey-only guardians. |

---

## 1. Summary

Make the agent wallet **launch-ready for consumers** by (a) replacing the ECDSA sudo owner with a **passkey (WebAuthn) sudo owner** — frictionless biometric login, no seed phrase — and (b) adding **non-custodial account recovery** so a user who loses their primary passkey can regain control, **without the Hub (or any single party) ever being able to seize the account**. Recovery is R3a: a 2-of-2 guardian threshold where the Hub is one guardian and the user's backup key is the other, so the Hub alone cannot rotate the owner. The on-chain session-key floor proven in RFC-0001 is preserved unchanged — it is simply re-rooted under the passkey owner.

## 2. Motivation

A single ECDSA owner with no recovery (the RFC-0001 L1/L3 posture) is acceptable for a valueless testnet de-risk but **cannot ship to consumers**: losing the key loses the funds, and a raw private key is the wrong UX. Launch needs passkey login (the consumer-grade auth the whole AA stack exists for) and a recovery path. The hard constraint is the project's **non-custodial invariant**: recovery is the classic place a non-custodial design leaks (whoever can recover can seize), so the recovery mechanism must keep the user in control and **structurally prevent the Hub from unilaterally rotating the owner**.

## 3. Goals

- G1. The account's **sudo owner is a passkey** (WebAuthn). A passkey-signed userOp lands on Amoy (P256 verified via RIP-7212 if present, else the Daimo fallback verifier — ZeroDev's duo-mode WebAuthn validator).
- G2. **The RFC-0001 floor survives the owner swap.** The session-key path (`createBuyListPolicies` issuance) works when issued by the passkey owner; RFC-0001's H1/H2 + N1–N4 still hold.
- G3. **Recovery is non-custodial (R3a).** A 2-of-2 guardian threshold (Hub + user backup) can rotate the sudo owner to a new passkey; **the Hub alone (1-of-2) cannot** — proven on-chain.
- G4. The harness lives in `kawasekit-example` and consumes kawasekit as an external dependency (the RFC-0001 boundary-test discipline).

## 4. Non-goals (deferred / out of scope)

- **R3b** (time-locked Hub recovery + user veto) — deferred (more custom; subtler non-custodial argument). O-1.
- **R2** (broader social recovery, M-of-N with N>2, third-party guardians) — deferred. O-2.
- **Passkey-only guardians** (a custom WebAuthn-guardian recovery validator) — deferred; would require a custom audited contract (over-build). The **owner** is a passkey regardless, so login UX is unaffected. O-3.
- x402, AP2, `kawasekit-mpc-2p`, multi-chain, mainnet, real value, the off-chain Hub policy engine (RFC-0002).

## 5. Background — layer positions for this RFC

| Layer | This RFC (BUILD NOW → LAUNCH) |
|---|---|
| **L1 signer** | **Passkey (WebAuthn) sudo owner**, duo-mode (RIP-7212 native / Daimo fallback). Replaces ECDSA sudo. Session-key path unchanged. |
| **L2 permission** | Unchanged from RFC-0001 — `createBuyListPolicies` session keys, now issued by the passkey owner. |
| **L3 custody** | **Non-custodial recovery (R3a)**: 2-of-2 guardian threshold {Hub ECDSA, user backup ECDSA}, owner rotatable only by meeting the threshold. |

## 6. Design

### 6.1 Actors

- **User** — holds a **primary passkey** (the owner; cloud-synced via iCloud Keychain / Google) and a **backup ECDSA recovery key** (the user's recovery guardian; rare-use).
- **Hub** — holds **one ECDSA guardian key** (weight 1, below threshold). Assists recovery; cannot recover alone.
- **Account** — Kernel v3.1; sudo = passkey validator; a recovery validator installed with the two guardians.
- **Passkey server** *(PRODUCT component — OUT of harness scope; deferred → O-5)* — in production, stores passkey **public keys** for multi-device login (public keys are only available at credential creation). The **testnet harness does not build it**: it holds the credential/pubkey locally (as RFC-0001 held the ECDSA keys in env) and reconstructs the account from the stored pubkey.

### 6.2 Passkey owner

The sudo validator is ZeroDev's **WebAuthn (passkey) validator** in duo-mode: it verifies P256 signatures via the RIP-7212 precompile (`0x…0100`) when the chain provides it, and falls back to the Daimo verifier (`0xc2b78104907F722DABAc4C69f826a522B2754De4`) otherwise — so it works on Amoy regardless of RIP-7212 status (the only difference is first-op gas). The account address is derived from the passkey public key (in production a passkey server persists public keys for cross-device reconstruction; out of harness scope — §6.1). `createKernelAccount({ plugins: { sudo: passkeyValidator }, kernelVersion: KERNEL_V3_1, entryPoint })`. **The session-key path is unchanged** — `createBuyListPolicies` → permission validator → `serializePermissionAccount`, now with the passkey validator as sudo. The agent path from RFC-0001 is re-rooted, not rewritten.

**Headless signing (how the harness produces passkey signatures — pure Node, no browser; PROVEN).** WebAuthn is normally browser-bound (`navigator.credentials`), but ZeroDev's `toWebAuthnKey({ webAuthnKey: { …parsedKey, signMessageCallback }, rpID })` exposes a generic **`signMessageCallback`** injection seam (the same one the react-native example uses for a native signer). Its **real contract** (resolved during execution by reading the installed `.d.ts` + the RN-utils encoder) is `(message: SignableMessage, rpId: string, chainId: number, allowCredentials?) => Promise<Hex>` — it returns a **single ZeroDev-encoded `Hex`**, not a `{authenticatorData, clientDataJSON, signature}` struct. `webauthn-p256` is **not** usable here: it is only a thin `navigator.credentials` wrapper, not a headless authenticator. The harness uses **`ox`** (`P256.randomPrivateKey`/`getPublicKey`/`sign` + `WebAuthnP256.getSignPayload`/`verify`) as a fully in-Node software P256 authenticator: `getSignPayload({ challenge, rpId, origin, userVerification:"required" })` assembles `authenticatorData` + `clientDataJSON` + challenge/type indices + UP|UV flags, and `P256.sign` produces `{r,s}` — no hand-rolled WebAuthn bytes. The work split into two pinned layers: **(a)** authenticator bytes + challenge↔signature → verified **off-chain** by `ox/WebAuthnP256.verify` (always-run safety net, `passkey.test.ts` 3/3); **(b)** the `signMessageCallback` adapter encodes `[authenticatorData, clientDataJSON, responseTypeLocation=findQuoteIndices(...).beforeType, r, s, usePrecompiled=isRIP7212SupportedNetwork(chainId)]` **verbatim** from `@zerodev/passkey-validator`'s own `signMessageUsingWebAuthn` — proven on-chain by **P1**. The harness stays **pure Node** (preserving RFC-0001's no-browser / independent-gate discipline).

### 6.3 Recovery (R3a) — guardians are ECDSA

ZeroDev's recovery validator (WeightedECDSAValidator; equivalently the Rhinestone Social Recovery Module) authorizes a sudo-owner rotation when a **weighted threshold of guardian ECDSA signatures** is met. R3a installs it with:

- **guardians** = { **Hub** ECDSA address (weight 1), **user backup** ECDSA address (weight 1) }
- **threshold** = 2 (2-of-2)

So a sudo rotation requires **both** the Hub and the user's backup to sign. **Guardians are ECDSA addresses** — a passkey (P256) cannot be a guardian in the native validator; hence the user's recovery factor is a backup **ECDSA** key, while the **owner remains a passkey** (login UX preserved; recovery is rare). A passkey-only guardian model would need a custom WebAuthn-guardian validator (O-3, deferred).

### 6.4 Recovery flow

1. **Setup (at account creation).** Install the recovery validator with guardians {Hub, user backup}, threshold 2. The user securely retains the backup ECDSA key.
2. **Loss.** The user loses the primary passkey and cannot restore it from cloud (the common device-loss case is already handled by passkey cloud-sync — R3a is the backstop beyond that).
3. **Recover.** The user authenticates to the Hub out-of-band; the Hub and the user's backup key each sign the recovery action; together (2-of-2) they authorize the recovery validator to **rotate the sudo from the old passkey to a NEW passkey** the user registers on a new device.
4. **Result.** The new passkey is the owner; the old passkey is invalid. No funds move during recovery and the account stays at the same address. Session keys issued under the old owner are **not relied upon to survive** — by design (recovery may follow a compromise): the new owner re-provisions the agent (revokes the old session key, issues a fresh one). See §8 R4.

### 6.5 The non-custodial argument (the centerpiece)

**Claim.** No single party — in particular **not the Hub** — can rotate the sudo owner.

**Proof.** Rotating the sudo requires the recovery validator to authorize it, which requires guardian signatures of total weight ≥ threshold T = 2. Guardians = {Hub (weight 1), user backup (weight 1)}; the maximum weight any single guardian holds is 1 < T. The Hub controls only its own guardian key (weight 1). Therefore the Hub alone (weight 1 < 2) cannot meet the threshold and **cannot rotate the owner**. Symmetrically, the user's backup alone (weight 1 < 2) cannot either. Both are required. The threshold is enforced **on-chain** by the recovery validator. ∎

**Target safety.** Because the **user is a required co-signer** (2-of-2), the user co-authorizes the rotation and therefore controls the new owner — the user will not sign a rotation to a Hub-controlled key. So even a malicious Hub cannot redirect ownership to itself; it can at most refuse to assist. Non-custodial holds.

**Operational note (not cryptographic).** The Hub must **authenticate the user out-of-band before co-signing** a recovery (so an attacker who steals the user's backup key cannot recruit the Hub as the second signer). This is a Hub recovery-authorization policy; the cryptographic guarantee (Hub alone cannot seize) holds regardless of it. See O-4.

### 6.6 What is new vs RFC-0001

New: a passkey-owner account-creation path and the R3a recovery setup + flow — exercised by a `kawasekit-example` harness. (The passkey server is a production component, out of harness scope — §6.1, O-5.) Unchanged and reused: the entire session-key floor (`createBuyListPolicies`, the agent payment path), now re-rooted under the passkey owner.

## 7. Configuration (pin / verify at implementation)

- **Chain**: Amoy (80002). WebAuthn P256 via RIP-7212 if present else Daimo verifier — assert which path is live and the verifier address.
- **Passkey**: WebAuthn `rpID` / origin binding (must match the deployment origin); set `userVerification = "required"` and check the UV flag; check the BE/BS (backup-eligible / backup-state) flags so the user is warned if the passkey is not cloud-synced.
- **Passkey server**: a store for passkey public keys (account reconstruction). Treat as a privacy/availability surface (O-5).
- **Guardians**: the Hub ECDSA guardian key (Hub-controlled) and the user's backup ECDSA key; threshold 2.
- **SDK**: `@zerodev/webauthn-key` 5.5.0 + `@zerodev/passkey-validator` 5.6.0 + **`ox` 0.14.29** — installed + proven for Cycle 1; `@zerodev/recovery` / the weighted validator still pending (Cycle 2; confirm exact symbols at impl — the recovery package names drift).
- **Foundation spikes (one per cycle, pin+verify at impl):** **C1 — CLOSED.** the `ox` (`P256`/`WebAuthnP256`) → `signMessageCallback` adapter (byte match vs `@zerodev/passkey-validator`'s `signMessageUsingWebAuthn`), off-chain verified by `ox/WebAuthnP256.verify` + proven on-chain by **P1**. **C2** (Cycle 2) = the exact ZeroDev recovery rotation mechanism (how the threshold validator authorizes the sudo swap on-chain), proven by **R1→R3**.

## 8. Test plan / acceptance criteria

Following RFC-0001: every negative (the security claim) is **proven on-chain**, not inferred. **Two slices** (§11): Cycle 1 = passkey owner; Cycle 2 = recovery.

### Cycle 1 — passkey owner — ✅ DONE on Amoy 2026-06-18 (20/20 PASS)
- **P1 (foundation spike) — ✅ PASS.** Account address derives from the passkey public key; a **passkey-signed userOp landed on Amoy** (P256 via RIP-7212 / Daimo fallback). The harness signs **headless** — `ox` (`P256.sign` + `WebAuthnP256.getSignPayload`) mapped to ZeroDev's `signMessageCallback` (§6.2). C1 glue/format adapter closed. Owner-direct tx [`0xeff3008c…cebdd`](https://amoy.polygonscan.com/tx/0xeff3008c4e233e46021aec4b8d0284df35ea66427d7b8f3beabecfd707fcebdd) (account `0xEc2D…F889`).
- **P2 (floor regression) — ✅ PASS.** `createBuyListPolicies` issued **by the passkey owner** → re-ran the full RFC-0001 acceptance: H1/H2 + sponsored N1–N4 (durable invariant; N1–N3 `sponsor_reject`, N4 `validation_reject` per RFC-0001 F1) + the §9 **paymaster-less** N1–N4 (all `validation_reject`, immutable on-chain boundary) + I1/I2/preflight. **All held — the floor survives the ECDSA→passkey owner swap** (no rotation; pure owner change). Demo H1 tx [`0x509c806c…3567`](https://amoy.polygonscan.com/tx/0x509c806c440b549c49a3a6f73a884303a67ac5526e4932261e4ccccb0bbc3567). **SDK boundary finding:** kawasekit's `issueSessionKey` is ECDSA-only (`signerToEcdsaValidator`) → the harness builds the passkey-sudo + permission account raw; a passkey-capable issuance helper is the Cycle-1 SDK follow-up (analog of RFC-0001 G1). Harness: `kawasekit-example/zerodev-passkey-jpyc/` (branch `feat/rfc-0003-cycle1-passkey`).

### Cycle 2 — recovery (R3a) — the step-4 de-risk
- **R1 (setup).** Recovery validator installed with guardians {Hub ECDSA, user backup ECDSA}, threshold 2. (**Cycle-2 foundation spike** = the exact ZeroDev recovery rotation mechanism — pin+verify, §7.)
- **R2 (non-custodial negative — the core claim; analog of RFC-0001 N1–N4).** A recovery userOp signed by **the Hub alone (1-of-2)** is **rejected on-chain** by the threshold validator (weight 1 < 2). **Run paymaster-LESS** (self-paid POL), exactly as RFC-0001 §9: a *sponsored* Hub-alone rejection would surface as `sponsor_reject` (the verifying paymaster simulate-and-declines the reverting `validateUserOp`), so the airtight, paymaster-independent proof is a `validation_reject` on the paymaster-less path. **This is the step-4 de-risk.**
- **R3 (happy path).** Primary passkey "lost" → **Hub + user backup co-sign (2-of-2)** → sudo rotated to a **new passkey** the user registers (a fresh `ox` P256 credential in the harness) → the new passkey transacts; the **old passkey is rejected**.
- **R4 (post-recovery safety — re-issue is the SECURITY-CORRECT outcome, not a fallback):**
  - **R4a.** The recovery moves **no funds**; the account stays at the **same address** (address invariant).
  - **R4b.** The **new** passkey owner issues a **fresh** session key → the agent pays (the floor works under the new owner — the rotation analog of P2).
  - **R4c (positive security).** The new owner **revokes the old session key** (kawasekit `revokeSessionKey`, now under the new passkey sudo) → the **old session key is rejected on-chain** — proving **no stale delegation survives** the recovery.

A passing run = **Cycle 1**: P1 + P2 green; **Cycle 2**: R1 / R3 / R4(a,b,c) succeed **and** **R2 (Hub-alone) is rejected on-chain, paymaster-less** — on Amoy.

## 9. Risks & mitigations

- **2-of-2 total-loss limit** → if the user loses the backup key too, recovery is impossible (the price of non-custody). Mitigated for the common case by **cloud-synced passkeys** (device loss → cloud restore, no recovery needed); R3a is only the backstop beyond that. A 2-of-3 (add one more user guardian) is a later option (O-2).
- **Hub guardian-key compromise** → an attacker with the Hub's key still has only weight 1 < 2; cannot recover alone. Defense in depth holds.
- **Stolen user backup key** → weight 1 < 2; cannot recover alone. The Hub must authenticate the user before co-signing (O-4).
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
3. **Cycle 2 — recovery (R3a)**, on the proven passkey owner. Foundation spike = the ZeroDev recovery rotation mechanism. Land **R1**, **R3**, **R4(a/b/c)**, and prove **R2 (Hub-alone) rejected on-chain, paymaster-less**. POL-fund the account for the paymaster-less negatives (R2 + the §9 floor regression), as in RFC-0001's "Both" run.
4. Run §8 on Amoy; record results per cycle (each cycle is its own spec → plan → implementation slice).
5. On both cycles green → the wallet is launch-ready (L1 passkey owner + L3 non-custodial recovery). Next: RFC-0002 (layered policy / Hub engine), with the boundary findings + O-4/O-5 as input.
