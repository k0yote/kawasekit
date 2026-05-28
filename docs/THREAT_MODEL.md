# kawasekit Threat Model

> Status: **DRAFT** — pending external security review prior to the `kawasekit@0.1.0`
> npm publish. Comments and counter-examples are welcome via the channels in
> [`SECURITY.md`](../SECURITY.md).

## 0. Scope & reading guide

This document is the security-facing companion to the kawasekit SDK source. It is
written for two audiences:

1. **External security researchers** evaluating whether a given attack surface
   in kawasekit is exploitable, and under what assumptions.
2. **CTOs / tech leads** deciding whether kawasekit is a safe primitive to embed
   in a production product.

It is **not** an introductory document. Reading prerequisites:

- ERC-4337 (Account Abstraction) v0.7
- ZeroDev Kernel v3.1 plugin architecture (sudo / regular validators)
- EIP-3009 `transferWithAuthorization` semantics — in particular that the
  signature scheme uses pure `ecrecover` and does **not** consult ERC-1271,
  so smart-account holders cannot be `from`
- x402 v2 wire format (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE
  headers, exact-EVM scheme)

The scope covered here is the **kawasekit SDK source tree in this repository**.
Out of scope:

- The JPYC contract itself (audited separately by JPYC Inc.)
- The ZeroDev Kernel implementation (audited separately by ZeroDev)
- Bundler / paymaster operator code (operated by third parties or the user)
- The smart-contract repository `kawasekit-contracts` (separate threat model)

The threat model covers six layers, from §0.5 Layer 0
(Supply chain & build integrity) through §5 Layer 5 (Agent runtime).
§6 records known limitations the SDK does not close in this release;
§7 covers vulnerability reporting.

Each layer below uses a fixed structure:

- **Surface** — what the SDK exposes or does on this layer
- **Trust assumptions** — what kawasekit takes as given
- **Threats considered** — listed with a verdict, one of:
  - ✅ **Mitigated** — code in the SDK prevents the attack
  - ⚠️ **Operator responsibility** — exploitable unless the integrator
    follows specific documented guidance
  - 🔵 **Out of scope** — the SDK is not the right defence layer; another
    layer (TLS, hardware wallet, agent framework) is
  - 🟡 **Known limitation** — recognised gap, tracked in §6
- **Where the mitigation lives** — file paths into the source

The verdict vocabulary is deliberately small so that a reviewer can scan the
document and find every threat the SDK believes it has not solved.

**Citation discipline for `✅ Mitigated`.** When a `✅` verdict's mitigation
depends on the behaviour of a component listed in §0's out-of-scope list
above (the JPYC contract, the ZeroDev Kernel implementation, EntryPoint
v0.7, the bundler / paymaster, third-party libraries), the threat's
**notes MUST cite the specific source file + line reference** that
verifies the assumption. Without such a citation, the verdict has the
form "the SDK believes someone else prevents this", which is not the
same as "code in the SDK prevents the attack" and would understate the
threat. This rule was added after the 2026-05-28 self-review demoted
threat 2.2 (concurrent settle nonce race) from `✅` to `⚠️` because the
mitigation was JSDoc-only, not SDK-enforced — the same rigor must apply
to threats whose `✅` rests on out-of-scope component behaviour.

---

## 0.5. Layer 0 — Supply chain & build integrity

### Surface

kawasekit ships to npm as `kawasekit@0.1.0-alpha.0` (and onward) — every
consumer pulls the package + its dependency tree into their own trust
boundary. The supply chain surface covers the kawasekit package itself,
the workspace's dependencies, the build pipeline that produces the
`dist/` shipped to npm, and the npm registry artefact.

### Trust assumptions

