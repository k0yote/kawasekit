/**
 * Offline seam units. These never reach `createKernelAccount` (which needs the
 * on-chain EntryPoint), so they run without a chain. The full owner-injection /
 * issuance path is proven on Amoy (design §6.2).
 */
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { polygonAmoy } from "../chains";
import { buildSessionPermissionValidator, resolveSudoValidator } from "./session-key";

const SK = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PC = createPublicClient({ chain: polygonAmoy, transport: http() });
const EP = getEntryPoint("0.7");

describe("buildSessionPermissionValidator — deterministic, offline", () => {
	it("derives a stable permission-validator identifier for fixed (signer, policies)", async () => {
		const pv = await buildSessionPermissionValidator({
			publicClient: PC,
			sessionKeySigner: SK,
			policies: [toSudoPolicy({})],
			entryPoint: EP,
			kernelVersion: KERNEL_V3_1,
		});
		// Golden identifier = the permission-validator id ZeroDev derives over
		// (sessionKeySigner 0x11..×32, [toSudoPolicy]). Deterministic + offline.
		// Regenerate if @zerodev/permissions changes its identifier hashing.
		expect(pv.getIdentifier()).toBe("0xd8d6ee30");
	});
});

describe("resolveSudoValidator — owner guard (no chain)", () => {
	it("throws when both ownerSigner and sudoValidator are passed", async () => {
		await expect(
			resolveSudoValidator({
				publicClient: PC,
				ownerSigner: SK,
				// biome-ignore lint/suspicious/noExplicitAny: a stand-in validator; the guard throws before it is used.
				sudoValidator: {} as any,
				entryPoint: EP,
				kernelVersion: KERNEL_V3_1,
			}),
		).rejects.toThrow(/exactly one/);
	});

	it("returns the injected sudoValidator unchanged (no chain access)", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: opaque stand-in; resolve returns it verbatim.
		const injected = { id: "fake-validator" } as any;
		await expect(
			resolveSudoValidator({
				publicClient: PC,
				sudoValidator: injected,
				entryPoint: EP,
				kernelVersion: KERNEL_V3_1,
			}),
		).resolves.toBe(injected);
	});
});
