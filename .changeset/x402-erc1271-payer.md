---
"kawasekit": minor
---

feat(x402): a deployed smart account can pay on a token that checks ERC-1271 (#54)

USDC v2.2 (FiatToken) checks a payer that has code with ERC-1271 in `transferWithAuthorization`, so a
deployed smart account (e.g. ZeroDev Kernel v3.1) can pay through x402 when the facilitator settles
through the `bytes signature` overload. kawasekit could not sign such a payment: splitting the
signature into `(v, r, s)` threw `Invalid yParityOrV value` (Kernel's typed-data signature is 86
bytes). JPYC checks with `ecrecover` only, so nothing changes for JPYC payers.

**`signTransferWithAuthorization` / `signReceiveWithAuthorization` / `signCancelAuthorization`**

- A 65-byte signature still comes split into `v`, `r` and `s` (and still throws if its last byte is
  not a recovery id — 0, 1, 27 or 28). Any other length now comes whole in `signature`, with no
  `v` / `r` / `s` (it used to throw).
- **Type change — breaking for TypeScript code that reads `v` / `r` / `s`:**
  `SignedAuthorization<TMessage>` is now a union — `{ v: number; r: Hex; s: Hex }` or
  `{ v?: undefined; r?: undefined; s?: undefined }` alongside `signature` / `domain` / `message`.
  Reading `signed.v`, destructuring `const { v, r, s } = signed`, or passing them to a contract call
  now types them as possibly `undefined`; narrow first — `if (signed.v !== undefined)` settles all
  three. It is a type alias now, not an interface, so it can no longer be `extends`-ed. Code that only
  uses `signature`, `domain` or `message` is unaffected.

**`createX402PaymentSigner`** (the `account` and `signer` variants)

- The payer can be an EOA, or a deployed smart account on a token that checks ERC-1271. The smart
  account's signature is sent whole.
- Refused before anything is sent, with `X402InvalidPayloadError`: a signature that is not 65 bytes on
  an asset known to check with `ecrecover` only (JPYC — decided by address, so JPYC pinned through
  `unsafeOverride` counts too; pay JPYC from a smart account with `transferJpyc`). An asset kawasekit
  does not know is left to the facilitator. The check runs after signing (the signature's shape is
  what tells a smart account apart without an RPC call).
- An undeployed smart account's signature comes wrapped as ERC-6492 and is sent as it is: it settles
  only if the facilitator deploys the account first (the x402 reference facilitators do, for a
  factory listed in `eip6492AllowedFactories` — off by default). Otherwise deploy the account before
  paying.
- A smart account's owner signs the account's own wrapper of the hash (for Kernel v3.1,
  `Kernel(bytes32 hash)`), so a browser wallet that owns the account shows an opaque hash — neither
  the payee nor the amount.

**`createSelfFacilitator`**

- Still EOA payers only. A signature that is not 65 bytes is now refused at verify as
  `invalid_exact_evm_payload_signature`, with a message that says so (was `unexpected_verify_error`).