- `pnpm-workspace.yaml` **explicitly sets `minimumReleaseAge: 1d`** (24 h
  hold on newly published versions), and both `ci.yml` and `release.yml`
  assert this value via `pnpm config get minimumReleaseAge` before any
  `pnpm install` — operator drift fails the workflow loudly instead of
  silently. This removes the dependency on operator-side pnpm client
  defaults for kawasekit's own build. Operators using `npm` or `yarn`
  in their own consumer projects fall back to whatever their client
  enforces (out of kawasekit's control).
- Only the dependencies explicitly listed in `pnpm-workspace.yaml`'s
  `allowBuilds` may run postinstall scripts. Currently the allowlist
  contains `esbuild` (tsup / tsx dependency) and `sharp` (Astro
  Starlight). Any new postinstall-script dependency requires an explicit
  policy entry.
- The build runs in GitHub Actions on `release.yml` only, with OIDC
  identity. npm Trusted Publishing is the sole publish path; the
  package's npm settings are set to "Require two-factor authentication
  and disallow tokens" so no long-lived credential can publish.
- Production dependencies (`package.json#dependencies`) are pinned to
  exact versions — no `^` or `~`. Devs and transitive deps follow the
  lockfile.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 0.1 | Dependency supply chain compromise (newly published malicious version of a transitive dep) | ✅ Mitigated | `pnpm-workspace.yaml` **explicitly** sets `minimumReleaseAge: 1d` (not just relying on pnpm 11 client defaults). Any package published less than 24 h ago is blocked from install. Both `.github/workflows/ci.yml` and `release.yml` run an `Assert supply chain policy` step that calls `pnpm config get minimumReleaseAge` and fails the workflow if the value drifts from `1d`. Combined with `pnpm install --frozen-lockfile`, a freshly compromised version cannot land in a build without a lockfile change reviewed in a PR — and that PR's CI run re-asserts the policy. |
| 0.2 | Postinstall-script arbitrary code execution | ✅ Mitigated | `pnpm-workspace.yaml#allowBuilds` is the closed allowlist for packages whose postinstall script may run. Today: `esbuild` and `sharp`. Adding a new postinstall-script dependency requires an explicit policy edit reviewed in a PR. |
| 0.3 | Published artefact tampering (npm registry version differs from source) | ✅ Mitigated | `package.json#publishConfig.provenance: true` + GitHub Actions OIDC (`.github/workflows/release.yml`) ships SLSA v1 provenance attestation with every publish. `npm view kawasekit@<version> --json` exposes the attestation URL; consumers can verify the artefact was built from the exact `kawasekit` commit on `main` by the canonical workflow. `docs/RELEASE_VERIFICATION.md` is the operator runbook for this check on every publish. |
| 0.4 | Production dependency version drift | ✅ Mitigated | All entries in `package.json#dependencies` are exact-pinned (verified: `@zerodev/ecdsa-validator` 5.4.9, `@zerodev/permissions` 5.5.14, `@zerodev/sdk` 5.5.10, `commander` 13.1.0, `tslib` 2.8.1, `viem` 2.50.4 — no `^` or `~`). A consumer who installs `kawasekit@0.1.0-alpha.0` gets the same dependency tree everyone else does at that version. |
| 0.5 | Bin command privilege escalation | ⚠️ Operator responsibility | `kawasekit/dist/cli/index.cjs` becomes a PATH-resolvable binary on global install. The CLI reads `.env` from the operator's cwd and accepts private-key flags. **Recommendation**: do not install `kawasekit` globally on a multi-user machine; use `pnpm add kawasekit` in project scope. |

### Where the mitigations live

- `pnpm-workspace.yaml` — `minimumReleaseAge` + `allowBuilds` policy
- `CLAUDE.md` (Supply Chain Policy section) — operator-facing rationale
- `package.json#dependencies` — exact-pin policy enforcement (review at PR time)
- `package.json#publishConfig` + `.github/workflows/release.yml` — provenance attestation pipeline
- `docs/RELEASE_VERIFICATION.md` — per-publish verification runbook

---

## 1. Layer 1 — EIP-3009 / x402 wire format

### Surface

- Client-side: `createX402PaymentSigner` (`src/x402/client.ts`) produces an
  EIP-3009 `TransferWithAuthorization` signature plus the x402 v2 wire payload
  (`X402PaymentPayload`).
- Server-side: `createX402Handler` (`src/x402/server.ts`) and the Hono adapter
  (`src/x402/hono/index.ts`) parse the inbound `PAYMENT-SIGNATURE` header,
  hand the payload to a `Facilitator.verify`, and on success a
  `Facilitator.settle` broadcasts the authorization on-chain.
- Encoding helpers: `src/x402/encoding.ts` handles base64 + JSON
  conformance for the three x402 headers.

### Trust assumptions

- The transport between client and server is TLS-terminated. kawasekit ships
  no application-layer encryption for the `PAYMENT-SIGNATURE` header.
- The token contract at `paymentRequirements.asset` enforces EIP-3009
  semantics correctly (single-use nonce, monotonic time window). kawasekit
  re-verifies but does not duplicate the contract's invariants.
- The EIP-712 domain `name` / `version` advertised by the server is correct
  or, for JPYC v2, matches the well-known constants in
  `JPYC_EIP712_DOMAIN_HINT`.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 1.1 | Cross-chain replay (same JPYC address, different chain) | ✅ Mitigated | **SDK code does not itself enforce cross-chain replay protection — the defence rests on JPYC v2's chain-aware domain separator (out-of-scope per §0), verified empirically below.** kawasekit's role is limited to populating `chainId` from the signer chain at sign time (`src/x402/client.ts`, `signTransferWithAuthorization`); the actual rejection happens at the token contract. Empirical verification: `fiat/EIP712.sol:43` reads `chainid := chainid()` via inline assembly when computing the separator, and `fiat/EIP712Domain.sol:54` additionally guards the cached separator with `if (block.chainid == CHAIN_ID)` — after a hard fork the contract recomputes from `block.chainid`. JPYC v2 deployments on Ethereum / Polygon / Polygon Amoy / Avalanche therefore produce **different** domain separators despite sharing the same address, so the recovered signer for a chain-A signature submitted on chain B mismatches `from` and `require(recovered == from)` reverts. The `✅` verdict is contingent on this JPYC v2 behaviour; if JPYC ever ships a v3 that caches `chainId` without the fork guard, this threat must be re-evaluated. |
| 1.2 | Cross-chain replay (same chain, attempted nonce reuse) | ✅ Mitigated | `generateAuthorizationNonce()` returns a 32-byte cryptographic random; the on-chain `authorizationState` mapping rejects any reuse at the token contract. The facilitator additionally pre-checks `authorizationState` in `verify` to avoid a wasted gas tx. |
| 1.3 | MITM eavesdrop + race-broadcast of `PAYMENT-SIGNATURE` | 🔵 Out of scope | The signed authorization is bearer-grade until on-chain inclusion. An attacker who reads the header before the legitimate facilitator submits can race-broadcast it on their own. **The x402 spec assumes HTTPS in production.** kawasekit produces no plain-HTTP examples and the Hono adapter does not enforce TLS — the integrator must. The authorization fixes `to`, so even if MITM captures the signature it cannot redirect funds; the attack reduces to settlement-flow griefing (the legitimate facilitator's submit fails because nonce is already consumed), not theft. **Verdict rationale (§0 vocabulary):** TLS belongs to the transport layer; kawasekit ships no SDK-level mitigation (no `requireHttps` flag, no scheme-validating helper). The recommendation above is kept for operator awareness, but the SDK is not the right defence layer — moving this from ⚠️ to 🔵 in 2026-05-29 closes the H1 verdict-boundary review item (⚠️ is reserved for threats where kawasekit ships specific guidance or an API affordance, e.g. 1.4's `domainOverride`). |
| 1.4 | Misadvertised EIP-712 domain by a malicious server | ⚠️ Operator responsibility | A server can advertise `extra.name="Evil"` to coerce a signature that recovers against a different domain. **v0.1.0-alpha.2+:** `createX402PaymentSigner` no longer accepts an optional `domainOverride`; it requires a discriminated `asset: { kind: "known"; id } \| { kind: "unsafeOverride"; domain }` (`src/x402/client.ts:CreateX402PaymentSignerParams`). The signer pins the EIP-712 domain at construction time and cross-checks `paymentRequirements.asset` against `verifyingContract` at every sign call — the wire-format `extra.name` / `extra.version` are **never consulted** for signing. Coverage: `src/x402/client.test.ts` "asset whitelist (Threat 1.4)" exercises the adversarial extra-ignored, asset-mismatch refusal, and unsafeOverride paths. **Operator action**: for JPYC v2 pass `{ kind: "known", id: "jpyc-v2" }` (the only whitelisted asset kawasekit ships today, see `src/tokens/known-assets.ts`); for any other asset use `{ kind: "unsafeOverride", domain: { name, version, verifyingContract } }` — the name is deliberately loud so the audit reviewer can spot the escape hatch. |
| 1.5 | Time-window manipulation (replay outside `validAfter`/`validBefore`) | ✅ Mitigated | `verify` checks `now ∈ [validAfter, validBefore)` and returns distinct error codes. The default lifetime (`X402_DEFAULT_AUTHORIZATION_LIFETIME_SECONDS = 300`) bounds the bearer-window. |
| 1.6 | Network / chainId mismatch silently accepted | ✅ Mitigated | M4-1 added a required `network: "mainnet" \| "testnet"` argument to both `createSelfFacilitator` and `createX402PaymentSigner`, and a runtime check throws if it disagrees with the chain identity. This catches the "testnet PK accidentally hitting mainnet RPC" failure mode at construction or sign time, before any broadcast. |
| 1.7 | Header smuggling / base64 malleability | ✅ Mitigated | The encoding layer (`src/x402/encoding.ts`) is byte-equivalence tested against the upstream `@x402/core` reference (`encoding.conformance.test.ts`). The decoder enforces **RFC 4648 §4 canonical base64** at the regex layer: encoded length must be a multiple of 4 and only the legal trailing forms `XX==` / `XXX=` / `XXXX` are accepted. Non-canonical inputs (overlong padding, misplaced padding, short tails, embedded whitespace / newlines / tabs, non-mod-4 lengths) are rejected upfront — `src/x402/encoding.test.ts` "RFC 4648 canonical enforcement (threat 1.7 / §6.7)" exercises 13 adversarial cases plus a positive control that proves the regex does not over-reject. This closes the cross-runtime ambiguity that would otherwise let a permissive Node `Buffer` decoder accept inputs a strict browser `atob` rejects (or vice versa). |
| 1.8 | Reasoning-step duplicate payment (same agent intent, multiple calls) | 🟡 Known limitation — default-on guard required at API surface | See §6.1. The x402 wire format guarantees only **call-level** idempotency via the EIP-3009 nonce. A reasoning-step layer is missing. **SDK-level mitigation (v0.1.0-alpha.2+):** `wrapFetch`'s `onPayment` callback is **required at the type level** (`src/x402/fetch.ts:76`) — omitting it is a compile-time error, not a runtime "default to true". This forces every integrator to write a budget gate per construction site instead of silently inheriting "always pay". The remaining gap (same `fetch402` instance invoked twice for the same reasoning intent) cannot be closed in the wire format and is enumerated in §6.1. |
| 1.9 | verify→settle TOCTOU (payer moves funds between verify and settle) | ⚠️ Operator responsibility | After `verify` passes the balance + nonce-not-used checks, the payer can move JPYC out of their EOA before `settle` lands; the on-chain `transferWithAuthorization` then reverts with insufficient balance. The facilitator already pays gas. This is griefing / DoS, not theft. **Recommendation**: never treat a `verify` success as "payment confirmed" — wait for the `settle` receipt (`waitForTransactionReceipt`) before delivering paid content. kawasekit's `createSelfFacilitator` does this by default. Operators wiring custom facilitators must preserve the property. |
| 1.10 | EIP-3009 front-running griefing (anyone can submit a `transferWithAuthorization` once they hold the signature) | ⚠️ Operator responsibility | EIP-3009 exposes two settlement entry points: `transferWithAuthorization(from, to, value, …, sig)` is permissionless (any caller, any `msg.sender`), and `receiveWithAuthorization(from, to, value, …, sig)` requires `msg.sender == to`. kawasekit's facilitator calls **`transferWithAuthorization`** (`src/x402/facilitator.ts:556`) because the facilitator EOA pays gas but is **not** the JPYC recipient — the recipient is the merchant from `paymentRequirements.payTo`. The `receive` variant would force `msg.sender == to`, which collapses the facilitator role into the merchant. So the choice is structural: front-running griefing is the cost of separating gas-payer from value-recipient. A third party who captures the signature (e.g. via threat 1.3) can broadcast it with their own gas; funds still land at the merchant `to`, but the legitimate facilitator's submission fails with "nonce already used". Mitigation is operational: TLS + minimum-latency settle paths, plus accepting that this surface exists. |
| 1.11 | ECDSA signature malleability (`s` vs `n−s`) | ✅ Mitigated | EIP-3009 uses ECDSA. ECDSA admits two signatures for the same message (`s` and `n−s`). Two layers prevent abuse: (a) viem's `signTypedData` produces canonical low-`s` signatures, and (b) JPYC v2's `fiat/ECRecover.sol:58` actively rejects high-`s` values (`if (uint256(s) > 0x7FFF…20A0) revert "ECRecover: invalid signature 's' value"`). Even if a malleable variant of a signature were constructed, the authorization's uniqueness is bound by the **nonce** — a re-submission with the same `from`+`nonce` reverts on `authorizationState`. No double-spend path. |

### Where the mitigations live

- `src/x402/client.ts` — sign-time network check, time window override
- `src/x402/facilitator.ts` — verify-side replay, network, and balance checks
- `src/x402/encoding.ts` — wire-format encoding/decoding
- `src/tokens/eip3009.ts` — EIP-712 typed-data signer
- `src/x402/encoding.conformance.test.ts` — byte-equivalence with reference

---

## 2. Layer 2 — Self-facilitator EOA

### Surface

`createSelfFacilitator` (`src/x402/facilitator.ts`) is the in-process broadcaster
that turns a verified x402 payload into a `transferWithAuthorization` call on
chain. It is the production-default for kawasekit because the Coinbase CDP
facilitator does not yet support Polygon Amoy and may or may not support
Polygon mainnet at the time this document ships.

The facilitator owns:

- A viem `WalletClient` whose bound `Account` is an EOA that pays gas. **This
  EOA never holds user JPYC** — it is purely the broadcaster.
- A `PublicClient` for balance and authorization-state reads.

### Trust assumptions

- The facilitator EOA private key is held by the operator (the party running
  the paywall server).
- The chain advertised by `walletClient.chain.id` is the chain the operator
  intends to use. The M4-1 `network` argument double-checks the operator's
  intent.
- The RPC endpoint is honest (no eclipsing). Eclipse attacks on a single
  RPC are outside kawasekit's scope — operators are expected to use a
  multi-source endpoint or a node they trust.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 2.1 | Theft of facilitator EOA key | ⚠️ Operator responsibility | Compromise drains the EOA's gas balance (POL). It does **not** drain user JPYC — the EOA never holds JPYC. Impact is denial of service against the paywall, not theft of payer funds. Mitigation lives in operator key custody (HSM / KMS / Vault — `recipes/` chapter, M4). |
| 2.2 | Concurrent settle nonce race | ✅ Mitigated | Parallel `settle()` from the same facilitator EOA would read the same on-chain nonce N for each `writeContract`, so only one tx would land and the rest would revert as nonce-collisions — a correctness failure (settlement silently dropped) surfaced in M3-3 testing. The fix is to attach viem's `nonceManager` to the facilitator's `Account` at construction time, which serialises the local nonce. `createSelfFacilitator` enforces this at construction time: it introspects `walletClient.account.nonceManager` and throws with an actionable error message if absent (`src/x402/facilitator.ts`, the check sits immediately after the chain/network guards). Two unit tests (`src/x402/facilitator.self.test.ts` under "nonceManager enforcement (threat 2.2)") cover both the throw path and the happy path. The mitigation now meets §0's `✅ = SDK code prevents the attack` bar. |
| 2.3 | DoS via repeated invalid `/verify` calls | 🔵 Out of scope | An attacker can feed crafted payloads that fail at simulation, costing the facilitator no gas but consuming RPC reads. kawasekit does no rate-limiting. **Recommendation**: rate-limit at the HTTP layer (the Hono adapter exposes `/verify` and `/settle` for the operator to wrap with `hono/rate-limit`, nginx `limit_req`, or a cloud WAF). **Verdict rationale (§0 vocabulary):** Rate-limiting belongs to the HTTP middleware layer. kawasekit's Hono adapter exposes the endpoints precisely so the operator can wrap them with their preferred limiter; the SDK itself ships no rate-limiter and no scaffold for one. Moving this from ⚠️ to 🔵 in 2026-05-29 closes the H1 verdict-boundary review item — the SDK is genuinely not the defence layer. |
| 2.4 | MEV sandwich on settle | 🔵 Out of scope | `transferWithAuthorization` is a fixed-amount, fixed-recipient transfer with no slippage. There is no profitable sandwich. The only MEV available is censorship (reorder to delay), which the time window upper-bounds. |
| 2.5 | Gas grief — pushing receiptTimeoutMs past completion | ⚠️ Operator responsibility | Default `receiptTimeoutMs = 60_000`. If the bundler / chain is congested, settle may return `unexpected_settle_error` even though the tx eventually lands. The operator should not double-broadcast on this error — the nonce will already be marked used. **Recommendation**: surface `txHash` in error path (already done in `failSettle`) and let the operator probe the chain rather than retry blindly. |
| 2.6 | facilitator EOA signing data not in its intended scope | ✅ Mitigated | The facilitator only signs `transferWithAuthorization` calls on tokens specified by the verified payload. It does not expose a generic signing endpoint. There is no path from a malicious payload to a non-transfer call from this EOA. |
| 2.7 | Misconfigured `network`/`chain.id` (mainnet broadcast on testnet config) | ✅ Mitigated | M4-1 required `network` argument fails fast at construction if the chain identity disagrees. Without this check (M3 behaviour), an operator could have silently broadcast against the wrong network. |
| 2.8 | settle tx reorg (content delivered, payment reverted) | ✅ Mitigated | Polygon PoS can reorganise recent blocks before finality. `createSelfFacilitator` waits for the settle receipt with a **chain-aware confirmation depth**: testnet defaults to `1` (fast dev loops), mainnet defaults to `4` (~8 s of soft finality at Polygon's ~2 s block time, suitable for kawasekit's small-value paywall hits). Operators with high-value merchant flows pass `confirmations: 32` or higher (and bump `receiptTimeoutMs` accordingly) for stronger finality. The setting flows into viem's `waitForTransactionReceipt({ confirmations })` so the facilitator only returns success once the depth is reached on the public client's RPC. See `src/x402/facilitator.ts` (the `defaultConfirmations` computation immediately after the network check) and `docs/THREAT_MODEL.md` §6.6 for the design rationale. The default is documented in the `CreateSelfFacilitatorParams.confirmations` JSDoc with a pointer to the threat ID. |

### Where the mitigations live

- `src/x402/facilitator.ts` — `createSelfFacilitator`, including network check
- `src/x402/facilitator.self.test.ts` — concurrent settle invariant
- `examples/agent-x402-jpyc/server/index.ts` — nonceManager usage in practice
- `docs/recipes/` (planned M4) — HSM / KMS / Vault key custody patterns

---

## 3. Layer 3 — Session-key envelope

### Surface

`src/session/` exposes the lifecycle of a session key — a regular Kernel
validator installed by the owner that permits a bounded set of operations
(usually `transfer` on JPYC up to a daily limit). The lifecycle operations are:

- `issueSessionKey` — owner installs the validator + policy
- `restoreSessionKey` — agent rebuilds the kernel client from a saved envelope
- `revokeSessionKey` — owner uninstalls the validator (sudo-only)
- `rotateSessionKey` — issue a new + revoke the old

The artefact passed between owner and agent is a `KawasekitSessionEnvelope`
(opaque JSON containing the validator address, install data, policy summary,
and an advisory `expiresAt`).

### Trust assumptions

- The owner's wallet remains uncompromised. There is no recovery layer at
  the Kernel v3.1 level: loss of owner key is unrecoverable.
- The agent's environment can hold the session-key private key with at
  least the security of an OS-level secret store. The example app puts it
  in `.env` for demonstration purposes; this is **not** the production
  posture.
- The envelope is transported via a channel the operator considers secure
  (typically owner → agent within the same operator). kawasekit does not
  encrypt the envelope itself.

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 3.1 | Envelope theft alone | ✅ Mitigated | The envelope is useless without the matching session-key private key. The PK is distributed out-of-band and never embedded in the envelope. |
| 3.2 | Envelope + session-key PK theft | ⚠️ Operator responsibility | The combined pair is bearer-grade up to the on-chain policy limits. The owner can revoke at any time (see 3.4). Loss of the agent secret is functionally equivalent to a stolen-card scenario, bounded by the daily limit. |
| 3.3 | Policy circumvention via direct validator install | ✅ Mitigated | Only the owner can install validators. The session key's permission validator cannot install a sibling validator — `uninstallValidation` and `installValidation` are gated to sudo authority by Kernel itself. |
| 3.4 | Revoke race (session key submits work between owner revoke broadcast and inclusion) | 🟡 Known limitation | `revokeSessionKey` submits a single sudo UserOp. UserOps the session key issued **before** that UserOp lands can still mine. Documented in SECURITY.md M3-2 bullet 3 and unchanged in M4. A soft-revoke via nonce-key invalidation is tracked for M5. Until then, an operator MUST NOT assume an in-flight attack stops the moment `revokeSessionKey` returns. |
| 3.5 | Revoke fails closed due to misconfigured client | ✅ Mitigated | `revokeSessionKey` requires a sudo-only kernel client. A client with both sudo + regular plugins would let ZeroDev sign with the session-key validator, which the spending policy then rejects. The function documents this requirement and the failure is loud (an error), not silent (a fake success). |
| 3.6 | Envelope policy fingerprinting | ⚠️ Operator responsibility | The envelope contains `policySummary` in plain text — an observer learns the daily-limit shape. This is acceptable for most use cases (the limit is itself public on-chain). Operators handling unusual policy shapes (e.g. covering a specific user identity) should treat the envelope as confidential and consider envelope encryption (planned M5, see §6.2). |
| 3.7 | Expiry not enforced on-chain | ⚠️ Operator responsibility | The envelope's `expiresAt` is advisory metadata. A `TimestampPolicy` must be installed alongside the spending policy for the chain to enforce the cut-off. Documented in M3-2 SECURITY.md bullet 1. The CLI (`kawasekit session-key issue`, M4-4) will surface this requirement at issuance time. |

### Where the mitigations live

- `src/session/issue.ts`, `src/session/revoke.ts`, `src/session/restore.ts`
- `src/policy/jpyc-daily-limit.ts` — daily-limit policy installed under the
  session-key validator
- `src/account/kernel-client.ts` — sudo-only client construction
- `scripts/09-session-issue-restore.ts`, `scripts/10-session-revoke.ts` —
  on-chain verified flows on Polygon Amoy

---

## 4. Layer 4 — Smart account boundary

### Surface

`src/account/` constructs a ZeroDev Kernel v3.1 smart account for the agent.
The account holds JPYC and signs UserOps via one of two validator chains:

- **sudo** — owner-signed (ECDSA Validator on the owner EOA)
- **regular** — session-key signed (permission validator + policies)

`transferJpyc` (`src/tokens/jpyc.ts`) is the canonical operation — a UserOp
that calls `JPYC.transfer()`. EIP-3009 is **not** used here because JPYC v2's
`transferWithAuthorization` is pure-`ecrecover` and rejects contract `from`.

### Trust assumptions

- The Kernel v3.1 + EntryPoint v0.7 implementation is correct. kawasekit's
  defence ends at the boundary; we trust the AA framework to enforce
  validator routing.
- Validator addresses installed on the account are the canonical ZeroDev
  ones, not adversary forks. kawasekit hard-codes the validator addresses
  from `@zerodev/permissions` / `@zerodev/ecdsa-validator` releases.
- The paymaster is the operator's chosen provider (default: ZeroDev's
  built-in). A malicious paymaster cannot drain user JPYC; it can refuse
  to sponsor (DoS).

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 4.1 | Validator privilege escalation (session key → sudo) | ✅ Mitigated | Kernel v3.1 routes UserOps to validators based on the operation's nonce key. A session-key UserOp cannot reach sudo-flagged paths (`installValidation`, `uninstallValidation`). Confirmed in `scripts/10-session-revoke.ts` — attempts to revoke from the session key fail at the policy check. |
| 4.2 | UserOp signature replay across accounts | ✅ Mitigated | **SDK code does not itself prevent cross-account UserOp replay — the defence rests on ERC-4337 EntryPoint v0.7 (out-of-scope per §0), which binds every UserOp hash to the account address and chain id.** Empirical verification at the canonical EntryPoint address `0x0000000071727De22E5E9d8BAf0edAc6f37da032`: the EIP-712 UserOp hash construction includes both the `sender` (account address) and `chainId`, so a signature recovered from a chain-A UserOp on account A cannot match the digest computed from the same payload signed against account B or against account A on chain X. kawasekit pins this EntryPoint version via `getEntryPoint("0.7")` (`src/account/session-key.ts:90`, `scripts/01-create-account.ts`, etc.). The `✅` verdict is contingent on the canonical EntryPoint v0.7 behaviour; any deployment substituting a different EntryPoint must re-evaluate. |
| 4.3 | Paymaster sponsorship exploited to drain JPYC | 🔵 Out of scope | The paymaster pays gas in chain-native currency; it does not touch JPYC. A compromised paymaster results in stuck UserOps (no sponsorship), not JPYC loss. |
| 4.4 | Default signer assumption in mixed-plugin clients | ⚠️ Operator responsibility | If the operator constructs a `KernelAccountClient` with both sudo and regular plugins, the "default" signer is determined by the construction order. kawasekit's helpers (`buildKernelAccountClient`, `buildSessionKernelClient`) hide this — third-party constructors are responsible for matching signer to operation. Documented in SECURITY.md M2 bullet 1. |
| 4.5 | Daily-limit accounting reset by reissuing session key | ✅ Mitigated | Reissuing a session key (installing a new validator instance under the smart account's `regular` slot) does start that validator's daily counter at zero — that part is mechanically true. The mitigation is that **only the owner (sudo authority) can install a new validator**; a compromised session key cannot reissue itself out from under the policy. Owner-driven reissue is by definition authorised — the owner is the trust root. So an attacker who controls a session key sees the daily-limit cap as a hard ceiling per validator instance and cannot circumvent it by triggering a reissue from below the trust root. **Trust assumption:** this argument assumes the owner key is uncompromised, consistent with the trust assumption stated at the §4 head. If the owner key is compromised, the daily-limit ceiling is no longer meaningful — the attacker can install an arbitrary validator with an arbitrary policy (or no policy at all). Owner key custody is therefore the load-bearing assumption, not the session-key policy itself. The session-key daily limit is a defence-in-depth layer behind a healthy owner key, not an independent containment boundary. |
| 4.6 | Malicious paymaster targeting account-level metadata | 🔵 Out of scope | Paymasters see UserOp metadata (sender, target, calldata). For a JPYC `transfer`, this means: who paid whom, when, how much. This is **on-chain public** after inclusion; the paymaster sees it at most a few seconds early. kawasekit does not consider this a confidentiality breach because the data is public. Operators wanting confidential payments need a different primitive. |
| 4.7 | EIP-3009 attempted from smart-account `from` | ✅ Mitigated | **SDK code does not itself reject smart-account `from` — the defence rests on JPYC v2's pure-`ecrecover` implementation (out-of-scope per §0), which has no ERC-1271 fallback.** kawasekit's facilitator does not add a separate guard because the token contract is the authoritative source of truth. Empirical verification: `fiat/ECRecover.sol` (the JPYC v2 signature recovery helper) calls `ecrecover` directly without consulting any `isValidSignature` interface on the `from` address — a smart account cannot satisfy this path because `ecrecover` returns a different EOA (or the zero address) when given a digest that the smart account would have signed via its own authentication. The facilitator's `verify` then matches the recovered address against `auth.from` and rejects with `invalid_exact_evm_payload_signature` (`src/x402/facilitator.ts`, the `recoverTypedDataAddress` + `getAddress(recovered) !== getAddress(auth.from)` check). The `✅` verdict is contingent on JPYC v2 remaining pure-ecrecover; if a future JPYC version adds ERC-1271 support (which is the natural smart-account-friendly evolution), this threat must be re-evaluated and an SDK-side guard may need to land. |

### Where the mitigations live

- `src/account/kernel-client.ts` — sudo-only and session-key client builders
- `src/tokens/jpyc.ts` — `transferJpyc` via UserOp (the smart-account-safe path)
- `src/x402/facilitator.ts` — signature recovery catches EIP-3009 abuse
- `scripts/05-verify-eip3009-smart-account.ts` — end-to-end test of 4.7

---

## 5. Layer 5 — Agent runtime

### Surface

`examples/agent-x402-jpyc/agent/index.ts` is a reference integration showing
how an LLM agent (Mastra + Anthropic Claude) consumes paywalled APIs through
`wrapFetch` + `createX402PaymentSigner`. This layer is **outside the SDK
boundary** — kawasekit does not ship a runtime — but the SDK's API design
shapes what's enforceable here.

### Trust assumptions

- The agent framework (Mastra, LangChain, …) routes tool calls correctly.
  kawasekit does not adjudicate which tool an LLM "should" have called.
- The LLM provider is honest. Prompt injection from an upstream API
  response, however, is a realistic threat treated below.
- The agent runs in an environment where the operator controls the
  process boundary (process isolation, secret store, network egress).

### Threats considered

| # | Threat | Verdict | Notes |
|---|---|---|---|
| 5.1 | LLM prompt injection → unbounded paywall spend | ⚠️ Operator responsibility | A poisoned tool-call response can instruct the LLM to call expensive endpoints repeatedly. kawasekit's `wrapFetch` exposes an `onPayment(requirements)` callback that the operator MUST implement as a budget guard — the example does so (`onPayment` returns `false` past `AGENT_BUDGET_JPYC`). The guard is **advisory**: a misbehaving tool that bypasses `wrapFetch` and signs directly can ignore it. Multi-layer enforcement (on-chain policy + off-chain guard + framework approval gate) is the documented recommendation. |
| 5.2 | Budget guard bypassed by direct signer access | ⚠️ Operator responsibility | If the operator's tool implementation exposes `signer.sign(…)` directly, the `onPayment` guard does not see the call. **Recommendation**: tools should only have access to `wrapFetch`, not to the underlying signer. |
| 5.3 | Tool input forgery (other tool feeds the paywall tool bogus params) | 🔵 Out of scope | This is a property of the agent framework's tool dispatcher (e.g. Mastra's `tools` schema validation). kawasekit cannot reach into the framework to validate. |
| 5.4 | Agent runtime leaks the signer PK via logs | ⚠️ Operator responsibility | kawasekit's logger module (`src/logger/`) does not log signatures or private keys. The example app does not log them either. A third-party tool or framework that logs request bodies could inadvertently capture `PAYMENT-SIGNATURE`. **Recommendation**: redact `PAYMENT-SIGNATURE` and `Authorization` headers in any HTTP logger. |
| 5.5 | Reasoning-step duplicate payment | 🟡 Known limitation | See §6.1. Mitigation is **agent-side**: pair tool calls with idempotency keys at the framework layer. kawasekit cannot enforce this from the SDK boundary because the SDK does not see the reasoning graph. |
| 5.6 | Holding the agent payer EOA PK in `.env` | ⚠️ Operator responsibility | Acceptable for local Polygon Amoy demo; **not** production posture. Production deployments should derive a session-scoped key from a hardware-backed root and keep the long-lived owner key offline. The example explicitly notes this in its `README.md`. **v0.1.0-alpha.2+:** `examples/agent-x402-jpyc/` now loads PKs through `createPkProvider(uri)` (`examples/agent-x402-jpyc/lib/pk-provider.ts`) — the URI scheme (`env://` for demo, `kms://` for production) is the integrator's first decision, and the demo provider emits a loud `console.warn` at construction so the posture is visible in every run. The `kms://` branch intentionally throws today because kawasekit does not bundle a KMS adapter (key custody is operator territory). The point of the abstraction is to stop new integrators from copy-pasting a bare `process.env.PRIVATE_KEY` read as a "this is fine" pattern. |

