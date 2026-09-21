---
"kawasekit": minor
---

feat!: settlement payments — a payment that carries an order reference; the buy-list key pays only through `Settlement`; the `mpc-2p` adapter is removed

**Breaking change.** Three breaks, each with its migration below.

An ERC-20 `transfer` carries a recipient and an amount and nothing else — it cannot say what
it pays for. A payment through the new `Settlement` contract can: one UserOp carries
`[JPYC.approve(Settlement, amount), Settlement.pay(…)]`, and the chain is left with a single
`Settled(ref, payer, merchant, token, amount)` whose `ref` the contract computed itself from
what was actually paid. One order, one payment (a second `pay` of the same `ref` reverts); an
expired order cannot be paid; the contract holds no funds and has no owner. **The contract is
unaudited** and is deployed on **Polygon Amoy only** (`0x25BA7329A4c5772945B9d2C0E80ec7dfd41EE485`,
CREATE2 — the same address on every chain once deployed).

**New:** `settleOrder`, `buildSettlementPaymentCalls`, `hashOrderRef`, `hashOrderDetails`,
`settlementOrderTypes`, `settlementOrderDetailsTypes`, `settlementAbi`, `getSettlementAddress`,
`settlementDeployments`, `SETTLEMENT_V1_ADDRESS`, and their types and errors.
`settleOrder` takes no payer, no `Settlement` address and no token: the payer is the account
(the contract hashes `msg.sender`) and the addresses come from this package's tables. Pass
`expectedRef` whenever the order reference came from someone else — it is compared before
anything is sent, and a difference throws `SettlementOrderRefMismatchError`.

**1. `createBuyListPolicies` scopes the key to `Settlement`, not to `transfer`.**
The key may call `JPYC.approve(spender == Settlement, amount ≤ cap)` and
`Settlement.pay(token == JPYC, merchant ∈ merchants, amount ≤ cap, …)`; a bare
`JPYC.transfer` is refused on chain. `settlementAddress` is a new **required** parameter. The
return type is unchanged, and issue / revoke / restore / rotate are untouched — but the
permission id changes. The call policy bounds each call, **not the number of calls in a batch**:
if you sponsor gas, holding a UserOp to one payment is your sponsorship policy's job
(`buildSettlementPaymentCalls` is the shape to compare against).
**Migration:** add `settlementAddress: getSettlementAddress(chainId)`; pay with `settleOrder`
instead of `transferJpyc`; **re-issue every buy-list key.** Because `Settlement` is live on
Polygon Amoy only, **so is the buy-list in 0.11.0; every further chain needs a release of this
package.** A transfer-scoped key is still available through `createJpycDailyLimitPolicies`.

**2. `callPolicyVersion` is removed from `createBuyListPolicies`.** It is fixed at `V0_0_4`, the
only version the two-permission batch has been run against.
**Migration:** drop the argument. `createJpycDailyLimitPolicies` keeps its option.

**Revoking keys issued by ≤ 0.10.x.** A key is revoked by re-supplying the exact policies it was
issued with, and the new builder can no longer produce them. The 0.10.0 builder therefore stays,
deprecated, as `createLegacyTransferBuyListPolicies` — byte-identical output, pinned by a test —
**for revocation only**. It is removed in 0.12.0: revoke outstanding keys, or let them expire,
before then.

**3. The `mpc-2p` co-signer adapter is removed.** Gone from the root:
`createMpc2pPolicyGatedSigner`, `Mpc2pCoSignAgent`, `Mpc2pSignerParams`, `Mpc2pStepOutcome`,
`CoSignConnection`, `CoSignTransport`, `CoSignRequestAuthenticator`, `CoSignFrame`,
`CoSignRequestEnvelope`, `canonicalRequestBytes`, `toWireIntent`, `WIRE_VERSION`, `WireIntent`,
`CoSignUnavailableError`; and from `kawasekit/signer` only: `Mpc2pWireOptions`,
`MAX_FRAME_BYTES`. The `PolicyGatedSigner` seam, `createLocalPolicyGatedSigner`, the type-gate,
`EnforcementLevel` (including `"cryptographic"`) and `PolicyRejection` are **unchanged**.
After this release no adapter at a non-bypassable level ships in this package;
`docs/THREAT_MODEL.md` 5.2 says so plainly.
**Migration:** stay on 0.10.x if you depend on the adapter, or implement `PolicyGatedSigner`
yourself.

See `docs/rfc/0005-settlement-payments.md`.
