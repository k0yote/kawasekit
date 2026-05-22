import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
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