### Where the mitigations live

- `src/x402/fetch.ts` — `wrapFetch` and the `onPayment` budget hook
- `src/logger/` — secret-redacting logger (M3)
- `examples/agent-x402-jpyc/README.md` — production-vs-demo posture notes

---

## 6. Known limitations

These are gaps that kawasekit acknowledges and chooses **not** to close in the
0.1.0 release. Each entry records the gap, the consequence, and the planned
mitigation path.

### 6.1. Reasoning-step idempotency gap

**Gap.** kawasekit and the x402 v2 specification guarantee idempotency at three
levels:

| Layer | Unit | Status |
|---|---|---|
| EIP-3009 nonce | One signed authorization | ✅ 32-byte random, replay-safe at the token contract |
| `viem.nonceManager` | One blockchain tx | ✅ Required in `createSelfFacilitator` JSDoc, used in M3-3 example |
| HTTP `Idempotency-Key` | One HTTP request | ❌ **Not implemented** |
| Agent reasoning step | One LLM intent (tool call) | ❌ **Not implemented** |

The bottom two layers are absent, which leaves a class of duplicate-payment
scenarios uncovered:

1. **Transient-failure retry**: client times out, retries; both calls succeed
   → one intent, two payments.
2. **LLM regeneration**: user clicks "Regenerate" in the UI; the same tool call
   fires twice → two payments for one intended action.
