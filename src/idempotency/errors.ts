/**
 * Typed errors for the reasoning-step idempotency layer (M5-1).
 *
 * Mirrors the kawasekit error convention: plain `extends Error`, a stable
 * `this.name`, public `readonly` discriminant fields, and an optional
 * `{ cause }` options bag forwarded to `super`. Consumers discriminate via
 * `instanceof`, never a string `.code`.
 *
 * @packageDocumentation
 */

/**
 * Thrown at construction / configuration time when an idempotency primitive is
 * wired up incorrectly (e.g. a non-positive LRU cap, an empty key). This is an
 * integrator bug, not an adversarial input — analogous to
 * {@link X402InvalidConfigError}.
 *
 * @example
 * ```ts
 * import { IdempotencyConfigError } from "kawasekit/idempotency";
 *
 * try {
 *   createInMemoryIdempotencyStore({ maxEntries: 0 });
 * } catch (err) {
 *   if (err instanceof IdempotencyConfigError) {
 *     console.error(err.field, err.reason);
 *   }
 * }
 * ```
 */
export class IdempotencyConfigError extends Error {
	readonly field: string;
	readonly reason: string;

	constructor(field: string, reason: string, options?: { cause?: unknown }) {
		super(`Invalid idempotency config (${field}): ${reason}`, options);
		this.name = "IdempotencyConfigError";
		this.field = field;
		this.reason = reason;
	}
}

/**
 * Thrown when {@link parseIdempotencyRecord} cannot decode a persisted record
 * (malformed JSON, missing/!mistyped field). Carries a machine-readable
 * `reason` and the underlying `cause` when available.
 *
 * @example
 * ```ts
 * import { IdempotencyRecordParseError, parseIdempotencyRecord } from "kawasekit/idempotency";
 *
 * try {
 *   parseIdempotencyRecord(rawFromRedis);
 * } catch (err) {
 *   if (err instanceof IdempotencyRecordParseError) {
 *     // drop the corrupt entry; treat the request as fresh
 *   }
 * }
 * ```
 */
export class IdempotencyRecordParseError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(`Failed to parse idempotency record: ${reason}`, options);
		this.name = "IdempotencyRecordParseError";
		this.reason = reason;
	}
}

/**
 * Thrown when a persisted record's `kawasekitVersion` does not match the
 * version this build understands. Distinct from a parse error so a forward /
 * backward migration can be detected and handled explicitly (the version is a
 * string so future variants like `"2"` do not break parser ordering).
 *
 * @example
 * ```ts
 * import { IdempotencyRecordVersionError } from "kawasekit/idempotency";
 * // expected "1", received "2" → caller decides to ignore or migrate
 * ```
 */
export class IdempotencyRecordVersionError extends Error {
	readonly expected: string;
	readonly received: unknown;

	constructor(expected: string, received: unknown) {
		super(
			`Unsupported idempotency record version: expected ${expected}, received ${JSON.stringify(received)}`,
		);
		this.name = "IdempotencyRecordVersionError";
		this.expected = expected;
		this.received = received;
	}
}
