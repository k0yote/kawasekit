---
"kawasekit": minor
---

# `createSponsoredKernelClient` — build a gas-sponsored Kernel client

New `createSponsoredKernelClient({ account, chain, zerodevRpc, publicClient?, observability? })`
returns a `ConfiguredKernelClient` whose UserOp gas is paid by the ZeroDev paymaster —
the construction half of the agent-payment path (kawasekit already shipped
`transferJpyc(client, …)`, which *consumes* such a client, but no helper to *build*
one). Pass the result straight to `transferJpyc`; callers never construct a paymaster
client or cast to `ConfiguredKernelClient`.

The optional `observability` hook (`onSponsor` / `onSponsorError`, fired via the SDK's
safe-invoke) reports sponsorship granted / declined at the paymaster seam — useful for
monitoring and for distinguishing a paymaster decline from a policy rejection. A paymaster
decline re-throws the original error unchanged (no SDK wrapping / no owner-pays fallback).