3. **Pause-resume**: a conversation pauses and resumes; the agent re-decides
   that the data needs to be fetched again.
4. **Multi-agent fan-out**: two agents independently fetch the same data
   without coordination.
5. **Network duplicate**: client auto-retries on transient failure; the server
   already settled the prior attempt.

**Consequence.** Duplicate payments are real money. On Polygon mainnet with
JPYC, a duplicate is a duplicate transfer of JPY — not a security hole in the
classical CIA sense, but a **correctness** failure that erodes trust in the
SDK at the integration boundary.

**Mitigation path (M5).** A reasoning-step idempotency layer is captured as a
candidate for the M5 milestone (see `.claude/m5-features-candidates.md`,
Candidate 1). The proposed direction follows Stripe's `Idempotency-Key`
header model extended to the x402 wire format:

1. The agent derives a deterministic idempotency key per reasoning step
   (e.g. `${conversationId}:${toolCallId}`).
2. The key propagates through the SDK to the HTTP header.
3. The facilitator deduplicates against a TTL store (24h default).
4. Optionally, the EIP-3009 nonce is itself derived from the idempotency key
   so the on-chain contract becomes the last line of defence.

External feedback that surfaced this gap (Twitter, 2026-05-26) suggested an
extension proposal to the upstream x402 spec; that pathway is open and being
evaluated alongside the in-SDK implementation.

