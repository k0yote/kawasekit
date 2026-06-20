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
aggregate flow; `revokeSessionKey` is migrated onto the shared
`buildSessionPermissionValidator` helper so issuance and revocation derive the same
validator id. Fully additive: existing ECDSA `ownerSigner` callers are unchanged.
