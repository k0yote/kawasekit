# RFC-0005 — Settlement payments: a payment that says what it is for

| | |
|---|---|
| **Status** | Implemented — `kawasekit` 0.11.0 |
| **Date** | 2026-09-22 |
| **Realizes** | `src/settlement/`, the 0.11.0 scope of `createBuyListPolicies` |
| **Breaking** | Yes (0.x minor). The buy-list scope changes; `callPolicyVersion` leaves `createBuyListPolicies`; the `mpc-2p` adapter is removed in the same release. |
| **Contract** | `Settlement` v1 — **unaudited**; Polygon Amoy `0x25BA7329A4c5772945B9d2C0E80ec7dfd41EE485` |

## 1. The problem

An ERC-20 `transfer` carries a recipient and an amount. It has nowhere to say what the payment
is for.

A service that sells things to agents has to answer "which order did this transfer pay?". Without
a reference field the usual answers are inferences: match on the amount (and make amounts unique
so the match is unambiguous), match on the sender, match on timing. Each of them puts the binding
between money and order somewhere other than the payment itself, and each of them has an edge
where two orders look alike.

The goal here is one thing: **for a single payment, make the movement of money and the order it
pays inseparable.**

## 2. The contract

```solidity
function pay(address token, address merchant, uint256 amount, uint64 validUntil, bytes32 details) external;
function orderRef(address token, address payer, address merchant, uint256 amount, uint64 validUntil, bytes32 details) external view returns (bytes32);
function settled(bytes32 ref) external view returns (bool);

event Settled(bytes32 indexed ref, address indexed payer, address indexed merchant, address token, uint256 amount);
error ZeroAmount(); error Expired(uint64 validUntil); error AlreadySettled(bytes32 ref);
```

`pay` pulls `amount` of `token` from the caller, forwards it to `merchant` **in the same call**,
and emits one `Settled`. `ref` is computed by the contract — never supplied — so a reference that
disagrees with the token, payer, merchant, amount or expiry actually used cannot exist.

- **One order, one payment.** A second `pay` of the same `ref` reverts. An agent's retry cannot
  pay twice.
- **An expired order cannot be paid.** Whoever issued the order can therefore abandon it safely.
- **The payer is part of the reference** (`msg.sender`), so only the named payer can settle an
  order, and nobody can mark someone else's order settled.
- **It holds nothing and answers to nobody.** No balance, no escrow, no owner, no admin, no upgrade
  path; it can move only the caller's funds, and only the amount it was told to. There is no party
  who could designate or change a destination.

A smart account pays with one UserOp carrying `[token.approve(Settlement, amount),
Settlement.pay(…)]`. The account's batch makes approve-and-pay a single atomic payment, and the
allowance — for exactly the amount — is consumed exactly. There is no batch function in the
contract: the account already has one.

It is deployed with CREATE2, so the address is the same on every chain. It cannot be upgraded: a
new version is a new address, and therefore a new release of this package.

## 3. The hashing rule

| hash | computed by | EIP-712 |
|---|---|---|
| `ref` | the contract | `hashTypedData` of `Order(address token,address payer,address merchant,uint256 amount,uint64 validUntil,bytes32 details)`, domain `KawasekitSettlement` / `1` / `chainId` / `verifyingContract` |
| `details` | off chain only | `hashStruct` of `OrderDetails(string orderId,OrderLine[] lines,bytes32 salt)` with `OrderLine(string itemId,uint256 unitPrice,uint32 quantity)` — no domain |

The contract never sees the pre-image of `details`: nothing readable about a purchase reaches the
chain, and the per-order `salt` keeps a small order from being guessed out of the hash. The domain
puts the chain and the deployment into every `ref`, so a reference cannot be replayed elsewhere.

Anyone holding an order's contents can check a payment without trusting whoever issued the order:
recompute `details`, recompute `ref`, look for `Settled(ref, …)`. That is why the rule is public.

`src/settlement/order-hash.ts` is the only place the rule lives in TypeScript. It is pinned against
the contract by a cross-language corpus (`src/settlement/__fixtures__/order-ref.vectors.json`):
nine cases, including non-ASCII ids, an empty line list and the integer maxima. `details` has no
on-chain implementation, so the contract repository carries a test-only Solidity reference for it —
otherwise the TypeScript implementation would be checked only against itself.

## 4. `settleOrder`

Follows `transferJpyc`: throws a typed input error, returns a result object
(`{ ref, userOpHash, transactionHash, success }`).

