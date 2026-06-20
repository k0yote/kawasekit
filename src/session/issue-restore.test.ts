/**
 * Pure unit tests for the issue/restore fail-fast paths.
 *
 * Why not anvil here: `issueSessionKey` and `restoreSessionAccount` both
 * eventually call into ZeroDev's `createKernelAccount`, which queries the
 * canonical ERC-4337 EntryPoint v0.7 contract on chain. Bare anvil does not
 * pre-deploy the EntryPoint or ZeroDev's factories, so any code path that
 * touches `createKernelAccount` fails with `InvalidEntryPointError` long
 * before any kawasekit logic runs.
 *
 * The full issue → restore round-trip is exercised against the real
 * Polygon Amoy deployment in `scripts/09-session-issue-restore.ts` (task 2.7).
 * Here we cover only the kawasekit-layer invariants — version, chain ID,
 * signer-address — by passing synthetic envelopes that never reach the
 * ZeroDev deserialiser.
 */

import { toSudoPolicy } from "@zerodev/permissions/policies";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { polygonAmoy } from "../chains";
import { KAWASEKIT_SESSION_ENVELOPE_VERSION, type KawasekitSessionEnvelope } from "./envelope";
import {
	SessionEnvelopeChainMismatchError,
	SessionEnvelopeSignerMismatchError,
	SessionEnvelopeVersionError,
} from "./errors";
import { issueSessionKey } from "./issue";
import { restoreSessionAccount } from "./restore";

const SESSION_KEY_PK =
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const STRANGER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const sessionKey = privateKeyToAccount(SESSION_KEY_PK);
const stranger = privateKeyToAccount(STRANGER_PK);

const amoyPublicClient = createPublicClient({
	chain: polygonAmoy,
	transport: http("https://invalid-do-not-call.local"),
});

const GOOD_ENVELOPE: KawasekitSessionEnvelope = {
	kawasekitVersion: KAWASEKIT_SESSION_ENVELOPE_VERSION,
	chainId: polygonAmoy.id,
	smartAccountAddress: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	sessionKeyAddress: sessionKey.address,
	serialized: "synthetic-opaque-blob",
};

describe("restoreSessionAccount — fail-fast invariants (no chain interaction)", () => {
	it("rejects a wrong kawasekitVersion before touching the deserialiser", async () => {
		const tampered: KawasekitSessionEnvelope = {
			...GOOD_ENVELOPE,
			kawasekitVersion: "2" as never,
		};
		await expect(
			restoreSessionAccount({
				publicClient: amoyPublicClient,
				envelope: tampered,
				sessionKeySigner: sessionKey,
			}),
		).rejects.toBeInstanceOf(SessionEnvelopeVersionError);
	});

	it("rejects a chain mismatch (envelope chainId != publicClient chainId)", async () => {
		const wrongChain: KawasekitSessionEnvelope = {
			...GOOD_ENVELOPE,
			chainId: 137, // Polygon mainnet, mismatching the Amoy publicClient
		};
		await expect(
			restoreSessionAccount({
				publicClient: amoyPublicClient,
				envelope: wrongChain,
				sessionKeySigner: sessionKey,
			}),
		).rejects.toBeInstanceOf(SessionEnvelopeChainMismatchError);
	});

	it("rejects a session-key signer mismatch", async () => {
		await expect(
			restoreSessionAccount({
				publicClient: amoyPublicClient,
				envelope: GOOD_ENVELOPE,
				sessionKeySigner: stranger,
			}),
		).rejects.toBeInstanceOf(SessionEnvelopeSignerMismatchError);
	});

	it("SessionEnvelopeChainMismatchError carries both chainIds for diagnostics", async () => {
		const wrongChain: KawasekitSessionEnvelope = {
			...GOOD_ENVELOPE,
			chainId: 137,
		};
		try {
			await restoreSessionAccount({
				publicClient: amoyPublicClient,
				envelope: wrongChain,
				sessionKeySigner: sessionKey,
			});
			expect.fail("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionEnvelopeChainMismatchError);
			const err = error as SessionEnvelopeChainMismatchError;
			expect(err.envelopeChainId).toBe(137);
			expect(err.clientChainId).toBe(polygonAmoy.id);
		}
	});

	it("SessionEnvelopeSignerMismatchError carries both addresses for diagnostics", async () => {
		try {
			await restoreSessionAccount({
				publicClient: amoyPublicClient,
				envelope: GOOD_ENVELOPE,
				sessionKeySigner: stranger,
			});
			expect.fail("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionEnvelopeSignerMismatchError);
			const err = error as SessionEnvelopeSignerMismatchError;
			expect(err.envelopeSignerAddress.toLowerCase()).toBe(sessionKey.address.toLowerCase());
			expect(err.providedSignerAddress.toLowerCase()).toBe(stranger.address.toLowerCase());
		}
	});
});

describe("issueSessionKey — owner guard (no chain)", () => {
	const pc = createPublicClient({ chain: polygonAmoy, transport: http() });
	const sk = privateKeyToAccount(`0x${"11".repeat(32)}`);
	const owner = privateKeyToAccount(`0x${"33".repeat(32)}`);

	it("throws when both ownerSigner and sudoValidator are passed", async () => {
		await expect(
			issueSessionKey({
				publicClient: pc,
				ownerSigner: owner,
				sudoValidator: {},
				sessionKeySigner: sk,
				policies: [toSudoPolicy({})],
				// The airtight AgentOwner union forbids passing both arms at the type
				// level, which is exactly the illegal input the runtime guard must
				// reject — so we deliberately bypass the union (one cast) to reach it.
				// biome-ignore lint/suspicious/noExplicitAny: deliberate union violation to exercise the runtime guard.
			} as any),
		).rejects.toThrow(/exactly one/);
	});
});
