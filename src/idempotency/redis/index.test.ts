import { getAddress } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyConfigError } from "../errors";
import type { IdempotencyRecord } from "../record";
import { KAWASEKIT_IDEMPOTENCY_RECORD_VERSION } from "../record";
import type { IdempotencyStore } from "../store";
import { createRedisIdempotencyStore, type IdempotencyRedisClient } from "./index";

const PAYER = getAddress("0x4444444444444444444444444444444444444444");

function recordFor(key: string, expiresAt: bigint): IdempotencyRecord {
	return {
		kawasekitVersion: KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
		key,
		txHash: `0x${"55".repeat(32)}`,
		payer: PAYER,
		amount: "1",
		network: "eip155:80002",
		expiresAt,
	};
}

/**
 * Faithful in-memory simulation of the four Lua scripts (dispatched by their
 * `-- @kawasekit:*` tag) over a Map with an injectable clock. Verifies the store
 * logic + the scripts' intended semantics; the Lua itself is best verified
 * against a real Redis (an optional REDIS_URL-guarded integration test).
 */
class FakeRedis implements IdempotencyRedisClient {
	private readonly store = new Map<string, { value: string; expireAt: number }>();
	constructor(private readonly nowSec: () => number) {}

	private live(k: string): string | null {
		const e = this.store.get(k);
		if (e === undefined) {
			return null;
		}
		if (e.expireAt <= this.nowSec()) {
			this.store.delete(k);
			return null;
		}
		return e.value;
	}

	async eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
		const k0 = keys[0] ?? "";
		const k1 = keys[1] ?? "";
		const a0 = args[0] ?? "";
		if (script.includes("@kawasekit:begin")) {
			const done = this.live(k0);
			if (done !== null) {
				return ["completed", done];
			}
			if (this.live(k1) === null) {
				this.store.set(k1, { value: a0, expireAt: this.nowSec() + Number(args[1]) });
				return ["fresh"];
			}
			return ["in_flight"];
		}
		if (script.includes("@kawasekit:complete")) {
			if (this.live(k1) === a0) {
				this.store.set(k0, { value: args[1] ?? "", expireAt: this.nowSec() + Number(args[2]) });
				this.store.delete(k1);
				return 1;
			}
			return 0;
		}
		if (script.includes("@kawasekit:renew")) {
			const e = this.store.get(k0);
			if (this.live(k0) === a0 && e !== undefined) {
				e.expireAt = this.nowSec() + Number(args[1]);
				return 1;
			}
			return 0;
		}
		if (script.includes("@kawasekit:abandon")) {
			if (this.live(k0) === a0) {
				this.store.delete(k0);
				return 1;
			}
			return 0;
		}
		throw new Error("FakeRedis: unknown script");
	}
}

describe("createRedisIdempotencyStore", () => {
	let clock: number;
	let tokenSeq: number;
	let redis: FakeRedis;
	let store: IdempotencyStore;

	beforeEach(() => {
		clock = 1000;
		tokenSeq = 0;
		redis = new FakeRedis(() => clock);
		store = createRedisIdempotencyStore({
			client: redis,
			leaseTtlSeconds: 90,
			now: () => BigInt(clock),
			generateLeaseToken: () => `t${tokenSeq++}`,
		});
	});

	it("fresh → in_flight (concurrent) → completed replay", async () => {
		const first = await store.begin("k");
		expect(first.status).toBe("fresh");
		expect((await store.begin("k")).status).toBe("in_flight");

		if (first.status !== "fresh") throw new Error("unreachable");
		const record = recordFor("k", BigInt(clock) + 300n);
		await store.complete("k", record, first.lease);

		const replay = await store.begin("k");
		expect(replay.status).toBe("completed");
		if (replay.status !== "completed") throw new Error("unreachable");
		expect(replay.record).toEqual(record);
	});

	it("abandon releases the lease for retry", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		await store.abandon("k", first.lease);
		expect((await store.begin("k")).status).toBe("fresh");
	});

	it("reclaims an expired lease as fresh (Redis TTL crash recovery)", async () => {
		expect((await store.begin("k")).status).toBe("fresh");
		clock += 91; // lease TTL elapsed
		expect((await store.begin("k")).status).toBe("fresh");
	});

	it("expires a completed record after its TTL", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		await store.complete("k", recordFor("k", BigInt(clock) + 100n), first.lease);
		expect((await store.begin("k")).status).toBe("completed");
		clock += 101;
		expect((await store.begin("k")).status).toBe("fresh");
	});

	it("does not clobber when complete is called with a reclaimed lease", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		clock += 91; // first lease expires
		const second = await store.begin("k"); // a new holder takes over
		expect(second.status).toBe("fresh");
		await store.complete("k", recordFor("k", BigInt(clock) + 100n), first.lease); // stale lease
		expect((await store.begin("k")).status).toBe("in_flight"); // not clobbered to completed
	});

	it("renew extends an owned lease and rejects a lost one", async () => {
		const first = await store.begin("k");
		if (first.status !== "fresh") throw new Error("unreachable");
		clock += 60;
		const renewed = await store.renew("k", first.lease);
		expect(renewed.expiresAt).toBe(BigInt(clock) + 90n);
		await expect(store.renew("k", { token: "bogus", expiresAt: 0n })).rejects.toBeInstanceOf(
			IdempotencyConfigError,
		);
	});

	it("validates leaseTtlSeconds at construction", () => {
		expect(() => createRedisIdempotencyStore({ client: redis, leaseTtlSeconds: 0 })).toThrow(
			IdempotencyConfigError,
		);
	});

	it("deduplicates across two store instances sharing one Redis (cross-replica)", async () => {
		// Two independent server replicas, same Redis backend.
		const replicaA = createRedisIdempotencyStore({ client: redis, now: () => BigInt(clock) });
		const replicaB = createRedisIdempotencyStore({ client: redis, now: () => BigInt(clock) });
		const a = await replicaA.begin("shared");
		expect(a.status).toBe("fresh");
		// Replica B sees the in-flight lease set by A — no double-settle.
		expect((await replicaB.begin("shared")).status).toBe("in_flight");

		if (a.status !== "fresh") throw new Error("unreachable");
		await replicaA.complete("shared", recordFor("shared", BigInt(clock) + 300n), a.lease);
		// Now B replays A's cached response.
		expect((await replicaB.begin("shared")).status).toBe("completed");
	});
});