Three things are deliberately **not** parameters.

- **The payer.** The contract hashes `msg.sender`; a caller-supplied payer could make the returned
  `ref` — and any check against it — wrong without an error. It is the account's address.
- **The `Settlement` address and the token.** They come from this package's tables for the client's
  chain. An order's issuer may say which contract to pay; this function does not listen.

`expectedRef`, when given, is compared with the locally computed reference **before anything is
sent**; a difference throws `SettlementOrderRefMismatchError` (its own class, so a caller can branch
on it). It is what stops an agent paying for something other than what it agreed to, and an
unattended agent should always pass it.

**Retrying.** A retried order most likely surfaces as a *thrown* bundler error during gas
estimation (`AlreadySettled`), not as `success: false`. On any failure after submission, read
`settled(ref)`; `ref` is known before anything is sent.

`buildSettlementPaymentCalls` is exported so the two-call shape has one definition.

## 5. The session-key scope

`createBuyListPolicies` now yields a call policy with two permissions and a timestamp policy:

```
JPYC.approve(spender == Settlement, amount <= cap)
Settlement.pay(token == JPYC, merchant ONE_OF merchants, amount <= cap, validUntil any, details any)
```

`JPYC.transfer` is not in the scope. A buy-list key therefore cannot move JPYC except through
`Settlement`, so every yen it moves carries an order reference — and the chain guarantees that, not
this SDK.

Run on Polygon Amoy (2026-09-21) under exactly this scope, `CallPolicyVersion.V0_0_4`, default
`callType`: the batch validates and ZeroDev's paymaster sponsors it; an off-allowlist merchant, an
over-cap amount and an `approve` to another spender are refused with `CallViolatesParamRule()`; a
bare `JPYC.transfer` with `InvalidCallData()`; a second `pay` of one `ref` with
`AlreadySettled(ref)`; an expired order with `Expired(validUntil)`.

**`callPolicyVersion` is no longer an option here.** `V0_0_4` is the only version this scope has
been run against, and a security scope should not offer a knob nobody has exercised.

**What the policy does not bound.** It checks each call of a UserOp, not how many there are: a batch
carrying two `pay` calls **landed** in the same run. Total exposure is unchanged from a
transfer-scoped key — the account's balance, until the key expires — but "one payment per UserOp" is
not something this policy gives you. If you sponsor gas, enforce it in your sponsorship policy;
compare against `buildSettlementPaymentCalls`.

**How the scope is tested.** `toCallPolicy` is generic over one abi, so a two-function scope is
declared against the general `Abi` type and its argument conditions are not type-checked. The tests
decode `getPolicyData()` — the bytes the chain enforces — with the policy contract's own layout and
pin every rule to its function and argument. A first version asserted that the bytes *contain* the
padded `Settlement` address; that stays true when `approve`'s spender rule is dropped, because the
same word is `pay`'s target. That mutant survived, which is why the tests decode.

### Keys issued by ≤ 0.10.x

`revokeSessionKey` must be given the exact policies a key was issued with. The new builder cannot
produce the old bundle, so the 0.10.0 builder stays as `createLegacyTransferBuyListPolicies` —
deprecated, byte-identical (pinned against bytes captured from 0.10.0), **for revocation only**, and
removed in 0.12.0.

### Not changed

`KawasekitSessionPolicySummary` (the optional, caller-supplied, advisory summary inside a session
envelope) still has a daily-limit shape. It has not fitted buy-list keys since 0.10.0, it is never
populated by the SDK, and changing it is a wire-format change. Buy-list issuers omit it. A
discriminated summary is future work.

## 6. Deployments and chains

`settlementDeployments` lists every supported chain at the one CREATE2 address, with `isLive: true`
for **Polygon Amoy only**. `getSettlementAddress` refuses the rest: paying an address with no code
would not fail loudly, so the table has to. **The buy-list is therefore Amoy-only in 0.11.0, and
every further chain needs a release of this package.**

## 7. Gas

> Filled in from `pnpm m7:settlement-pay` on Polygon Amoy — two payments with one session key
> against two plain transfers under an equally-scoped key, so the comparison is steady state against
> steady state.

## 8. Status of the contract

**Unaudited.** Small (77 lines with NatSpec), with stateful invariant tests — no balance, exact
receipts, one payment per order, none after expiry — each mutation-checked. It must not carry third
parties' real value before an audit. Its source lives in a separate repository; the address above
is the deployment this package points at.