**Operator mitigation today.** Until M5 lands:

- **`wrapFetch`'s `onPayment` callback is required at the type level
  (v0.1.0-alpha.2+).** Omitting it is a compile-time error
  (`src/x402/fetch.ts:76` — `readonly onPayment: (...) => ...`, no `?`).
  This eliminates the "I forgot to wire a budget guard and silently defaulted
  to always-pay" failure mode — every integrator must write the guard or
  explicitly return `() => true`.
- Implement idempotency keys at the agent framework layer (Mastra tool wrappers,
  LangChain callbacks, Vercel AI SDK middleware) — `onPayment` does not see
  reasoning-step identifiers, only the wire-format `paymentRequirements`.
- Cap the `onPayment` budget guard tightly so duplicate payments hit a hard
  ceiling (the canonical pattern in the `wrapFetch` JSDoc and `README.md`
  Quick Start).
- Treat duplicate payment as a known-quantity refund scenario in the
  business logic, not as a fatal incident.

**Privacy consideration (M5 design).** The Round 2 external feedback proposed
deriving the idempotency key from the agent's reasoning step
(`hash(intent_text_normalized || step_idx || optional_context)`). Shipping
such a key over HTTP gives the server a stable identifier per user intent —
linkability across calls becomes available to the merchant / facilitator
even when each individual call would otherwise be unlinkable. Idempotency
and privacy are in tension here. The M5 design must explicitly decide
whether the key is intent-derived (better idempotency, worse linkability)
or opaque-random per call (worse idempotency, better privacy), or hybrid
(intent-derived locally, opaque on the wire with a server-side lookup
table). This is a recorded open question, not a settled answer.

