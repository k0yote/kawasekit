/**
 * Pure unit tests for `revokeSessionKey`'s early-fail paths.
 *
 * The on-chain `uninstallValidation` UserOp path requires a bundler and a
 * deployed ZeroDev factory — not available on bare anvil. It is exercised in
 * `scripts/10-session-revoke.ts` (task 2.7) against Polygon Amoy.
 */

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { polygonAmoy } from "../chains";
import type { ConfiguredKernelClient } from "../client/transfer-jpyc";
import { KAWASEKIT_SESSION_ENVELOPE_VERSION, type KawasekitSessionEnvelope } from "./envelope";
import { SessionEnvelopeSignerMismatchError } from "./errors";
import { revokeSessionKey } from "./revoke";

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
