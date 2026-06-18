# RFC-0003 Cycle 1 — Passkey Owner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Repo workflow:** the **maintainer runs all `git commit` / `git push`** (HTTPS). Each "Commit" step = stage the listed files, verify the gate, hand the maintainer the conventional-commit message. Do **not** run git commit/push.
>
> **Scope:** RFC-0003 **Cycle 1 only** (passkey owner: P1 + P2). Cycle 2 (recovery, R1–R4) is a separate plan after Cycle 1 lands on Amoy.

**Goal:** Prove on Amoy that a **passkey (WebAuthn) sudo owner** can drive the agent payment path — (P1) a passkey-signed userOp lands, and (P2) the de-risked RFC-0001 floor (`createBuyListPolicies` session keys) still holds under the passkey owner.

**Architecture:** A new `kawasekit-example` harness (`zerodev-passkey-jpyc/`, mirroring `zerodev-agent-jpyc/`) that signs WebAuthn **headless in pure Node** via `webauthn-p256` injected through ZeroDev's `toWebAuthnKey({ …, signMessageCallback })` seam — no browser. The passkey validator is the Kernel **sudo**; the RFC-0001 session-key floor is re-rooted under it. Consumes published `kawasekit@^0.8.0`.

**Tech Stack:** TypeScript (ESM, strict), `@zerodev/sdk` 5.5.10, `@zerodev/permissions` 5.5.14, `@zerodev/webauthn-key` 5.5.0 + `@zerodev/passkey-validator` 5.6.0 (`toWebAuthnKey` + `toPasskeyValidator`), **`ox` 0.14.29** (the headless software P256/WebAuthn signer — `P256.sign` + `WebAuthnP256.getSignPayload`/`verify`; replaces `webauthn-p256`, which is only a `navigator` wrapper), viem 2.50.4, Vitest.

> **Spike outcome (resolved during execution):** the **`signMessageCallback` real contract** is `(message: SignableMessage, rpId: string, chainId: number, allowCredentials?) => Promise<Hex>` (a single ZeroDev-encoded `Hex`, not `{authenticatorData, clientDataJSON, signature}`). The byte work splits into **(a)** authenticator bytes + challenge↔signature → settled **off-chain** by `ox/WebAuthnP256.verify` (✅ proven, `passkey.test.ts` 3/3), and **(b)** ZeroDev's wire encoding + challenge expectation → settled by the RN-utils-referenced encoder + on-chain P1. `ox` assembles all the WebAuthn bytes (`getSignPayload`: authenticatorData + clientDataJSON + challenge/type indices + flag UP|UV), so there is **no hand-rolled byte format**.

---

## File Structure

New dir **`kawasekit-example/zerodev-passkey-jpyc/`** (sibling of `zerodev-agent-jpyc/`):

- `passkey.ts` — **the C1 spike core**: the `webauthn-p256` software credential + the `signMessageCallback` adapter + `createPasskeyAccount()` (builds the passkey-sudo Kernel account). One clear responsibility: "produce a passkey-sudo Kernel account that signs headless."
- `env.ts` — config (Amoy RPC, ZeroDev RPC, JPYC address/decimals, rpID, merchant, persisted passkey credential). Mirrors `zerodev-agent-jpyc/env.ts`; **no owner ECDSA key** (the owner is a passkey).
- `harness.ts` — P1 (`payOnce` via the passkey-sudo sponsored client) + P2 (issue a buy-list session key under the passkey owner, reusing `createBuyListPolicies` + the RFC-0001 agent path).
- `harness.test.ts` — P1 + P2 acceptance (unit always; integration gated on a live Amoy env, like RFC-0001).
- `run-demo.ts`, `tsconfig.json`, `README.md` — mirror `zerodev-agent-jpyc/`.

Modify `kawasekit-example/package.json` — add deps + `test:rfc0003` / `typecheck:rfc0003` scripts.

**Expected SDK boundary finding (surface it, RFC-0003 §11):** kawasekit's `issueSessionKey`/`createAgentSmartAccount` build the sudo via `signerToEcdsaValidator` (ECDSA-only). So P2 cannot issue a session key under a passkey owner through kawasekit's current API — the harness builds the passkey-sudo + permission account with raw `@zerodev` (using `createBuyListPolicies` for the policies). Record this as the Cycle-1 boundary finding (the passkey-issuance helper kawasekit needs — analog of G1).

