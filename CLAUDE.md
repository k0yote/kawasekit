# kawasekit

TypeScript SDK for stablecoin payments by AI agents. Japan-first, JPYC-native.

## Project Context

- **Status**: Pre-alpha, built in public, solo developer (k0yote)
- **Primary language**: TypeScript 5.x (strict, ESM-only)
- **Target users**: AI agent developers (TS/JS ecosystem)
- **License**: Apache-2.0
- **Website**: kawasekit.k0yote.dev (planned)
- **Contact**: kawasekit@k0yote.dev

## Vision

Give AI agents a wallet that disappears.
Developers integrate the SDK, agents pay per-call in stablecoins (JPYC, USDC),
end users never see gas, mnemonics, or chains.

## Tech Stack (Locked Decisions)

| Layer | Choice | Notes |
|---|---|---|
| EVM client | **viem** | NOT ethers — always viem |
| AA SDK | **@zerodev/sdk** | Kernel v3.1, EntryPoint v0.7 |
| Validators | **@zerodev/ecdsa-validator**, **@zerodev/permissions** | session keys, policies |
| Build | **tsup** | dual ESM/CJS output |
| Package manager | **pnpm** | not npm, not yarn |
| Lint/Format | **Biome** | NOT prettier + eslint |
| Test | **Vitest** + **anvil** (from Foundry) | |
| Versioning | **Changesets** | |
| Smart contracts | **Foundry** (separate repo: `kawasekit-contracts`) | |

## Chain Priority

| Priority | Chain | Status | JPYC |
|---|---|---|---|
| 1 | Polygon (mainnet + Amoy testnet) | Live, primary target | ✅ Live |
| 2 | Kaia | Coming when JPYC launches there | 🚧 In development |
| 3 | Avalanche | Future | ✅ Live |
| 4 | Ethereum mainnet | Future (institutional use cases) | ✅ Live |

Do NOT add chains beyond this list without discussion.

## Domain Knowledge

### JPYC (the primary stablecoin)
- Japanese yen-pegged stablecoin
- Legally classified as 電子決済手段 (electronic payment instrument) under 改正資金決済法 (revised Payment Services Act)
- Issued by JPYC Inc., a registered Type II Fund Transfer Service Provider
- Live chains (as of 2026-05): Ethereum, Polygon, Avalanche
- Kaia support: in active development (Q2-Q3 2026)
- 1 JPYC = 1 JPY (always)
- Supports EIP-3009 (transferWithAuthorization) for gasless transfers

### Standards in use
- **ERC-4337 v0.7**: Account Abstraction. EntryPoint at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
- **ERC-7579**: Modular smart accounts (target for v0.2+)
- **EIP-3009**: `transferWithAuthorization` for gasless ERC-20 transfers
- **ERC-2612**: `permit` for gasless approvals
- **EIP-712**: Typed data signing
- **x402**: HTTP 402 Payment Required protocol (Coinbase, target for v0.2+)

### Kernel (ZeroDev's smart account)
- Version: v3.1
- Validator architecture: pluggable
- Default: ECDSA Validator (single signer)
- Future: Session Key Validator, Permission Validator

## Coding Conventions

### TypeScript
- Strict mode: ALL strict flags on
- No `any` (use `unknown` and narrow)
- No `as` casts without a comment explaining why
- All public APIs use **named exports** (no default exports)
- All public APIs have JSDoc with at least one `@example`
- Error handling: typed result objects in public API, throws only in internal code

### File Conventions
- File names: `kebab-case.ts`
- Test files: `*.test.ts` colocated with source
- No barrel files (`index.ts` re-exports) except at package root

### Logging
- NEVER `console.log` in `src/`
- Use the internal logger module (to be created)
- Never log secrets, private keys, mnemonics, or full signatures

### Async
- Always `async/await`, never raw promises chained
- Always handle errors explicitly

## Architectural Constraints

- **No prepaid funds custody**: kawasekit must NEVER hold user funds.
  Smart accounts are user-owned. We are infrastructure, not a wallet provider.
  This is a regulatory safety boundary, not just a design choice.
- **No proprietary chain lock-in**: chain configs are data, not code branches
- **Pluggable AA implementation**: Kernel is the default, but abstract behind interfaces
- **Tree-shakeable**: importing one chain must not pull in all chains

## Don'ts

- ❌ Do NOT use `ethers.js` (use viem)
- ❌ Do NOT use `prettier` or `eslint` (use Biome)
- ❌ Do NOT use `jest` (use Vitest)
- ❌ Do NOT hardcode contract addresses in business logic — they live in `src/chains/`
- ❌ Do NOT add prettier-style `;` and `'` (Biome handles this)
- ❌ Do NOT commit `.env`, only `.env.example`
- ❌ Do NOT hold user funds (architectural constraint, not a coding rule)
- ❌ Do NOT call mainnet from tests without explicit env var (`KAWASEKIT_ALLOW_MAINNET=1`)
- ❌ Do NOT add new top-level dependencies without discussing first
- ❌ Do NOT publish to npm without a changeset

## Repository Structure (v0.1)

```
src/
├── account/        # smart account creation, recovery
├── chains/         # chain configs (polygon, kaia, etc.)
│   ├── polygon.ts
│   ├── kaia.ts
│   └── index.ts
├── tokens/         # token configs, EIP-3009 helpers
│   ├── jpyc.ts
│   └── index.ts
├── policy/         # spending policy engine
├── paymaster/      # paymaster integrations
├── client/         # high-level KawaseClient class
├── logger/         # internal logger
├── errors/         # typed error classes
└── index.ts        # public API surface

scripts/            # standalone executable scripts (M1 tests, demos)
test/               # integration tests, not colocated
examples/           # in-repo example projects (M3)
```

## Workflow

- Branch: `main` (trunk-based, no long-lived branches)
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- PRs: solo dev for now, but follow PR template for future contributors
- Versioning: pnpm + changesets, manual release until M5
- CI: GitHub Actions — typecheck, test, build, lint

## Security Posture

- All AA flows must validate inputs (addresses, amounts, deadlines)
- Paymaster sponsorship rules must be explicit, no implicit allowance
- Replay protection: enforce nonce + deadline on all signed messages
- Dependencies: pin exact versions in production deps (no `^`)
- Secrets in `.env`, never in code, never in logs

## Roadmap Reference

- M1: Smart account creation on Polygon Amoy + paymaster
- M2: Spending policy MVP + JPYC transfer via EIP-3009 + x402 handler
- M3: CLI bootstrap + docs site + 3 example integrations
- M4: Mainnet, observability, threat model, npm v0.1 release
- M5: Outreach, first real integration, community
- M6: Managed service alpha, Rust policy engine experiment

## Reference Links

- ZeroDev v3 docs: https://docs.zerodev.app/
- viem docs: https://viem.sh/
- ERC-7579: https://erc7579.com/
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- JPYC: https://jpyc.jp/
- x402: https://www.x402.org/
- Polygon Amoy faucet: https://faucet.polygon.technology/

## Notes for Claude Code

- When adding new chain support, follow the pattern in `src/chains/polygon.ts`
- When ZeroDev SDK behavior is unclear, fetch the latest docs (don't rely on training data)
- When suggesting a new dependency, justify it in the PR description
- For Solidity work, switch context to the `kawasekit-contracts` repo (separate)
- Prefer Plan Mode for any change touching `src/account/`, `src/policy/`, or `src/paymaster/`
