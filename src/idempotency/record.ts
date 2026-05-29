/**
 * The persisted idempotency record + its (de)serialization (M5-1).
 *
 * Follows the `session/envelope` convention: a bigint/`Address`-friendly PUBLIC
 * type and a SEPARATE private `…Json` wire shape with bigints as decimal
 * strings, validated on parse via small `assert*` helpers, output as plain
 * UTF-8 JSON. The string `kawasekitVersion` + dedicated `…VersionError` keep a
 * future schema bump a clean, typed migration.
 *
 * A record is dedup *metadata*, never funds — it stores enough to **replay** a
 * prior settlement (the on-chain `txHash` and an optional response snapshot),
 * not to move value.
 *
 * @packageDocumentation
 */

import { type Address, getAddress, type Hex } from "viem";
import { isX402Network, type X402Network } from "../x402/types";
import { IdempotencyRecordParseError, IdempotencyRecordVersionError } from "./errors";

/** Current idempotency-record schema version. String, so `"2"`, `"1-jwe"`, … never break parser ordering. */
export const KAWASEKIT_IDEMPOTENCY_RECORD_VERSION = "1" as const;

/** The schema version literal type. */
export type KawasekitIdempotencyRecordVersion = typeof KAWASEKIT_IDEMPOTENCY_RECORD_VERSION;

/**
 * A byte-faithful, credential-safe snapshot of the paid response, so a
 * duplicate request can be replayed without re-running settlement or the inner
 * handler. Headers are an allowlist captured by the server (hop-by-hop /
 * `Set-Cookie` / auth headers are stripped); the body is base64.
 */
export interface IdempotencyResponseSnapshot {
	readonly status: number;
	readonly headers: ReadonlyArray<readonly [string, string]>;
	readonly bodyBase64: string;
}

/**
 * A completed reasoning-step settlement, keyed by the idempotency key. Retained
 * until `expiresAt` (anchored to the authorization `validBefore`, never beyond).
 */
export interface IdempotencyRecord {
	readonly kawasekitVersion: KawasekitIdempotencyRecordVersion;
	/** The idempotency key this record is stored under. */
	readonly key: string;
	/** The on-chain settlement tx hash (replayed in the `PAYMENT-RESPONSE` header). */
	readonly txHash: Hex;
	/** The payer EOA recovered at settlement. */
	readonly payer: Address;
	/** Settled amount, decimal string (uint256-safe). */
	readonly amount: string;
	/** x402 network the settlement landed on. */
	readonly network: X402Network;
	/** Optional captured response for byte-identical replay. */
	readonly responseSnapshot?: IdempotencyResponseSnapshot;
	/** Unix-seconds expiry. The record MUST NOT outlive the authorization `validBefore`. */
	readonly expiresAt: bigint;
}

interface IdempotencyResponseSnapshotJson {
	readonly status: number;
	readonly headers: ReadonlyArray<readonly [string, string]>;
	readonly bodyBase64: string;
}

interface IdempotencyRecordJson {
	readonly kawasekitVersion: string;
	readonly key: string;
	readonly txHash: string;
	readonly payer: string;
	readonly amount: string;
	readonly network: string;
	readonly responseSnapshot?: IdempotencyResponseSnapshotJson;
	readonly expiresAt: string;
}

const UINT_DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX = /^0x[0-9a-fA-F]*$/;

function assertString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new IdempotencyRecordParseError(`field "${field}" must be a string`);
	}
	return value;
}

function assertNonEmptyString(value: unknown, field: string): string {
	const s = assertString(value, field);
	if (s === "") {
		throw new IdempotencyRecordParseError(`field "${field}" must not be empty`);
	}
	return s;
}

function assertNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new IdempotencyRecordParseError(`field "${field}" must be a finite number`);
	}
	return value;
}

function assertHex(value: unknown, field: string): Hex {
	const s = assertString(value, field);
	if (!HEX.test(s) || s.length % 2 !== 0) {
		throw new IdempotencyRecordParseError(`field "${field}" must be 0x-prefixed even-length hex`);
	}
	// Narrowed to viem's Hex by the regex above; the cast carries no extra trust.
	return s as Hex;
}

function parseBigIntString(value: unknown, field: string): bigint {
	const s = assertString(value, field);
	if (!UINT_DECIMAL.test(s)) {
		throw new IdempotencyRecordParseError(
			`field "${field}" must be a non-negative decimal integer string`,
		);
	}
	return BigInt(s);
}

