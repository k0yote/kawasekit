/**
 * The idempotency store abstraction + the default in-memory implementation
 * (M5-1).
 *
 * The store is an **injected** dependency (mirroring how `Facilitator` / `hooks`
 * are injected), never a module global — kawasekit holds no ambient state. The
 * default {@link createInMemoryIdempotencyStore} is single-process; durable /
 * cross-replica backends (Redis, SQL) are operator territory, shipped as
 * optional-peer-dep adapters that implement this same interface.
 *
 * **Correctness vs. telemetry.** Unlike observability hooks (fire-and-forget),
 * store calls are correctness-relevant and are awaited; their errors are NOT
 * swallowed. Fund-correctness, however, never *depends* on the store — the
 * on-chain EIP-3009 nonce is the backstop — so a cold/missing store degrades
 * response replay, not safety.
 *
 * @packageDocumentation
 */

import { IdempotencyConfigError } from "./errors";
import type { IdempotencyRecord } from "./record";

/** A fence token proving ownership of an in-flight slot, carrying its expiry. */
export interface IdempotencyLease {
	readonly token: string;
	/** Unix-seconds; after this the lease is reclaimable as `fresh` (crash recovery). */
	readonly expiresAt: bigint;
}

/** The outcome of {@link IdempotencyStore.begin}. */
export type IdempotencyLookupResult =
	| { readonly status: "fresh"; readonly lease: IdempotencyLease }
	| { readonly status: "in_flight" }
	| { readonly status: "completed"; readonly record: IdempotencyRecord };

/**
 * Reasoning-step idempotency store. Implementations MUST make {@link begin}
 * atomic: a single caller wins the `fresh` lease; concurrent callers see
 * `in_flight`; an *expired* in-flight lease is reclaimable as `fresh` so a
 * crashed holder cannot strand a key forever.
 */
export interface IdempotencyStore {
	/** Atomically lease a fresh slot, or report in-flight / completed. */
	begin(key: string): Promise<IdempotencyLookupResult>;
	/** Extend an owned lease while a settlement runs long. Rejects if the lease was lost. */
	renew(key: string, lease: IdempotencyLease): Promise<IdempotencyLease>;
	/** Persist the completed record (no-op if the lease was reclaimed/superseded). */
	complete(key: string, record: IdempotencyRecord, lease: IdempotencyLease): Promise<void>;
	/** Release an owned in-flight slot so the step can be retried (idempotent). */
	abandon(key: string, lease: IdempotencyLease): Promise<void>;
}

/** Parameters for {@link createInMemoryIdempotencyStore}. */
export interface CreateInMemoryIdempotencyStoreParams {
	/** LRU cap on retained entries (memory-DoS bound, T-I9). Default 10_000. */
	readonly maxEntries?: number;
	/** In-flight lease TTL in seconds (crash-recovery window, H3). Default 90. */
	readonly leaseTtlSeconds?: number;
	/** Unix-seconds clock (override for tests). */
	readonly now?: () => bigint;
	/** Lease-token source (override for tests). */
	readonly generateLeaseToken?: () => string;
	/** Suppress the one-time single-process warning (default emits it). */
	readonly warnOnConstruct?: boolean;
}

type Entry =
	| { readonly state: "in_flight"; readonly lease: IdempotencyLease }
	| { readonly state: "completed"; readonly record: IdempotencyRecord };

function entryExpiry(entry: Entry): bigint {
	return entry.state === "in_flight" ? entry.lease.expiresAt : entry.record.expiresAt;
}

function defaultNow(): bigint {
	return BigInt(Math.floor(Date.now() / 1000));
}

function defaultLeaseToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let warnedSingleProcess = false;

function warnSingleProcessOnce(): void {
	if (warnedSingleProcess) {
		return;
	}
	warnedSingleProcess = true;
	if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
		process.emitWarning(
			"createInMemoryIdempotencyStore: in-memory dedup is single-process and does NOT " +
				"deduplicate across replicas. Multi-replica deployments require a shared store " +
				"(Redis/SQL adapter) or the client-side derived nonce for the guarantee.",
			{ type: "Warning", code: "KAWASEKIT_IDEMPOTENCY_001" },
		);
	}
}

