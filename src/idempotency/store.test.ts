import { getAddress } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyConfigError } from "./errors";
import type { IdempotencyRecord } from "./record";
import { KAWASEKIT_IDEMPOTENCY_RECORD_VERSION } from "./record";
import { createInMemoryIdempotencyStore, type IdempotencyStore } from "./store";

const PAYER = getAddress("0x2222222222222222222222222222222222222222");

function recordFor(key: string, expiresAt: bigint): IdempotencyRecord {
	return {
		kawasekitVersion: KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
		key,
		txHash: `0x${"33".repeat(32)}`,
		payer: PAYER,
		amount: "1",
		network: "eip155:80002",
		expiresAt,
	};
}

describe("createInMemoryIdempotencyStore", () => {
	let clock: bigint;
	let tokenSeq: number;
	let store: IdempotencyStore;

	beforeEach(() => {
		clock = 1000n;
		tokenSeq = 0;
		store = createInMemoryIdempotencyStore({
			leaseTtlSeconds: 90,
			now: () => clock,
			generateLeaseToken: () => `t${tokenSeq++}`,
			warnOnConstruct: false,
		});
	});

	it("leases a fresh slot, reports in_flight to a concurrent caller, then completed", async () => {
		const first = await store.begin("k");
		expect(first.status).toBe("fresh");

		const concurrent = await store.begin("k");
		expect(concurrent.status).toBe("in_flight");

		if (first.status !== "fresh") throw new Error("unreachable");
		const record = recordFor("k", clock + 300n);
		await store.complete("k", record, first.lease);

		const replay = await store.begin("k");
		expect(replay.status).toBe("completed");
		if (replay.status !== "completed") throw new Error("unreachable");
		expect(replay.record).toEqual(record);
	});

	it("abandon releases an in-flight slot so the step can retry", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		await store.abandon("k", first.lease);

		const retry = await store.begin("k");
		expect(retry.status).toBe("fresh");
	});

	it("reclaims an EXPIRED in-flight lease as fresh (crash recovery, H3)", async () => {
		const first = await store.begin("k");
		expect(first.status).toBe("fresh");
		// Holder "crashes": never completes. Advance past the lease TTL.
		clock += 91n;
		const reclaimed = await store.begin("k");
		expect(reclaimed.status).toBe("fresh");
	});

	it("expires a completed record after expiresAt", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		await store.complete("k", recordFor("k", clock + 100n), first.lease);
		expect((await store.begin("k")).status).toBe("completed");
		clock += 101n;
		expect((await store.begin("k")).status).toBe("fresh");
	});

	it("does NOT clobber when complete is called with a lost/reclaimed lease", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		clock += 91n; // first lease expires
		const second = await store.begin("k"); // a new holder takes over
		expect(second.status).toBe("fresh");
		// The dead holder tries to complete with its stale lease — must be ignored.
		await store.complete("k", recordFor("k", clock + 100n), first.lease);
		expect((await store.begin("k")).status).toBe("in_flight");
	});

	it("renew extends an owned lease and rejects a lost one", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		clock += 60n;
		const renewed = await store.renew("k", first.lease);
		expect(renewed.expiresAt).toBe(clock + 90n);
		// A bogus lease token is rejected.
		await expect(store.renew("k", { token: "bogus", expiresAt: 0n })).rejects.toBeInstanceOf(
			IdempotencyConfigError,
		);
	});

	it("evicts least-recently-used entries past maxEntries", async () => {
		const small = createInMemoryIdempotencyStore({
			maxEntries: 2,
			now: () => clock,
			generateLeaseToken: () => `t${tokenSeq++}`,
			warnOnConstruct: false,
		});
		const a = await small.begin("a");
		if (a.status !== "fresh") throw new Error("unreachable");
		await small.complete("a", recordFor("a", clock + 1000n), a.lease);
		const b = await small.begin("b");
		if (b.status !== "fresh") throw new Error("unreachable");
		await small.complete("b", recordFor("b", clock + 1000n), b.lease);
		// Touch "a" so "b" becomes LRU, then insert "c" → "b" is evicted.
		expect((await small.begin("a")).status).toBe("completed");
		await small.begin("c");
		// Assert the SURVIVOR before the evicted key: begin() is not a pure read —
		// a "fresh" result claims a new in-flight slot, which would itself evict.
		expect((await small.begin("a")).status).toBe("completed"); // survived
		expect((await small.begin("b")).status).toBe("fresh"); // was evicted
	});

	it("validates construction params", () => {
		expect(() => createInMemoryIdempotencyStore({ maxEntries: 0 })).toThrow(IdempotencyConfigError);
		expect(() => createInMemoryIdempotencyStore({ leaseTtlSeconds: 0 })).toThrow(
			IdempotencyConfigError,
		);
	});
});