---

## Task 1 — Foundation spike: headless passkey-sudo account + P1 (passkey userOp lands on Amoy)

This task **pins the drifting passkey API** (RFC-0003 C1 spike) and proves the adapter end-to-end. The exact ZeroDev passkey symbol names/signatures **must be confirmed against the installed version** in Step 1 — they drift across releases; the code below is the target shape.

**Files:**
- Modify: `kawasekit-example/package.json`
- Create: `kawasekit-example/zerodev-passkey-jpyc/passkey.ts`
- Create: `kawasekit-example/zerodev-passkey-jpyc/probe-passkey.ts` (a throwaway live probe; delete after P1 is green)

- [ ] **Step 1: Install the deps + PIN THE CALLBACK CONTRACT by reading references (not trial-and-error)**

The spike's real risk is **not** symbol names — it is the **semantic contract of `signMessageCallback` + the WebAuthn challenge encoding**. A challenge-encoding mismatch fails P1 at the validator's *challenge comparison* (not signature verification), which is hard to diagnose blind. Pin these from sources **before** writing the adapter.

Install:
```bash
cd kawasekit-example
pnpm add webauthn-p256 @zerodev/webauthn-key
pnpm view @zerodev/passkey-validator version 2>/dev/null && pnpm add @zerodev/passkey-validator || \
  echo "validator not under @zerodev/passkey-validator — may be @zerodev/webauthn-validator or exported from @zerodev/webauthn-key; resolve in (1)"
```

**(F2) Guard kawasekit's published exports** (the probe imports the M4 `createSponsoredKernelClient` + RFC-0001 symbols — verified present in 0.8.0, but assert):
```bash
node -e "const k=require('kawasekit'); for (const s of ['createSponsoredKernelClient','transferJpyc','getJpycAddress','JPYC_DECIMALS','polygonAmoy','zerodevRpcUrl','createBuyListPolicies']) if(!k[s]) throw new Error('missing '+s); console.log('kawasekit exports OK')"
```
If any are missing (helper not yet released), either release kawasekit first OR build the sponsored client raw in the probe (`createKernelAccountClient` + `createZeroDevPaymasterClient`).

