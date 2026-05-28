/**
 * Example-only PK provider abstraction.
 *
 * The kawasekit example used to read private keys directly from `process.env`,
 * which made the demo's posture indistinguishable from a production posture
 * to a new integrator copying the code. This module forces the integrator to
 * declare *which* posture they are in (URI scheme) and emits a loud runtime
 * warning whenever the demo posture (`env://`) is in use.
 *
 * This file lives in the example, NOT in `kawasekit/src/`. The SDK does not
 * ship a PK provider — key custody is the operator's responsibility (see
 * `docs/THREAT_MODEL.md` Threat 2.1 / 5.6).
 */

import type { Hex } from "viem";

export type PkProviderKind = "demo" | "production";

export interface PkProvider {
	readonly kind: PkProviderKind;
	readonly uri: string;
	/** Returns the 0x-prefixed 32-byte hex private key. May throw or block. */
	getPk(): Promise<Hex> | Hex;
}

function isHexPrivateKey(value: string): value is Hex {
	return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Build a PK provider from a scheme-prefixed URI.
 *
 * Supported schemes:
 *
 * - `env://VARNAME` — DEMO ONLY. Reads `process.env[VARNAME]`. Emits a loud
 *   `console.warn` on construction. Use for local Polygon Amoy demos.
 * - `kms://<resource>` — PRODUCTION posture. **Not implemented in this example.**
 *   Throws on construction with a pointer to the docs that explain how to
 *   wire a KMS-backed provider (AWS KMS, GCP KMS, HashiCorp Vault, etc.).
 *
 * Any other scheme throws synchronously.
 *
 * @example
 * ```ts
 * const provider = createPkProvider(
 *   process.env.FACILITATOR_PK_URI ?? "env://X402_FACILITATOR_PRIVATE_KEY",
 * );
 * const pk = await provider.getPk();
 * const account = privateKeyToAccount(pk, { nonceManager });
 * ```
 */
export function createPkProvider(uri: string): PkProvider {
	if (uri === "" || !uri.includes("://")) {
		throw new Error(
			`createPkProvider: expected a scheme-prefixed URI like "env://VARNAME" or "kms://...", got ${JSON.stringify(uri)}.`,
		);
	}

	const [scheme, rest] = splitUri(uri);

	if (scheme === "env") {
		return makeEnvProvider(uri, rest);
	}
	if (scheme === "kms") {
		return makeKmsProvider(uri, rest);
	}
	throw new Error(
		`createPkProvider: unsupported scheme ${JSON.stringify(scheme)}. ` +
			`Supported schemes: "env://VARNAME" (demo), "kms://..." (production).`,
	);
}

function splitUri(uri: string): readonly [string, string] {
	const idx = uri.indexOf("://");
	const scheme = uri.slice(0, idx);
	const rest = uri.slice(idx + 3);
	return [scheme, rest];
}

function makeEnvProvider(uri: string, varName: string): PkProvider {
	if (varName === "") {
		throw new Error(
			`createPkProvider: "env://" requires a variable name, got ${JSON.stringify(uri)}.`,
		);
	}

	// Loud, idempotent demo warning. Stays loud even if a downstream logger
	// is configured — we go straight to console.warn so the operator sees it
	// regardless of their logging setup.
	console.warn(
		"⚠️  kawasekit example is using env:// PK provider " +
			`(${uri}). DO NOT USE IN PRODUCTION. ` +
			"Replace with kms://<resource> and a real KMS-backed implementation.",
	);

	return {
		kind: "demo",
		uri,
		getPk: () => {
			const value = process.env[varName];
			if (value === undefined || value.trim() === "") {
				throw new Error(
					`createPkProvider(env://${varName}): env var is missing or empty. ` +
						"Copy .env.example to .env and set the value.",
				);
			}
			if (!isHexPrivateKey(value)) {
				throw new Error(
					`createPkProvider(env://${varName}): expected a 0x-prefixed 32-byte hex string.`,
				);
			}
			return value;
		},
	};
}

function makeKmsProvider(uri: string, resource: string): PkProvider {
	if (resource === "") {
		throw new Error(
			`createPkProvider: "kms://" requires a resource identifier, got ${JSON.stringify(uri)}.`,
		);
	}

	return {
		kind: "production",
		uri,
		getPk: () => {
			throw new Error(
				`createPkProvider(${uri}): the KMS provider is intentionally not bundled ` +
					"with this example. Integrate your KMS SDK here — AWS KMS, GCP Cloud KMS, " +
					"or HashiCorp Vault are the canonical paths. See " +
					"docs/recipes/kms-provider.md (planned) for the integration shape, and " +
					"docs/THREAT_MODEL.md Threat 2.1 / 5.6 for the security framing.",
			);
		},
	};
}