### 6.2. Session-envelope encryption

**Gap.** `KawasekitSessionEnvelope` is plain JSON. Whoever can read the JSON
learns the policy summary and the validator address (both also derivable
on-chain, so this is not new information once the validator is installed).

**Consequence.** Low. The PK is the credential; the envelope is metadata.

**Mitigation path (M5).** JWE-wrapped envelopes (`envelope.jwe`) tracked in
`m5-features-candidates.md` if envelopes start carrying operator-private
information beyond what's on-chain.

### 6.3. Soft revoke (nonce-key invalidation) for session keys

**Gap.** Revoke is a single sudo UserOp; a session-key UserOp issued before
that UserOp lands can still mine. See threat 3.4.

**Consequence.** Bounded by the policy daily limit. Worst case is one
extra cycle of policy-limited transfers between revoke broadcast and
inclusion (typically a few seconds on Polygon).

**Mitigation path (M5).** Pre-invalidate the session key's nonce key in the
same revoke UserOp so any pending session-key UserOp fails simulation.

**Operator mitigation today.** Until M5 lands, see
[`docs/recipes/revoke-race-mitigation.md`](./recipes/revoke-race-mitigation.md)
for a four-layer playbook (SDK call → merchant endpoint shutdown →
paymaster sponsorship freeze → mempool monitoring) plus the residual-risk
notes that constrain what any of these layers can actually stop.

### 6.4. No on-chain budget telemetry

**Gap.** kawasekit ships no contract-level escrow or budget oracle. The
daily-limit policy enforces transaction count and per-transfer amount, not a
cumulative JPYC value cap.

**Consequence.** A session key bound to `maxPerTransfer = 10 JPYC` × `maxTransfersPerDay = 100`
can move 1000 JPYC/day. Operators wanting a true cumulative cap need to
combine the policy with off-chain tracking, or build a custom policy
contract.

**Mitigation path.** Custom policy contract (M5+). The composition of
existing policies covers the M3/M4 use cases.

### 6.5. `nonceManager` enforcement at the SDK level — **closed**

**Status.** Closed in `v0.1.0-alpha.N` post-M4. `createSelfFacilitator`
now performs a construction-time check on `walletClient.account.nonceManager`
and throws an actionable error if absent. Threat 2.2 has been promoted
from `⚠️ Operator responsibility` to `✅ Mitigated` in this revision.

