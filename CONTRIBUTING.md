# Contributing to kawasekit

kawasekit is pre-alpha and currently developed by a solo maintainer, but
contributions are welcome. This guide keeps things minimal.

## Prerequisites

- **Node.js** 22 or newer
- **pnpm** 11+ (pinned via the `packageManager` field; `corepack` will fetch
  the right version automatically)

## Setup

```sh
pnpm install
cp .env.example .env   # fill in values if running scripts
```

## Development workflow

```sh
pnpm typecheck   # tsc --noEmit (strict)
pnpm lint        # Biome check
pnpm format      # Biome format --write
pnpm test        # Vitest
pnpm build       # tsup (ESM + CJS + types)
```

All of these must pass before a change is merged — CI runs them on Node 22
and 24.

## Conventions

- **Branching**: trunk-based. Work off `main`; no long-lived branches.
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat:`, `fix:`, `chore:`, `docs:`, etc.
- **Code style**: enforced by Biome. Do not hand-tune semicolons or quotes.
- **TypeScript**: strict mode, no `any`, named exports for public APIs, JSDoc
  with at least one `@example` on public APIs. See `CLAUDE.md` for the full
  set of conventions.

## Changesets

Any change that affects published behavior must include a changeset:

```sh
pnpm changeset
```

## Reporting security issues

Do not file public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
Apache-2.0 license.
