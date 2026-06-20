/**
 * Pure unit tests for `revokeSessionKey`'s early-fail paths.
 *
 * The on-chain `uninstallValidation` UserOp path requires a bundler and a
 * deployed ZeroDev factory — not available on bare anvil. It is exercised in
 * `scripts/10-session-revoke.ts` (task 2.7) against Polygon Amoy.
 */

import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { polygonAmoy } from "../chains";
import type { ConfiguredKernelClient } from "../client/transfer-jpyc";
import { KAWASEKIT_SESSION_ENVELOPE_VERSION, type KawasekitSessionEnvelope } from "./envelope";
import { SessionEnvelopeSignerMismatchError } from "./errors";
import { buildRevokeSessionKeyCall, revokeSessionKey } from "./revoke";

const SESSION_KEY_PK =
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const STRANGER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const sessionKey = privateKeyToAccount(SESSION_KEY_PK);
const stranger = privateKeyToAccount(STRANGER_PK);

const SMART_ACCOUNT = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;

const ENVELOPE: KawasekitSessionEnvelope = {
	kawasekitVersion: KAWASEKIT_SESSION_ENVELOPE_VERSION,
	chainId: polygonAmoy.id,
	smartAccountAddress: SMART_ACCOUNT,
	sessionKeyAddress: sessionKey.address,
	serialized: "synthetic-opaque-blob",
};

function stubKernelClient(address: string): ConfiguredKernelClient {
	// Only `.account.address` and `.client` are read on the fail-fast paths.
	return {
		account: { address },
		client: undefined,
	} as unknown as ConfiguredKernelClient;
}

describe("revokeSessionKey — fail-fast invariants (no chain interaction)", () => {
	it("throws when invalidateInFlightNonces is requested (M4)", async () => {
		await expect(
			revokeSessionKey({
				ownerKernelClient: stubKernelClient(SMART_ACCOUNT),
				envelope: ENVELOPE,
				sessionKeySigner: sessionKey,
				policies: [],
				invalidateInFlightNonces: true,
			}),
		).rejects.toThrow(/invalidateInFlightNonces/);
	});

	it("rejects a session-key signer mismatch", async () => {
		await expect(
			revokeSessionKey({
				ownerKernelClient: stubKernelClient(SMART_ACCOUNT),
				envelope: ENVELOPE,
				sessionKeySigner: stranger,
				policies: [],
			}),
		).rejects.toBeInstanceOf(SessionEnvelopeSignerMismatchError);
	});

	it("rejects when ownerKernelClient.account.address does not match envelope.smartAccountAddress", async () => {
		await expect(
			revokeSessionKey({
				ownerKernelClient: stubKernelClient("0x0000000000000000000000000000000000000000"),
				envelope: ENVELOPE,
				sessionKeySigner: sessionKey,
				policies: [],
			}),
		).rejects.toThrow(/bound to .* but envelope is for/);
	});

	it("rejects when ownerKernelClient.client is undefined", async () => {
		await expect(
			revokeSessionKey({
				ownerKernelClient: stubKernelClient(SMART_ACCOUNT),
				envelope: ENVELOPE,
				sessionKeySigner: sessionKey,
				policies: [],
			}),
		).rejects.toThrow(/ownerKernelClient.client is undefined/);
	});
});

describe("buildRevokeSessionKeyCall — offline golden bytes", () => {
	// Fixed inputs → deterministic output (construction + getIdentifier/getEnableData
	// are offline-deterministic). Pins real vId + real deinitData, not just the selector.
	// Byte-faithfulness to the on-chain path is the Amoy gate; this is the regression pin.
	const SESSION_KEY = privateKeyToAccount(`0x${"11".repeat(32)}`);
	const ACCOUNT = `0x${"22".repeat(20)}` as const;
	// Regenerate if @zerodev/permissions or the kernel ABI changes the encoding:
	// the test IS the generator — log `data` from the assertion below and paste it here.
	const GOLDEN =
		"0xe6f3d50a02d8d6ee30000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000016000067b436caD8a6D025DF6C82C5BB43fbF11fC5B9B700000000000000000000000000000000000000000000000000000000000000000000000000000000002a00006A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

	it("reproduces the exact uninstallValidation call for fixed inputs", async () => {
		// `chain` set ⇒ toPermissionValidator skips its getChainId RPC ⇒ this stays offline.
		const pc = createPublicClient({ chain: polygonAmoy, transport: http() });
		const data = await buildRevokeSessionKeyCall({
			publicClient: pc,
			sessionKeySigner: SESSION_KEY,
			policies: [toSudoPolicy({})],
			smartAccountAddress: ACCOUNT,
			entryPoint: getEntryPoint("0.7"),
			kernelVersion: KERNEL_V3_1,
		});
		expect(data).toBe(GOLDEN);
		expect(data.slice(0, 10)).toBe("0xe6f3d50a"); // uninstallValidation(bytes21,bytes,bytes)
		expect(data.slice(10, 52)).toBe(`02d8d6ee30${"00".repeat(16)}`); // vId = PERMISSION ‖ pad(id,20)
	});
});