function assertAddress(value: unknown, field: string): Address {
	const s = assertString(value, field);
	try {
		return getAddress(s);
	} catch (cause) {
		throw new IdempotencyRecordParseError(`field "${field}" must be a valid address`, { cause });
	}
}

function assertNetwork(value: unknown, field: string): X402Network {
	const s = assertString(value, field);
	if (!isX402Network(s)) {
		throw new IdempotencyRecordParseError(`field "${field}" must be a valid x402 network`);
	}
	return s;
}

function assertSnapshot(value: unknown): IdempotencyResponseSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IdempotencyRecordParseError(`field "responseSnapshot" must be an object`);
	}
	const raw = value as {
		status?: unknown;
		headers?: unknown;
		bodyBase64?: unknown;
	};
	const status = assertNumber(raw.status, "responseSnapshot.status");
	if (!Array.isArray(raw.headers)) {
		throw new IdempotencyRecordParseError(`field "responseSnapshot.headers" must be an array`);
	}
	const headers = raw.headers.map((pair, i): readonly [string, string] => {
		if (!Array.isArray(pair) || pair.length !== 2) {
			throw new IdempotencyRecordParseError(
				`field "responseSnapshot.headers[${i}]" must be a [name, value] pair`,
			);
		}
		return [
			assertString(pair[0], `responseSnapshot.headers[${i}][0]`),
			assertString(pair[1], `responseSnapshot.headers[${i}][1]`),
		];
	});
	const bodyBase64 = assertString(raw.bodyBase64, "responseSnapshot.bodyBase64");
	return { status, headers, bodyBase64 };
}

/**
 * Serializes a record to a plain UTF-8 JSON string (base64 / transport is the
 * caller's concern). Bigints become decimal strings.
 *
 * @example
 * ```ts
 * import { serializeIdempotencyRecord } from "kawasekit/idempotency";
 *
 * const json = serializeIdempotencyRecord(record);
 * ```
 */
export function serializeIdempotencyRecord(record: IdempotencyRecord): string {
	const json: IdempotencyRecordJson = {
		kawasekitVersion: record.kawasekitVersion,
		key: record.key,
		txHash: record.txHash,
		payer: record.payer,
		amount: record.amount,
		network: record.network,
		...(record.responseSnapshot !== undefined ? { responseSnapshot: record.responseSnapshot } : {}),
		expiresAt: record.expiresAt.toString(),
	};
	return JSON.stringify(json);
}

/**
 * Parses a serialized record. Throws {@link IdempotencyRecordVersionError} on a
 * version mismatch and {@link IdempotencyRecordParseError} on any structural /
 * field error (so a corrupt entry can be dropped and the request treated as
 * fresh — fund-correctness still rests on the on-chain nonce, not this cache).
 *
 * @example
 * ```ts
 * import { parseIdempotencyRecord } from "kawasekit/idempotency";
 *
 * const record = parseIdempotencyRecord(jsonFromStore);
 * ```
 */
export function parseIdempotencyRecord(input: string): IdempotencyRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(input);
	} catch (cause) {
		throw new IdempotencyRecordParseError("input is not valid JSON", { cause });
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new IdempotencyRecordParseError("input must be a JSON object");
	}
	// Narrow to a per-field `unknown` shape (not an index signature) so each field
	// is validated by an assert* helper and dot-access stays lint-clean.
	const obj = raw as {
		readonly kawasekitVersion?: unknown;
		readonly key?: unknown;
		readonly txHash?: unknown;
		readonly payer?: unknown;
		readonly amount?: unknown;
		readonly network?: unknown;
		readonly responseSnapshot?: unknown;
		readonly expiresAt?: unknown;
	};

	const version = assertString(obj.kawasekitVersion, "kawasekitVersion");
	if (version !== KAWASEKIT_IDEMPOTENCY_RECORD_VERSION) {
		throw new IdempotencyRecordVersionError(KAWASEKIT_IDEMPOTENCY_RECORD_VERSION, version);
	}

	const snapshotRaw = obj.responseSnapshot;
	return {
		kawasekitVersion: KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
		key: assertNonEmptyString(obj.key, "key"),
		txHash: assertHex(obj.txHash, "txHash"),
		payer: assertAddress(obj.payer, "payer"),
		amount: parseBigIntString(obj.amount, "amount").toString(),
		network: assertNetwork(obj.network, "network"),
		...(snapshotRaw !== undefined ? { responseSnapshot: assertSnapshot(snapshotRaw) } : {}),
		expiresAt: parseBigIntString(obj.expiresAt, "expiresAt"),
	};
}
