# Security Policy

kawasekit handles cryptographic keys and on-chain value flows. We take
security seriously and appreciate responsible disclosure.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **security@k0yote.dev** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code if possible)
- Affected version(s) and environment

You can expect an initial acknowledgement within **72 hours**. We will keep
you informed as we investigate and work toward a fix, and will credit you in
the release notes unless you prefer to remain anonymous.

Please give us a reasonable window to address the issue before any public
disclosure.

## Supported Versions

kawasekit is **pre-alpha** software. Until the `0.1.0` release, only the
latest `main` branch receives security fixes. Milestone tags
(`v0.0.0-mN`) are checkpoints — they do **not** receive backported fixes.

| Version | Supported |
| ------- | --------- |
| `main` (pre-alpha) | ✅ |
| `v0.0.0-m1`, `v0.0.0-m2`, … (milestone tags) | ❌ (snapshots only) |

## Scope

This policy covers the kawasekit SDK in this repository. Smart contracts live
in the separate `kawasekit-contracts` repository and are covered by its own
security policy.

## Known threat surface

The list below is a non-exhaustive map of the trust assumptions the SDK
encodes today. Treat it as documentation rather than as a finished threat
model — a full `THREAT_MODEL.md` is planned for M4 alongside mainnet
support. If you find something that is not on this list and looks
exploitable, report it via the channel above.

### M3-1 — x402 (`src/x402/`)

- **Self-facilitator EOA is the gas payer and the broadcaster.** Compromise
  of `X402_FACILITATOR_PRIVATE_KEY` lets an attacker drain its POL balance
  (a denial-of-service vector against your paywall, not against payer funds).
  The facilitator key never touches user JPYC.
- **`createSelfFacilitator` re-verifies before broadcasting.** Even so,
  feeding a malicious `paymentRequirements` to a facilitator you don't
  control can cost you gas via repeated failed simulations. Rate-limit
  inbound `/verify` and `/settle` calls if you expose them publicly.
- **EIP-3009 cross-chain replay.** JPYC v2 deploys at the same address on
  Ethereum / Polygon / Polygon Amoy / Avalanche. The EIP-712 `domain.chainId`
  binds a signature to one chain — kawasekit always populates it from the
  signer's chain. Do **not** strip `chainId` or sign authorizations against
  a placeholder chain ID; signatures with `chainId=0` would replay across
  every deployment.
- **`wrapFetch` does not encrypt the `PAYMENT-SIGNATURE` header.** The
  signed authorization is bearer-grade: anyone who intercepts it before
  the recipient submits can race-broadcast it on their own facilitator.
  Use TLS end-to-end (the spec assumes HTTPS in production).
- **Facilitator concurrency.** Concurrent settlements from the same EOA
  require viem's `nonceManager` (see `createSelfFacilitator` JSDoc).
  Without it, race conditions silently drop settlements — a correctness
  bug, not a confidentiality one, but it surfaces as "payments lost" from
  the user's perspective.

### M3-2 — session-key lifecycle (`src/session/`)

- **`KawasekitSessionEnvelope` is bearer-grade combined with the session
  key.** Whoever holds the envelope **and** the session-key private key
  can spend up to the installed policy limits. The envelope alone is
  insufficient (the private key is distributed out-of-band by design),
  but treat both as secrets. The advisory `expiresAt` field is not
  enforced on-chain unless you also install a `TimestampPolicy`.
- **Owner sudo authority is permanent.** The owner key can revoke or
  rotate the session at any time. Loss of the owner key is unrecoverable
  for v3.1 Kernel accounts — there is no social-recovery layer today.
- **Hard revoke is not race-free.** `revokeSessionKey` submits one sudo
  UserOp; UserOps the session key submitted before the uninstall lands
  can still mine in the meantime. A soft revoke via nonce-key
  invalidation is tracked for M4. Until then, do not assume an in-flight
  attack is shut down the instant `revokeSessionKey` returns.
- **`revoke` requires a sudo-only kernel client.** Passing a client with
  both `sudo` + `regular` plugins makes ZeroDev sign with the session-key
  validator, and the spending policy will reject `uninstallValidation`
  itself. This is documented; a misconfigured caller cannot revoke at
  all (fail-closed) — the session simply remains live.
- **Envelope is not encrypted.** It contains addresses and an opaque
  ZeroDev blob, neither of which is itself sensitive, but readers can
  fingerprint policy choices (`policySummary`). Encrypted envelope
  (JWE etc.) is M4.

### M3-3 — agent example (`examples/agent-x402-jpyc/`)

- The example deliberately holds the agent's payer EOA private key in a
  `.env` file. This is acceptable for a local Polygon Amoy demo; it is
  **not** a production deployment pattern. Production deployments should
  derive a fresh per-instance session key from a hardware-backed root.
- The example's LLM agent is given a budget guard (`onPayment` returns
  `false` past `AGENT_BUDGET_JPYC`). This guard is **advisory** — a
  misbehaving tool implementation can bypass it. Multi-layer enforcement
  (on-chain policy + off-chain guard + framework-level approval) is
  recommended for any agent with non-trivial budget.

### M2 (still in scope)

- `transferJpyc` userOps are signed by whichever Kernel plugin is the
  "default" signer of the kernel client. The kawasekit-supplied helpers
  use sudo only for owner-flagged operations and the session-key
  permission validator for agent-flagged operations. If you build your
  own `KernelAccountClient` and pass it in, you are responsible for
  matching signer to operation correctly.
- `createJpycDailyLimitPolicies` enforces `maxPerTransfer × maxTransfersPerDay`,
  not a cumulative-amount tracker. A session key bound to a high
  `maxPerTransfer` × low `maxTransfersPerDay` is materially different
  from low × high; choose deliberately.
