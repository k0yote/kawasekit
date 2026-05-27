import { defineConfig } from "tsup";

export default defineConfig({
	// Use the object form so the output paths stay independent of the
	// common-ancestor heuristic tsup applies to array-form `entry`. When
	// `cli/index.ts` joined the entry list in M4-4, the implicit common
	// ancestor switched from `src/` to the repo root, which silently moved
	// every output file from `dist/x402/…` to `dist/src/x402/…` and broke
	// every `kawasekit` subpath export. Mapping `<output-key>: <src-path>`
	// fixes the layout to match `package.json#exports` exactly.
	entry: {
		index: "src/index.ts",
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
