/**
 * Redis-backed {@link IdempotencyStore} — the cross-replica (Layer 3) durable
 * store for the reasoning-step idempotency layer (M5-1).
 *
 * **No Redis-client dependency.** This adapter is client-agnostic: you pass a
 * thin {@link IdempotencyRedisClient} (an `eval` shim over your own `ioredis` /
 * `node-redis` instance), so kawasekit never depends on a specific Redis client
 * and the operator owns the connection. Atomicity (the race-free `begin`) is
 * enforced **server-side in Redis via Lua `eval`**; expiry + crash recovery use
 * Redis-native TTL (`SET … EX`), so a dead lease holder's lock simply vanishes.
 *
 * Fund-correctness never depends on this store — the on-chain EIP-3009 nonce is
 * the backstop; a shared store only lifts *response replay* from single-process
 * to cross-replica.
 *
 * @example
 * ```ts
 * import { Redis } from "ioredis";
 * import { createRedisIdempotencyStore } from "kawasekit/idempotency/redis";
 *
 * const ioredis = new Redis(process.env.REDIS_URL);
 * const store = createRedisIdempotencyStore({
 *   client: {
 *     // ioredis: eval(script, numKeys, ...keys, ...args)
 *     eval: (script, keys, args) => ioredis.eval(script, keys.length, ...keys, ...args),
 *   },
 * });
 * // node-redis v4: eval: (script, keys, args) => client.eval(script, { keys, arguments: args })
 * ```
 *
 * @packageDocumentation
 */

import { IdempotencyConfigError } from "../errors";
import {
	type IdempotencyRecord,
	parseIdempotencyRecord,
	serializeIdempotencyRecord,
} from "../record";
import type { IdempotencyLease, IdempotencyLookupResult, IdempotencyStore } from "../store";

/**
 * The minimal Redis surface this adapter needs: a single `eval` that runs a Lua
 * script with the given keys + string args and returns the reply. Adapt your
 * client's native `eval` to this shape (see the module example).
 *
 * NOTE: `eval` here is **Redis's server-side Lua `EVAL`** (the standard way to
 * run an atomic read-modify-write in Redis) — NOT JavaScript `eval()`. The only
 * scripts ever passed are the four hardcoded module constants below; no caller
 * input is ever interpreted as code, so there is no code-injection surface.
 */
export interface IdempotencyRedisClient {
	eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

/** Parameters for {@link createRedisIdempotencyStore}. */
export interface CreateRedisIdempotencyStoreParams {
	/** Your Redis client, adapted to {@link IdempotencyRedisClient}. */
	readonly client: IdempotencyRedisClient;
	/** Redis key namespace. Default `"kawasekit:idem"`. */
	readonly keyPrefix?: string;
	/** In-flight lease TTL in seconds (crash-recovery window). Default 90. */
	readonly leaseTtlSeconds?: number;
	/** Unix-seconds clock for the lease expiry value (override for tests). */
	readonly now?: () => bigint;
	/** Lease-token source (override for tests). */
	readonly generateLeaseToken?: () => string;
}

// --- Lua scripts (atomic, server-side). Each is tagged so a test double can
//     dispatch on it without importing the constants. ---

/** Atomic begin: completed? → replay; else acquire the lease (SET NX) → fresh / in_flight. */
const SCRIPT_BEGIN = `-- @kawasekit:begin
local done = redis.call('GET', KEYS[1])
if done then return {'completed', done} end
local ok = redis.call('SET', KEYS[2], ARGV[1], 'NX', 'EX', ARGV[2])
if ok then return {'fresh'} else return {'in_flight'} end`;

/** Token-guarded complete: only the lease holder may write the record + drop the lock. */
const SCRIPT_COMPLETE = `-- @kawasekit:complete
if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  redis.call('DEL', KEYS[2])
  return 1
end
return 0`;

/** Token-guarded renew: extend the lease TTL if still held. */
const SCRIPT_RENEW = `-- @kawasekit:renew
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/** Token-guarded abandon: release the lease if still held. */
const SCRIPT_ABANDON = `-- @kawasekit:abandon
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0`;

function defaultNow(): bigint {
	return BigInt(Math.floor(Date.now() / 1000));
}

function defaultLeaseToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}

function asNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

/**
 * Builds a cross-replica {@link IdempotencyStore} backed by Redis. Pass it to
 * `CreateX402HandlerParams.idempotency.store` so identical re-sent / concurrent
 * paid requests are deduplicated across *all* server replicas (not just one
 * process, as with the in-memory default).
 *
 * @example
 * ```ts
 * const handler = createX402Handler({
 *   facilitator,
 *   requirementsFor,
 *   handler: inner,
 *   idempotency: { store: createRedisIdempotencyStore({ client }) },
 * });
 * ```
 */
export function createRedisIdempotencyStore(
	params: CreateRedisIdempotencyStoreParams,
): IdempotencyStore {
	const { client } = params;
	const prefix = params.keyPrefix ?? "kawasekit:idem";
	const leaseTtlSeconds = params.leaseTtlSeconds ?? 90;
	if (!Number.isInteger(leaseTtlSeconds) || leaseTtlSeconds < 1) {
		throw new IdempotencyConfigError("leaseTtlSeconds", "must be a positive integer");
	}
	const now = params.now ?? defaultNow;
	const mintToken = params.generateLeaseToken ?? defaultLeaseToken;
	const doneKey = (key: string): string => `${prefix}:done:${key}`;
	const lockKey = (key: string): string => `${prefix}:lock:${key}`;

	return {
		async begin(key: string): Promise<IdempotencyLookupResult> {
			const token = mintToken();
			const reply = await client.eval(
				SCRIPT_BEGIN,
				[doneKey(key), lockKey(key)],
				[token, String(leaseTtlSeconds)],
			);
			const arr = Array.isArray(reply) ? reply : [];
			const status = arr.length > 0 ? asString(arr[0]) : "";
			if (status === "completed") {
				return { status: "completed", record: parseIdempotencyRecord(asString(arr[1])) };
			}
			if (status === "fresh") {
				const lease: IdempotencyLease = { token, expiresAt: now() + BigInt(leaseTtlSeconds) };
				return { status: "fresh", lease };
			}
			return { status: "in_flight" };
		},

		async renew(key: string, lease: IdempotencyLease): Promise<IdempotencyLease> {
			const reply = await client.eval(
				SCRIPT_RENEW,
				[lockKey(key)],
				[lease.token, String(leaseTtlSeconds)],
			);
			if (asNumber(reply) !== 1) {
				throw new IdempotencyConfigError(
					"lease",
					"renew called without an owned in-flight lease (lost or reclaimed)",
				);
			}
			return { token: lease.token, expiresAt: now() + BigInt(leaseTtlSeconds) };
		},

		async complete(key: string, record: IdempotencyRecord, lease: IdempotencyLease): Promise<void> {
			const nowSec = now();
			const ttlSeconds = record.expiresAt > nowSec ? record.expiresAt - nowSec : 1n;
			// Reply 1 = stored, 0 = lease lost/reclaimed → do NOT clobber (the
			// on-chain nonce backstops fund-correctness regardless). Best-effort.
			await client.eval(
				SCRIPT_COMPLETE,
				[doneKey(key), lockKey(key)],
				[lease.token, serializeIdempotencyRecord(record), ttlSeconds.toString()],
			);
		},

		async abandon(key: string, lease: IdempotencyLease): Promise<void> {
			await client.eval(SCRIPT_ABANDON, [lockKey(key)], [lease.token]);
		},
	};
}