**Historical record (pre-fix gap).** Originally, the SDK required the
bound `walletClient.account` to carry viem's `nonceManager` whenever the
facilitator might settle multiple authorizations in parallel (threat
2.2), but did NOT introspect the account at construction time. JSDoc +
`examples/agent-x402-jpyc/server/index.ts` showed the correct wiring;
nothing rejected the wrong wiring. A misconfigured operator silently
dropped settlements under fan-out — direction opposite to double-spend
(under-collection rather than over-collection). The fix added a runtime
check at construction time with a copy-pasteable error message pointing
operators at the canonical viem pattern, plus two unit tests covering
the throw path and the happy path.

### 6.6. Reorg safety / confirmation depth — **closed**

**Status.** Closed in `v0.1.0-alpha.N` post-M4. `CreateSelfFacilitatorParams`
gained a `confirmations?: number` option, threaded into
`waitForTransactionReceipt({ confirmations })`. Chain-aware default: `1`
on testnet, `4` on mainnet (~8 s of soft finality at Polygon's ~2 s
block time). Threat 2.8 has been promoted from `⚠️ Operator
responsibility` to `✅ Mitigated`.

**Historical record (pre-fix gap).** The original
`waitForTransactionReceipt` call passed only `timeout`, no
`confirmations`, so the facilitator returned success the moment the
settle tx had a receipt — depth `1`. Polygon PoS reorgs at small depths
could revert that settle and the merchant would have already delivered
paid content, losing the JPYC for that hit (real-money loss bounded by
per-call value × concurrent in-flight settles within the reorg window).
The fix adds the chain-aware default + opt-in tuning hook so kawasekit's
target case (small-value paywall hits) gets safe behaviour out of the
box and high-value merchants can dial up.

**Tuning guidance** (planned docs/recipes for M5, summarised here):

| Per-call value | Suggested `confirmations` | Polygon time | When |
|---|---|---|---|
| <1 JPYC | 1 (testnet) / 4 (mainnet) | ~2-8 s | kawasekit default; suitable for small AI-agent paywall hits |
| 1-100 JPYC | 16-32 | ~30-60 s | Mid-value merchant flows |
| >100 JPYC | 256+ | ~9 min | High-value or insurance-grade flows; bump `receiptTimeoutMs` to match |

Operators on chains other than Polygon (Avalanche, Kaia, Ethereum
mainnet in M5+) should consult the chain's finality recommendations and
override the default explicitly.

### 6.7. Adversarial base64 decoding tests — **closed**

**Status.** Closed in `v0.1.0-alpha.N` post-M4. The `BASE64_REGEX` in
`src/x402/encoding.ts` was tightened from `^[A-Za-z0-9+/]*={0,2}$` to the
RFC 4648 §4 canonical form
`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$`,
which enforces length-mod-4 and the legal trailing forms `XX==` / `XXX=` /
`XXXX`. `src/x402/encoding.test.ts` gained a 13-case adversarial corpus
plus 2 positive controls under "RFC 4648 canonical enforcement (threat
1.7 / §6.7)". Threat 1.7 has been promoted from the split verdict
`✅ canonical / 🟡 non-canonical` to a unified `✅ Mitigated`.

**Historical record (pre-fix gap).** The original regex
`^[A-Za-z0-9+/]*={0,2}$` permitted non-canonical inputs that the JSON
parse step happened to reject in practice (lucky correctness), but the
behaviour was sensitive to the underlying `atob` vs `Buffer.from(.., "base64")`
implementation — Node's `Buffer` is permissive about padding while
browser `atob` is strict, so the same input could decode in one
runtime and not the other. The fix moves the canonical-form check
upfront so all runtimes agree before any JSON layer runs.

**Adversarial cases covered.** Overlong padding (`X===`, `X====`),
padding stripped (length not mod 4), misplaced padding (`AB=CD`),
embedded `\n` / `\r` / space / tab (MIME-style folds), impossible
lengths (1, 5, 6), padding-only inputs (`=`, `==`). The positive control
asserts that every canonical tail form is still accepted.

---

## 7. Reporting

Please follow the vulnerability disclosure process in [`SECURITY.md`](../SECURITY.md):

- Do not open a public GitHub issue.
- Email `security@k0yote.dev`.
- Acknowledgement within 72 hours.

The author will credit reporters in the release notes for `kawasekit@0.1.0`
and later, unless the reporter prefers anonymity.

---

## Appendix A — Revision history

This document is revised every time an external review (formal or informal)
surfaces a point. The table below records each revision; when a verdict
changes (`✅ ↔ ⚠️ ↔ 🟡 ↔ 🔵`) the Change column explains the rationale, so a
reader can audit the integrity of the threat model over time.

