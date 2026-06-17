import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createSponsoredKernelClient } from "../src/client/sponsored-kernel-client";

// Mock the two @zerodev/sdk factories: the paymaster is a stub; the kernel-client
// factory ECHOES its args so the test can inspect exactly what the helper passed.
vi.mock("@zerodev/sdk", () => ({
	createZeroDevPaymasterClient: () => ({ sponsorUserOperation: async () => ({}) }),
	createKernelAccountClient: (args: Record<string, unknown>) => args,
}));

const fakeAccount = { address: getAddress(`0x${"22".repeat(20)}`) } as unknown as Parameters<
	typeof createSponsoredKernelClient
>[0]["account"];
const chain = { id: 80002 } as unknown as Parameters<
	typeof createSponsoredKernelClient
>[0]["chain"];

describe("createSponsoredKernelClient wiring", () => {
	it("passes `client` only when publicClient is provided (exactOptionalPropertyTypes)", () => {
		const withPc = createSponsoredKernelClient({
			account: fakeAccount,
			chain,
			zerodevRpc: "https://rpc.example/x",
			publicClient: { id: "pc" } as never,
		}) as unknown as Record<string, unknown>;
		const withoutPc = createSponsoredKernelClient({
			account: fakeAccount,
			chain,
			zerodevRpc: "https://rpc.example/x",
		}) as unknown as Record<string, unknown>;
		expect("client" in withPc).toBe(true);
		expect("client" in withoutPc).toBe(false);
	});
});
