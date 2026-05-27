import { describe, expect, it, vi } from "vitest";
import type { X402PaymentRequirements } from "../x402/types";
import { extractAcceptedNetworks, invokeHookSafely } from "./hooks";

describe("invokeHookSafely", () => {
	it("is a no-op when the hook is undefined", () => {
		expect(() => invokeHookSafely(undefined, { x: 1 })).not.toThrow();
	});

	it("invokes a sync hook with the given event", () => {
		const spy = vi.fn();
		invokeHookSafely(spy, { result: "success" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({ result: "success" });
	});

	it("swallows synchronous throws from the hook", () => {
		const spy = vi.fn(() => {
			throw new Error("hook bug");
		});
		expect(() => invokeHookSafely(spy, { x: 1 })).not.toThrow();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("swallows rejected promises from async hooks", async () => {
		const spy = vi.fn(async () => {
			throw new Error("async hook bug");
		});
		expect(() => invokeHookSafely(spy, { x: 1 })).not.toThrow();
		// Wait one microtask tick to let the rejection propagate, then ensure
		// no unhandledRejection was emitted (vitest would flag it otherwise).
		await new Promise((resolve) => setImmediate(resolve));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("fires-and-forgets async hooks (does not await the returned Promise)", () => {
		let resolved = false;
		const spy = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					setImmediate(() => {
						resolved = true;
						resolve();
					});
				}),
		);
		invokeHookSafely(spy, { x: 1 });
		// The hook has been called but the Promise is still pending — the
		// synchronous invokeHookSafely returned without waiting.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(resolved).toBe(false);
	});
});

describe("extractAcceptedNetworks", () => {
	it("returns the network of each requirement in order", () => {
		const reqA: X402PaymentRequirements = {
			scheme: "exact",
			network: "eip155:80002",
			amount: "1000",
			asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
			payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
			maxTimeoutSeconds: 60,
			extra: { name: "JPY Coin", version: "1" },
		};
		const reqB: X402PaymentRequirements = { ...reqA, network: "eip155:137" };
		expect(extractAcceptedNetworks([reqA, reqB])).toEqual(["eip155:80002", "eip155:137"]);
	});

	it("returns an empty array when given an empty list", () => {
		expect(extractAcceptedNetworks([])).toEqual([]);
	});
});
