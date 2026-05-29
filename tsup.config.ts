import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inject the package version at build time so the CLI's `--version` always
// matches package.json without a hardcoded literal drifting out of sync.
// esbuild's `define` replaces the `__KAWASEKIT_VERSION__` identifier with the
// string below; `cli/index.ts` declares it as `const` for typecheck.
const { version } = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
	define: { __KAWASEKIT_VERSION__: JSON.stringify(version) },
	// Use the object form so the output paths stay independent of the
	// common-ancestor heuristic tsup applies to array-form `entry`. When
	// `cli/index.ts` joined the entry list in M4-4, the implicit common
	// ancestor switched from `src/` to the repo root, which silently moved
	// every output file from `dist/x402/…` to `dist/src/x402/…` and broke
	// every `kawasekit` subpath export. Mapping `<output-key>: <src-path>`
	// fixes the layout to match `package.json#exports` exactly.
	entry: {
		index: "src/index.ts",
		"idempotency/index": "src/idempotency/index.ts",
		"x402/index": "src/x402/index.ts",
		"x402/hono/index": "src/x402/hono/index.ts",
		"session/index": "src/session/index.ts",
		"observability/index": "src/observability/index.ts",
		"observability/prometheus/index": "src/observability/prometheus/index.ts",
		"observability/otlp/index": "src/observability/otlp/index.ts",
		"cli/index": "cli/index.ts",
	},
	format: ["esm", "cjs"],
	// Build-only tsconfig — see tsconfig.build.json for why it is separate.
	tsconfig: "tsconfig.build.json",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	target: "node22",
	outDir: "dist",
});
