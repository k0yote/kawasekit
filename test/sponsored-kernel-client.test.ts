import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { sponsorWithObservability } from "../src/client/sponsored-kernel-client";

const ACCOUNT = getAddress(`0x${"11".repeat(20)}`);

describe("sponsorWithObservability", () => {
	it("fires onSponsor after a successful sponsorship and returns the data", async () => {
		const seen: string[] = [];
		const out = await sponsorWithObservability(
			() => Promise.resolve({ paymaster: "0xpm" }),
			ACCOUNT,
			{
				onSponsor: ({ account }) => seen.push(`sponsor:${account}`),
				onSponsorError: () => seen.push("error"),
			},
		);
		expect(out).toEqual({ paymaster: "0xpm" });
		expect(seen).toEqual([`sponsor:${ACCOUNT}`]);
	});

	it("fires onSponsorError and RE-THROWS the original error on a decline", async () => {
		const seen: string[] = [];
		const cause = new Error("paymaster declined");
		await expect(
			sponsorWithObservability(() => Promise.reject(cause), ACCOUNT, {
				onSponsorError: ({ account, error }) =>
					seen.push(`error:${account}:${(error as Error).message}`),
			}),
		).rejects.toBe(cause);
		expect(seen).toEqual([`error:${ACCOUNT}:paymaster declined`]);
	});

	it("is safe with no observability (resolves, no throw from missing hooks)", async () => {
		await expect(
			sponsorWithObservability(() => Promise.resolve(1), ACCOUNT, undefined),
		).resolves.toBe(1);
	});

	it("a throwing hook never breaks the flow (invokeHookSafely)", async () => {
		await expect(
			sponsorWithObservability(() => Promise.resolve(1), ACCOUNT, {
				onSponsor: () => {
					throw new Error("hook boom");
				},
			}),
		).resolves.toBe(1);
	});
});
