# kawasekit release verification (operator runbook)

Procedure the operator runs after every `kawasekit@<version>` publish to
confirm the artifact on npmjs.org actually works. Tracks the
`pnpm pack --dry-run` invariants from M4-6 plus the dual ESM/CJS resolution
checks added after the M4-6 tsup bug.

Run this from a **clean tmp dir** so workspace symlinks do not mask
resolution bugs.

## 1. Clean-room dependency install

```bash
cd /tmp
rm -rf kawasekit-verify
mkdir kawasekit-verify
cd kawasekit-verify
npm init -y >/dev/null

# Use the explicit version under test. For an alpha/beta release the
# `latest` tag still points at the placeholder.
npm install kawasekit@0.1.0-alpha.0
```

Expected output: install succeeds, `node_modules/kawasekit/dist/` exists,
no errors about missing files.

## 2. CJS resolution — main entry + every subpath

```bash
node -e "const k = require('kawasekit');           console.log('root', Object.keys(k).length)"
node -e "const k = require('kawasekit/x402');      console.log('x402', Object.keys(k).length)"
node -e "const k = require('kawasekit/x402/hono'); console.log('hono', Object.keys(k).length)"
node -e "const k = require('kawasekit/session');   console.log('session', Object.keys(k).length)"
node -e "const k = require('kawasekit/observability'); console.log('obs', Object.keys(k).length)"
```

Expected baseline counts (at 0.1.0-alpha.0):

| Subpath                                | Exports |
|----------------------------------------|---------|
| `kawasekit`                            | ~62     |
| `kawasekit/x402`                       | ~25     |
| `kawasekit/x402/hono`                  | ~3      |
| `kawasekit/session`                    | ~11     |
| `kawasekit/observability`              | ~5      |

If any of these emit `Cannot find module 'kawasekit/.../dist/...'`, the
publish is broken and the operator should `npm unpublish` (within 72 h
of publish) or `deprecate`.

## 3. Optional peer dependency subpaths

`kawasekit/observability/prometheus` and `kawasekit/observability/otlp`
intentionally fail without their peer dep. Install the peers first, then
verify:

```bash
npm install prom-client @opentelemetry/api
node -e "const k = require('kawasekit/observability/prometheus'); console.log('prom', Object.keys(k))"
node -e "const k = require('kawasekit/observability/otlp');       console.log('otlp', Object.keys(k))"
```

Expected: `prom` and `otlp` each export `createPrometheusMetrics` /
`createOTLPMetrics` respectively.

If the operator skips installing the peer and tries to require the
subpath directly, the expected error is
`Error: Cannot find module 'prom-client'` (or `@opentelemetry/api`) —
that is the design (optional peer dep). Not a bug.

## 4. ESM resolution

```bash
node --input-type=module -e "import { polygonAmoy, createHttpFacilitator } from 'kawasekit'; console.log(polygonAmoy.id, typeof createHttpFacilitator)"
```

Expected: `80002 function`.

## 5. CLI binary

```bash
# Without -g; the CLI was installed locally into ./node_modules/.bin
./node_modules/.bin/kawasekit --help
./node_modules/.bin/kawasekit account create --help
```

Expected: help text printed, exit 0.

## 6. Deprecation aliases (post-M4-7)

The `createCoinbaseFacilitator` → `createHttpFacilitator` rename ships
both names. Verify the alias still works AND that the deprecation
warning fires:

```bash
node -e "
process.on('warning', w => console.error('WARN:', w.code, w.message.slice(0, 80)));
const { createCoinbaseFacilitator } = require('kawasekit');
console.log(typeof createCoinbaseFacilitator);
const facilitator = createCoinbaseFacilitator({ baseUrl: 'http://localhost:9999' });
console.log('alias-call OK');
"
```

Expected: `function`, then `WARN: KAWASEKIT_DEP_001 createCoinbaseFacilitator() is deprecated …`,
then `alias-call OK`.

The warning fires once per process even across multiple calls.

## 7. Provenance attestation

The npm registry surface should show the package was built by GitHub
Actions with OIDC-signed provenance:

```bash
npm view kawasekit@<version> --json | jq '.dist.attestations'
```

Expected (excerpt):

```json
{
  "url": "https://registry.npmjs.org/-/npm/v1/attestations/kawasekit@<version>",
  "provenance": {
    "predicateType": "https://slsa.dev/provenance/v1"
  }
}
```

If `attestations` is `null` or missing, the publish ran without
provenance — re-publish via the workflow, not from a developer machine.

## 8. examples walkthrough — the DoD check

The M4 plan's Definition of Done includes:

> `pnpm add kawasekit@0.1.0` した clean-room 環境で `examples/agent-x402-jpyc/`
> の手順が完走する

To run that check against the published artifact (not the workspace
symlink), copy the example's source into the verify dir and rewrite the
`"kawasekit": "workspace:*"` dep to `"kawasekit": "0.1.0-alpha.0"`:

```bash
# from /tmp/kawasekit-verify
cp -r ../path/to/kawasekit/examples/agent-x402-jpyc ./example
cd example
# edit package.json: "kawasekit": "0.1.0-alpha.0"
pnpm install
cp .env.example .env  # fill the keys per the example README
pnpm dev:server &
pnpm dev:agent
```

A clean run should reproduce the Polygon Amoy paywall flow with the
published artifact rather than the workspace source.

## When to run this

- After every `0.1.0-alpha.N` publish (steps 1-7)
- After every `0.1.0-beta.N` publish (steps 1-8)
- Before promoting `0.1.0` to the `latest` dist-tag (steps 1-8, on a
  machine that has never seen kawasekit before)

## Common failure modes + fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module 'kawasekit/.../dist/<sub>'` | tsup output paths drifted from `package.json#exports` | revisit `tsup.config.ts` entry mapping (see M4-6 fix) |
| `attestations: null` from npm view | Workflow OIDC permissions missing | confirm `id-token: write` in `.github/workflows/release.yml` |
| Provenance present but `unverified` | Workflow ran on a fork PR (forks cannot mint OIDC) | re-publish from the canonical repo's `main` |
| `Cannot find module 'prom-client'` (when intended) | Operator forgot to install the optional peer | `npm install prom-client` |
| `--tag latest` was used by mistake | npm config bias or operator typo | `npm dist-tag rm kawasekit latest && npm dist-tag add kawasekit@0.0.1 latest` to restore the placeholder, then re-publish under `--tag alpha` |