/**
 * In-memory, single-process idempotency store: a bounded LRU with a leased
 * in-flight state machine and lazy TTL eviction. The default the SDK ships;
 * safe for one process, NOT for multiple replicas (see the construct-time
 * warning).
 *
 * @example
 * ```ts
 * import { createInMemoryIdempotencyStore } from "kawasekit/idempotency";
 *
 * const store = createInMemoryIdempotencyStore({ maxEntries: 50_000 });
 * const result = await store.begin(key);
 * if (result.status === "completed") {
 *   // replay result.record
 * }
 * ```
 */
export function createInMemoryIdempotencyStore(
	params: CreateInMemoryIdempotencyStoreParams = {},
): IdempotencyStore {
	const maxEntries = params.maxEntries ?? 10_000;
	if (!Number.isInteger(maxEntries) || maxEntries < 1) {
		throw new IdempotencyConfigError("maxEntries", "must be a positive integer");
	}
	const leaseTtlSeconds = params.leaseTtlSeconds ?? 90;
	if (!Number.isInteger(leaseTtlSeconds) || leaseTtlSeconds < 1) {
		throw new IdempotencyConfigError("leaseTtlSeconds", "must be a positive integer");
	}
	const now = params.now ?? defaultNow;
	const mintToken = params.generateLeaseToken ?? defaultLeaseToken;

	if (params.warnOnConstruct !== false) {
		warnSingleProcessOnce();
	}

	// Map preserves insertion order; we delete+set on access to move the entry
	// to the tail, so the head is always the least-recently-used.
	const entries = new Map<string, Entry>();

	/** Read an entry, treating an expired one as absent (and evicting it). */
	function live(key: string): Entry | undefined {
		const entry = entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (entryExpiry(entry) <= now()) {
			entries.delete(key);
			return undefined;
		}
		// LRU touch.
		entries.delete(key);
		entries.set(key, entry);
		return entry;
	}

	function set(key: string, entry: Entry): void {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			entries.delete(oldest);
		}
	}

	return {
		async begin(key: string): Promise<IdempotencyLookupResult> {
			const entry = live(key);
			if (entry === undefined) {
				const lease: IdempotencyLease = {
					token: mintToken(),
					expiresAt: now() + BigInt(leaseTtlSeconds),
				};
				set(key, { state: "in_flight", lease });
				return { status: "fresh", lease };
			}
			if (entry.state === "completed") {
				return { status: "completed", record: entry.record };
			}
			return { status: "in_flight" };
		},

		async renew(key: string, lease: IdempotencyLease): Promise<IdempotencyLease> {
			const entry = live(key);
			if (entry === undefined || entry.state !== "in_flight" || entry.lease.token !== lease.token) {
				throw new IdempotencyConfigError(
					"lease",
					"renew called without an owned in-flight lease (lost or reclaimed)",
				);
			}
			const renewed: IdempotencyLease = {
				token: lease.token,
				expiresAt: now() + BigInt(leaseTtlSeconds),
			};
			set(key, { state: "in_flight", lease: renewed });
			return renewed;
		},

		async complete(key: string, record: IdempotencyRecord, lease: IdempotencyLease): Promise<void> {
			const entry = live(key);
			// Only the lease holder may write. If the lease was reclaimed (expired)
			// or another holder superseded it, do NOT clobber — fund-correctness is
			// guaranteed on-chain regardless; this only affects response replay.
			if (entry === undefined || entry.state !== "in_flight" || entry.lease.token !== lease.token) {
				return;
			}
			set(key, { state: "completed", record });
		},

		async abandon(key: string, lease: IdempotencyLease): Promise<void> {
			const entry = live(key);
			if (entry !== undefined && entry.state === "in_flight" && entry.lease.token === lease.token) {
				entries.delete(key);
			}
		},
	};
}
