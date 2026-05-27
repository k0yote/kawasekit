/**
 * Chain selection shared by every CLI command that touches a network.
 *
 * Every command accepts a `--chain` flag whose value is one of the
 * kawasekit chain keys (`polygon`, `polygonAmoy`). The string is mapped to
 * the corresponding `KawaseChain` and a `network: "mainnet" | "testnet"`
 * literal that the SDK's M4-1 fail-fast guards expect.
 *
 * No default — the CLI requires an explicit choice so a user cannot silently
 * point a testnet config at mainnet (or vice versa).
 */

import { polygon, polygonAmoy } from "../../src";
import { resolveValue } from "./env";

export type CliChainKey = "polygon" | "polygonAmoy";

export interface CliChainProfile {
	readonly key: CliChainKey;
	readonly chain: typeof polygon | typeof polygonAmoy;
	readonly network: "mainnet" | "testnet";
	readonly explorerTxBase: string;
	readonly displayName: string;
}

export function resolveChain(flagValue: string | undefined): CliChainProfile {
	const key = flagValue;
	if (key === "polygon") {
		return {
			key,
			chain: polygon,
			network: "mainnet",
			explorerTxBase: "https://polygonscan.com/tx/",
			displayName: "Polygon mainnet (137)",
		};
	}
	if (key === "polygonAmoy") {
		return {
			key,
			chain: polygonAmoy,
			network: "testnet",
			explorerTxBase: "https://amoy.polygonscan.com/tx/",
			displayName: "Polygon Amoy testnet (80002)",
		};
	}
	throw new Error(
		`--chain must be one of "polygon" (mainnet) or "polygonAmoy" (testnet). Got ${JSON.stringify(key ?? "<missing>")}.`,
	);
}

/**
 * Mainnet broadcast guard. Throws if the chosen chain is mainnet but the
 * operator has not explicitly set `KAWASEKIT_ALLOW_MAINNET=1`. CLI subcommands
 * that broadcast real-funds transactions MUST call this before any RPC work.
 */
export function assertMainnetGuard(profile: CliChainProfile): void {
	if (profile.network !== "mainnet") return;
	const gate = resolveValue(undefined, "KAWASEKIT_ALLOW_MAINNET");
	if (gate !== "1") {
		throw new Error(
			"Refusing to broadcast on Polygon mainnet without explicit consent. Set KAWASEKIT_ALLOW_MAINNET=1 to acknowledge that this command will spend real funds.",
		);
	}
}