**Pin the symbols AND the callback contract (read, don't guess):**
1. `node -e "console.log(Object.keys(require('webauthn-p256')))"` and `…require('@zerodev/webauthn-key')` → the real `createCredential`/`sign`/`toWebAuthnKey`/`WebAuthnMode` + the validator factory (`toPasskeyValidator`/`toWebAuthnValidator`).
2. **`signMessageCallback` INPUT + RETURN type** — from the installed `.d.ts`: `grep -rn "signMessageCallback\|WebAuthnKey" node_modules/@zerodev/webauthn-key/_types/**/*.d.ts`. Record the EXACT param (is it `{ hash }`, a raw message, or `Hex`?) and the EXACT return (raw signature `Hex`, `{ r, s, authenticatorData, clientDataJSON }`, or an encoded blob?).
3. **Canonical return-shape reference** — read `@zerodev/react-native-passkeys-utils`'s `signMessageWithReactNativePasskeys` (the only official custom-callback impl; `npm view @zerodev/react-native-passkeys-utils` → its repo/source). The Node adapter must reproduce **that exact return shape** from `webauthn-p256.sign()` output.
4. **(F1 CENTERPIECE) Challenge encoding** — confirm what value ZeroDev passes the callback as the WebAuthn challenge, and how its on-chain validator recomputes/compares it (base64url vs hex; `userOpHash` as-is vs re-hashed). `webauthn-p256.sign({ hash })` embeds `hash` into `clientDataJSON.challenge` (base64url) — verify ZeroDev's validator decodes the same. **Document this as the FIRST place to look if P1 reverts** (challenge mismatch ≠ signature failure).
5. **(F4) rpID flow** — the same `rpID` must thread `createCredential` → `webauthn-p256.sign` (rpIdHash derivation) → `toWebAuthnKey` → the validator's on-chain `rpIdHash` check. Confirm `webauthn-p256.sign` derives `rpIdHash` from the credential's rpID (else pass it explicitly).
6. **(F3) Login mode** — confirm `toWebAuthnKey({ mode: WebAuthnMode.Login, webAuthnKey: { …explicit pubkey…, signMessageCallback } })` does **not** call a passkey server (it shouldn't, since the pubkey is supplied — but the harness runs no server, so verify).

**Deliverable of Step 1:** the pinned **input shape / return shape / challenge encoding / rpID flow** (write them into a comment block atop `passkey.ts`). These drive Step 2 — so Step 2 is "match the pinned shapes", not "fix until P1 is green".

- [ ] **Step 2: Write `passkey.ts` (the adapter + account builder)**

Create `zerodev-passkey-jpyc/passkey.ts` — **adjust the passkey symbols to the names confirmed in Step 1**:
```ts
/**
 * RFC-0003 Cycle 1 — headless passkey signer + passkey-sudo Kernel account.
 * webauthn-p256 (pure Node) is injected via ZeroDev's `toWebAuthnKey` signMessageCallback
 * seam, so the harness signs WebAuthn without a browser (RFC-0003 §6.2; C1 foundation spike).
 */
import { createKernelAccount, type CreateKernelAccountReturnType } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
// ↓↓ confirm these against Step 1 (names drift):
import { toWebAuthnKey, WebAuthnMode } from "@zerodev/webauthn-key";
import { toPasskeyValidator } from "@zerodev/passkey-validator";
import { createCredential, sign } from "webauthn-p256";
import type { Chain, Hex, PublicClient, Transport } from "viem";

/** A software passkey credential persisted by the harness (no browser, no passkey server). */
export interface SoftwarePasskey {
	readonly id: string; // credentialId
	readonly publicKey: { readonly x: Hex; readonly y: Hex };
}

/** Create a fresh in-Node P256 "passkey" (the C1 software authenticator). */
export async function createSoftwarePasskey(name: string, rpID: string): Promise<SoftwarePasskey> {
	const cred = await createCredential({ name, rp: { id: rpID, name } });
	// cred.id, cred.publicKey — confirm exact field names in Step 1.
	return { id: cred.id, publicKey: { x: cred.publicKey.x as Hex, y: cred.publicKey.y as Hex } };
}

/**
 * Build a Kernel account whose SUDO is the passkey validator, signing headless.
 * The `signMessageCallback` adapts webauthn-p256.sign() → the WebAuthnAuth the validator wants.
 */
export async function createPasskeyAccount(params: {
	readonly publicClient: PublicClient<Transport, Chain>;
	readonly passkey: SoftwarePasskey;
	readonly rpID: string;
}): Promise<CreateKernelAccountReturnType<"0.7">> {
	const { publicClient, passkey, rpID } = params;
	const entryPoint = getEntryPoint("0.7");

	// INPUT + RETURN shapes per the contract PINNED IN STEP 1 (do not guess): the param type
	// (Step 1.2) and the return type mirror react-native-passkeys-utils (Step 1.3). The WebAuthn
	// challenge (Step 1.4) is carried by webauthn-p256 inside clientDataJSON — if P1 reverts,
	// check the challenge encoding FIRST. Adjust the destructuring/return to the pinned shapes.
	const signMessageCallback = async (message: { hash: Hex }) => {
		const { webauthn, signature } = await sign({ credentialId: passkey.id, hash: message.hash });
		return { authenticatorData: webauthn.authenticatorData, clientDataJSON: webauthn.clientDataJSON, signature };
	};

	const webAuthnKey = await toWebAuthnKey({
		webAuthnKey: { pubX: BigInt(passkey.publicKey.x), pubY: BigInt(passkey.publicKey.y), authenticatorId: passkey.id, signMessageCallback },
		rpID,
		mode: WebAuthnMode.Login,
	});

	const passkeyValidator = await toPasskeyValidator(publicClient, {
		webAuthnKey,
		entryPoint,
		kernelVersion: KERNEL_V3_1,
	});

	return createKernelAccount(publicClient, {
		plugins: { sudo: passkeyValidator },
		entryPoint,
		kernelVersion: KERNEL_V3_1,
	});
}
```

- [ ] **Step 3: Write `probe-passkey.ts` — the live P1 probe (the spike's DoD)**

Create `zerodev-passkey-jpyc/probe-passkey.ts` (reuses the JPYC config + the published kawasekit helpers):
```ts
import "dotenv/config";
import { createSponsoredKernelClient, getJpycAddress, JPYC_DECIMALS, polygonAmoy, transferJpyc, zerodevRpcUrl } from "kawasekit";
import { createPublicClient, getAddress, http, parseUnits } from "viem";
import { createPasskeyAccount, createSoftwarePasskey } from "./passkey.ts";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };

async function main() {
	const projectId = need("ZERODEV_PROJECT_ID");
	const rpID = process.env.PASSKEY_RPID ?? "kawasekit.local";
	const merchant = getAddress(need("MERCHANT_ADDRESS"));
	const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(need("AMOY_RPC")) });

	const passkey = await createSoftwarePasskey("kawasekit-cycle1", rpID);
	const account = await createPasskeyAccount({ publicClient, passkey, rpID });
	console.log("passkey smart account:", account.address, "(fund JPYC here)");

	const client = createSponsoredKernelClient({ account, chain: polygonAmoy, zerodevRpc: zerodevRpcUrl(polygonAmoy, projectId), publicClient });
	const res = await transferJpyc(client, { to: merchant, amount: parseUnits("0.001", JPYC_DECIMALS) });
	console.log("P1 tx:", res.transactionHash, "success:", res.success);
	if (res.success !== true) throw new Error("P1 failed");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run the probe on Amoy — verify P1 lands**

Run: fund the printed passkey smart-account address with JPYC (the demo prints it on first run; it aborts/reverts at execution if unfunded — fund then re-run), with a blanket sponsor-all gas policy set (as RFC-0001).
```bash
cd kawasekit-example && pnpm tsx zerodev-passkey-jpyc/probe-passkey.ts
```
Expected: prints a **P1 tx hash** with `success: true` on Amoy PolygonScan = **a passkey-signed userOp landed** (the adapter + duo-mode P256 verification work).

**If it reverts, diagnose in this order (per Step 1's pinned contract):** (1) **challenge-encoding mismatch (F1 — the most common, least obvious)** — the validator recomputes the challenge from the userOp and compares it to `clientDataJSON.challenge`; a base64url-vs-hex / re-hash mismatch fails here, *not* at signature verification; (2) callback **return shape** (Step 1.2/1.3); (3) **rpID flow** mismatch (Step 1.5 — rpIdHash). Fix `passkey.ts` to match the pinned shapes until P1 is green (this is the spike's purpose — match references, don't thrash).

- [ ] **Step 5: Commit** (maintainer runs)

Delete `probe-passkey.ts` once P1 is green (it's superseded by `harness.test.ts` P1 in Task 3). Stage `package.json`, `pnpm-lock.yaml`, `zerodev-passkey-jpyc/passkey.ts`. Message:
`feat(zerodev-passkey-jpyc): headless passkey-sudo account (webauthn-p256 + signMessageCallback) — P1 lands on Amoy`

---

## Task 2 — Harness scaffold (env + the passkey + buy-list wiring for P2)

**Files:**
- Create: `zerodev-passkey-jpyc/env.ts`, `errors.ts`, `tsconfig.json`
- Modify: `kawasekit-example/package.json` (scripts)

- [ ] **Step 1: Create `tsconfig.json` (independent rfc0003 gate, mirrors rfc0001)**
```json
{
  "extends": "../tsconfig.json",
  "include": ["."]
}
```

- [ ] **Step 2: Create `env.ts` (mirror `zerodev-agent-jpyc/env.ts`, minus the owner ECDSA key)**

Copy `zerodev-agent-jpyc/env.ts` and adapt: keep `AMOY_RPC`, `ZERODEV_RPC`, `ZERODEV_PROJECT_ID`, `JPYC_ADDRESS_AMOY`, `JPYC_DECIMALS`, `MERCHANT_ADDRESS`, the optional policy knobs, `makePublicClient`, `assertJpycOnChain`, `AMOY_CHAIN_ID`. **Remove** `OWNER_PRIVATE_KEY` / `accountsFromConfig` (the owner is a passkey). **Add** `PASSKEY_RPID` (required) and `SESSION_PRIVATE_KEY` (the agent session key is still ECDSA — unchanged from RFC-0001). The `RfcConfig` interface drops `ownerPrivateKey`, adds `rpID: string`.

**(F5) Also create `errors.ts`** — copy `zerodev-agent-jpyc/errors.ts` verbatim (the `SponsorshipError` class, reused by the Task-3 paymaster-less negatives via the RFC-0001 `agentPay`).

- [ ] **Step 3: Add scripts to `package.json`**
```jsonc
"test:rfc0003": "vitest run zerodev-passkey-jpyc",
"typecheck:rfc0003": "tsc --noEmit -p zerodev-passkey-jpyc/tsconfig.json"
```

- [ ] **Step 4: Typecheck the scaffold**

Run: `pnpm typecheck:rfc0003`
Expected: PASS (env.ts + passkey.ts compile; integration code not yet added).

- [ ] **Step 5: Commit** (maintainer runs)

Stage `zerodev-passkey-jpyc/{env.ts,errors.ts,tsconfig.json}`, `package.json`. Message:
`feat(zerodev-passkey-jpyc): harness scaffold (env + independent rfc0003 gate) for the passkey owner`

---

## Task 3 — P2: the RFC-0001 floor under the passkey owner (the Cycle-1 de-risk)

Re-prove the de-risked RFC-0001 §8 acceptance with the **passkey owner** issuing the session key. Reuses `createBuyListPolicies` (policies) + the RFC-0001 agent path (`transferJpyc`, the sponsored + paymaster-less negatives). **Boundary finding:** kawasekit's `issueSessionKey` is ECDSA-only, so the harness builds the passkey-sudo + permission account with raw `@zerodev` (Step 2).

**Files:**
- Create: `zerodev-passkey-jpyc/harness.ts`, `observability.ts`, `harness.test.ts`, `run-demo.ts`, `README.md`

- [ ] **Step 1: `observability.ts` — reuse the RFC-0001 spans**

Copy `zerodev-agent-jpyc/observability.ts` verbatim (the `submit`/`sponsor`/`sponsor_reject`/`settle`/`validation_reject` phases + `createRecordingTelemetry` are identical needs).

- [ ] **Step 2: `harness.ts` — issue a buy-list session key under the passkey owner**

Build the agent account as **passkey sudo + permission(regular) session key**, using `createBuyListPolicies` for the policies and the passkey validator (Task 1) for the sudo. Because kawasekit `issueSessionKey` only accepts an ECDSA owner, assemble it with raw `@zerodev` (mirror kawasekit `createAgentSmartAccount`, swapping `signerToEcdsaValidator` → the passkey validator):
```ts
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { serializePermissionAccount, deserializePermissionAccount } from "@zerodev/permissions";
import { createBuyListPolicies } from "kawasekit";
// + the passkey validator from passkey.ts's builder (factor toPasskeyValidator out so it's reusable here)
```
Provide `issuePasskeyScopedSessionKey(...)` (owner = passkey validator + regular = permission validator from `createBuyListPolicies`, then `serializePermissionAccount`) and reuse RFC-0001's `agentPay` shape (sponsored) + `agentPay({selfPaid:true})` (paymaster-less) — copy them from `zerodev-agent-jpyc/harness.ts` (they take a restored account + `transferJpyc`; the only change upstream is the sudo type, which `serializePermissionAccount`/`deserializePermissionAccount` round-trip). Keep the `sponsorDeclined`/`SponsorshipError` + `buildSelfPaidKernelClient` logic identical to RFC-0001.

- [ ] **Step 3: `harness.test.ts` — P1 + P2 acceptance (mirror `zerodev-agent-jpyc/harness.test.ts`)**

Unit cases (always): the passkey adapter round-trips (a `webauthn-p256` signature verifies against the credential's pubkey — pure Node, no chain). Integration (gated on the live env, `describe.skipIf(!LIVE)`):
- **P1.** A passkey-signed sponsored `transferJpyc` to the merchant lands; `success === true`; merchant balance += amount.
- **P2.** Issue a buy-list session key **under the passkey owner**, then re-run the full RFC-0001 §8: **H1/H2** (sponsored happy path) + **sponsored N1–N4** (`expectPolicyEnforced` durable invariant) + **paymaster-less N1–N4** (`expectOnChainValidationReject`). Copy the helpers + the POL preflight gate from `zerodev-agent-jpyc/harness.test.ts` verbatim. All must hold — the floor survives the ECDSA→passkey owner swap.

- [ ] **Step 4: `run-demo.ts` + `README.md`**

`run-demo.ts`: preflight (print the passkey smart-account address + JPYC/POL) → P1 happy path. `README.md`: prerequisites (JPYC + ~0.1 POL for the §9 paymaster-less negatives, blanket sponsor-all gas policy, `PASSKEY_RPID`), the headless-signing note, and the **SDK boundary finding** (kawasekit `issueSessionKey` is ECDSA-only → a passkey-issuance helper is the kawasekit follow-up). Mirror `zerodev-agent-jpyc/README.md`.

- [ ] **Step 5: Typecheck + unit (integration gated)**

Run: `pnpm typecheck:rfc0003 && pnpm test:rfc0003`
Expected: typecheck PASS; unit cases PASS; integration auto-skips without the live env.

- [ ] **Step 6: Live run on Amoy (owner) — record P1 + P2**

Fund the passkey smart account (JPYC + ~0.1 POL), set the blanket sponsor-all gas policy, fill `.env`, then `pnpm test:rfc0003`. Expected: **P1 lands; P2 green** (H1/H2 + sponsored N1–N4 + paymaster-less N1–N4 all hold under the passkey owner). Record the result (analog of RFC-0001's "16/16").

- [ ] **Step 7: Commit** (maintainer runs)

Stage `zerodev-passkey-jpyc/{harness.ts,observability.ts,harness.test.ts,run-demo.ts,README.md}`. Message:
`feat(zerodev-passkey-jpyc): P2 — RFC-0001 floor under the passkey owner (sponsored + paymaster-less)`

---

## Self-Review

**Spec coverage (RFC-0003 Cycle 1):** P1 (passkey userOp lands) → Task 1 + Task 3 Step 3. P2 (floor under passkey owner) → Task 3. Headless signing seam (§6.2) → Task 1 `passkey.ts`. Independent rfc0003 gate → Task 2. Paymaster-less negatives (§8 P2) → Task 3 Step 3 (reused from RFC-0001). Passkey server out of scope → not built (harness holds the credential locally). SDK boundary finding (issueSessionKey ECDSA-only) → Task 3 Step 2 + README. ✅

**Placeholder scan:** the passkey API in Task 1 is a **foundation spike** (the spec's C1). Per review **F1**, Step 1 now pins not just symbol names but the **`signMessageCallback` contract (input/return shape) + the WebAuthn challenge encoding + the rpID flow** by reading references (the installed `.d.ts` + `@zerodev/react-native-passkeys-utils` as the canonical custom-callback impl) — so Step 2 matches pinned shapes rather than thrashing toward green; Step 4 records the challenge-first diagnostic order. **F2** verified: kawasekit 0.8.0 exports all 7 symbols the probe imports (guard step added). The code is the target shape to match against the pinned contract, not hand-waving; install + reference-read + on-chain DoD are concrete. P2 (Task 3) reuses verbatim, verified RFC-0001 code. No "TODO/implement later".

**Review F1–F5 incorporated:** F1 (callback contract + challenge encoding → Step 1 reference-read + Step 2/4 diagnostics), F2 (kawasekit-export guard, verified present), F3 (Login-mode no-passkey-server check, Step 1.6), F4 (rpID flow consistency, Step 1.5), F5 (`errors.ts` creation, Task 2 Step 2).

**Type consistency:** `SoftwarePasskey`/`createSoftwarePasskey`/`createPasskeyAccount` (Task 1) are consumed in Task 1 Step 3 + Task 3. `RfcConfig` (Task 2) drops `ownerPrivateKey`, adds `rpID`. The RFC-0001 helpers (`agentPay`, `expectPolicyEnforced`, `expectOnChainValidationReject`, `buildSelfPaidKernelClient`) are copied with identical signatures.

**Cycle-2 dependency:** recovery (R1–R4) is intentionally **out of this plan** — it gets its own plan after Cycle 1 lands on Amoy (RFC-0003 §11). The passkey-account builder + the `webauthn-p256` adapter from Task 1 are the reused inputs there (R3 registers a fresh passkey via `createSoftwarePasskey`).
