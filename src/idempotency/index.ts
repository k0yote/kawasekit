/**
 * kawasekit reasoning-step idempotency layer (M5-1).
 *
 * Public surface for the `kawasekit/idempotency` subpath: the key authority,
 * the persisted record, and the store abstraction + in-memory default. Re-exports
 * only — JSDoc lives on the declarations.
 *
 * @packageDocumentation
 */

export {
	IdempotencyConfigError,
	IdempotencyRecordParseError,
	IdempotencyRecordVersionError,
} from "./errors";
export {
	type CanonicalRequestIdentity,
	type CreateIdempotencyKeyBuilderParams,
	createIdempotencyKeyBuilder,
	deriveIdempotencyKey,
	type IdempotencyKeyBuilder,
	normalizeIntentText,
} from "./key";
export {
	type IdempotencyRecord,
	type IdempotencyResponseSnapshot,
	KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
	type KawasekitIdempotencyRecordVersion,
	parseIdempotencyRecord,
	serializeIdempotencyRecord,
} from "./record";
export {
	type CreateInMemoryIdempotencyStoreParams,
	createInMemoryIdempotencyStore,
	type IdempotencyLease,
	type IdempotencyLookupResult,
	type IdempotencyStore,
} from "./store";