| Date | Author | Change |
|---|---|---|
| 2026-05-27 | k0yote | Initial draft (M4-3.1 — M4-3.6). Pending external review. |
| 2026-05-28 | k0yote (M4 self-review) | Pre-external-review hardening pass: added Layer 0 (Supply chain & build integrity); added threats 1.9 (verify→settle TOCTOU), 1.10 (`transferWithAuthorization` front-running griefing), 1.11 (ECDSA s-malleability), 2.8 (settle tx reorg); demoted 2.2 (concurrent nonce race) from ✅ to ⚠️ because mitigation is doc-only and §0 requires `✅ = SDK code prevents`; rewrote 1.1 with empirical `fiat/EIP712.sol` reference; refined 1.3, 1.7, 4.5 wording. Added §6.5 (nonceManager enforcement), §6.6 (reorg safety / confirmation depth), §6.7 (adversarial base64 decoding) and the §6.1 privacy consideration. |
| 2026-05-28 | k0yote | Implemented §6.5: `createSelfFacilitator` now performs a construction-time check on `walletClient.account.nonceManager` and throws with an actionable error if absent. Threat 2.2 promoted from `⚠️ Operator responsibility` back to `✅ Mitigated`. §6.5 marked **closed**. Callsites updated: `scripts/07-x402-self-settle.ts` and `src/x402/facilitator.self.test.ts` (test scaffold) now attach `nonceManager`. New unit tests cover the throw path and the happy path. |
| 2026-05-28 | k0yote | Implemented §6.7: `src/x402/encoding.ts` `BASE64_REGEX` tightened to RFC 4648 §4 canonical form. Threat 1.7 promoted from split `✅ canonical / 🟡 non-canonical` to unified `✅ Mitigated`. §6.7 marked **closed**. `src/x402/encoding.test.ts` gained a 13-case adversarial corpus under "RFC 4648 canonical enforcement (threat 1.7 / §6.7)" plus a positive control proving the regex does not over-reject. |
| 2026-05-28 | k0yote | Implemented §6.6: `CreateSelfFacilitatorParams` gained a `confirmations?: number` option, threaded into `waitForTransactionReceipt({ confirmations })`. Chain-aware default = `1` (testnet) / `4` (mainnet). Threat 2.8 promoted from `⚠️ Operator responsibility` to `✅ Mitigated`. §6.6 marked **closed**, with a tuning-guidance table per per-call value range. All three §6.x post-M4 follow-ups (§6.5, §6.6, §6.7) are now closed — the only open §6 items are intentional gaps documented for M5+ (idempotency layer §6.1, envelope encryption §6.2, soft revoke §6.3, on-chain budget telemetry §6.4). |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **C3**: `pnpm-workspace.yaml` now explicitly sets `minimumReleaseAge: 1d` (was relying on pnpm 11 client default). Both `ci.yml` and `release.yml` added an `Assert supply chain policy` step that calls `pnpm config get minimumReleaseAge` and fails the workflow if the value drifts. §0.5 trust assumption + Threat 0.1 notes rewritten to cite the explicit policy + CI assertion. Removes dependency on operator-side pnpm client defaults for kawasekit's own build. |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **C2** (tightened ✅ verdict semantics per §0 vocabulary). §0 vocabulary now carries an explicit "Citation discipline for ✅ Mitigated" rule: when a ✅ verdict's mitigation depends on an out-of-scope component (JPYC contract, ZeroDev Kernel, EntryPoint v0.7, etc.), the threat notes MUST cite the source file + line reference verifying the assumption — same rigor that demoted 2.2 from ✅ to ⚠️ in the prior pass. Threats 1.1 (cross-chain replay), 4.2 (UserOp signature replay across accounts, scope-extended to cover the same pattern), and 4.7 (EIP-3009 from smart-account `from`) rewritten with the explicit "SDK code does not itself enforce — defence rests on <component>" framing plus contingency notes for future changes to those components. Threat 2.6 audited and confirmed to be a genuine SDK code prevention (no signing endpoint exposure), so left unchanged. |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **C1** (wrapFetch budget guard required by default). `WrapFetchParams.onPayment` is now non-optional at the type level (`src/x402/fetch.ts:76`) — omitting it is a compile-time error rather than silently defaulting to "always pay". Threat 1.8 verdict reframed to "🟡 Known limitation — default-on guard required at API surface". §6.1 "Operator mitigation today" promoted the type-level requirement to the first bullet. README.md Quick Start front-loads the call-level idempotency boundary with a budget-cap sample. `src/x402/fetch.test.ts` gained a vitest `expectTypeOf` test ("wrapFetch — onPayment is required at the type level") proving the property is non-optional and required at the type level; all 11 existing `wrapFetch({ signer })` test callsites updated to pass an explicit `onPayment: () => true`. The wire-format reasoning-step gap remains 🟡 — closing it requires the M5 idempotency layer. |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **H1** (tightened ⚠️ vs 🔵 boundary). Threat 1.3 (MITM eavesdrop / race-broadcast) moved from `⚠️ Operator responsibility` to `🔵 Out of scope` — kawasekit ships no SDK-level mitigation (no `requireHttps` flag, no scheme-validating helper); TLS is genuinely a transport-layer concern. Threat 2.3 (DoS via repeated invalid `/verify`) moved from `⚠️ Operator responsibility` to `🔵 Out of scope` — kawasekit ships no rate-limiter and no scaffold for one; the Hono adapter only exposes endpoints for the operator to wrap with `hono/rate-limit` / nginx `limit_req` / a cloud WAF. Both notes gained a "Verdict rationale (§0 vocabulary)" paragraph explaining why each surface is genuinely outside the SDK defence layer. Threat 1.4 (misadvertised EIP-712 domain) kept at `⚠️ Operator responsibility` since the SDK does ship a specific API affordance (`domainOverride`); 1.4 is the canonical example of when ⚠️ applies. After this revision, ⚠️ is reserved for threats where kawasekit ships specific guidance or an API affordance — distinguishing it cleanly from 🔵's "the defence layer is genuinely outside the SDK". |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **H4** (Threat 4.5 owner trust assumption made explicit). Threat 4.5 (daily-limit reset by reissuing session key) now cites the owner-key trust assumption it depends on, consistent with the trust assumption at the §4 head: if the owner key is compromised the daily-limit ceiling is no longer meaningful (the attacker can install an arbitrary validator with arbitrary policy). Owner key custody is the load-bearing assumption; the session-key daily limit is defence-in-depth behind a healthy owner key, not an independent containment boundary. |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **H3** (revoke race operator runbook). New `docs/recipes/revoke-race-mitigation.md` documents a four-layer operator playbook for the minutes-window response between detecting a session-key compromise and the revoke UserOp landing on-chain: Layer 1 (SDK `revokeSessionKey` call with concrete latency table), Layer 2 (off-chain merchant endpoint kill-switch via Hono adapter env flag / nginx maintenance mode), Layer 3 (paymaster sponsorship freeze via ZeroDev policy deny-list), Layer 4 (bundler mempool monitoring via `debug_bundler_dumpMempool`). §6.3 "Operator mitigation today" now points at the recipe. Residual-risk and roadmap sections constrain expectations: even with all four layers, any UserOp the session key signed before Layer 1 lands can still mine, bounded by the per-validator daily policy cap. The structural M5 fix (`invalidateInFlightNonces` in the same revoke UserOp) is referenced. |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **H5** (example PK provider abstraction). `examples/agent-x402-jpyc/` now loads private keys through `createPkProvider(uri)` (`examples/agent-x402-jpyc/lib/pk-provider.ts`) — supported schemes are `env://VARNAME` (demo, emits a loud `console.warn` on construction, `kind: "demo"`) and `kms://<resource>` (production posture, intentionally throws today with a pointer to the recipes). All three PK loaders in the example moved to the abstraction: `agent/index.ts` (`AGENT_PAYER_PK_URI`), `server/index.ts` (`X402_FACILITATOR_PK_URI`), `scripts/session-demo.ts` (`OWNER_PK_URI` + `AGENT_PAYER_PK_URI`). README gained a "Switching to production: replace `env://` with `kms://`" section showing the integrator that the URI scheme is the first decision. Threat 5.6 notes updated to cite the abstraction. The intent is to stop new integrators copying a bare `process.env.PRIVATE_KEY` read as a "this is fine" pattern; the example posture now makes the demo-vs-production boundary visible in the code, not just in prose. |
| 2026-05-29 | k0yote | Closed `THREAT_MODEL_REVIEW_2026-05-29.md` **H2** (`createX402PaymentSigner` asset whitelist). The optional `domainOverride` field on `CreateX402PaymentSignerParams` was replaced with a required discriminated `asset: { kind: "known"; id: KnownAssetId } \| { kind: "unsafeOverride"; domain: { name; version; verifyingContract } }`. The signer pins the EIP-712 domain at construction time (rejecting unknown ids and malformed overrides via the new `X402InvalidConfigError`) and cross-checks `paymentRequirements.asset` against `verifyingContract` at every sign call — the wire-format `extra.name` / `extra.version` are no longer consulted, removing the Threat 1.4 footgun for the JPYC-native default case. New `src/tokens/known-assets.ts` is the canonical whitelist (JPYC v2 only at v0.1.0-alpha.2). All 30+ callsites in `src/`, `scripts/`, and `examples/` updated to pass `asset: { kind: "known", id: "jpyc-v2" }`. Threat 1.4 verdict notes rewritten to cite the construction-time pinning + sign-time cross-check; "asset whitelist (Threat 1.4)" describe in `src/x402/client.test.ts` covers happy path, asset-mismatch refusal, `unsafeOverride` happy path, and three `X402InvalidConfigError` paths. `X402InvalidConfigError`, `X402AssetParam`, `KnownAssetId`, `KnownAssetDomain`, `getKnownAssetDomain`, `listKnownAssetIds` added to the public API surface (root + `kawasekit/x402` subpath). |
