import { defineConfig } from "tsup";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/x402/index.ts",
		"src/x402/hono/index.ts",
		"src/session/index.ts",
		"src/observability/index.ts",
		"src/observability/prometheus/index.ts",
		"src/observability/otlp/index.ts",
	],
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
