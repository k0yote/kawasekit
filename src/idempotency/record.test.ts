import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { IdempotencyRecordParseError, IdempotencyRecordVersionError } from "./errors";
import {
	type IdempotencyRecord,
	KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
	parseIdempotencyRecord,
	serializeIdempotencyRecord,
} from "./record";

const PAYER = getAddress("0x1111111111111111111111111111111111111111");

function baseRecord(): IdempotencyRecord {
	return {
		kawasekitVersion: KAWASEKIT_IDEMPOTENCY_RECORD_VERSION,
		key: `0x${"11".repeat(32)}`,
		txHash: `0x${"22".repeat(32)}`,
		payer: PAYER,
		amount: "1000000000000000000",
		network: "eip155:80002",
		expiresAt: 1_900_000_000n,
	};
}

describe("serialize/parse round-trip", () => {
	it("round-trips a record without a snapshot", () => {
		const record = baseRecord();
		expect(parseIdempotencyRecord(serializeIdempotencyRecord(record))).toEqual(record);
	});

	it("round-trips a record with a response snapshot", () => {
		const record: IdempotencyRecord = {
			...baseRecord(),
			responseSnapshot: {
				status: 200,
				headers: [
					["content-type", "application/json"],
					["payment-response", "eyJ0eCI6IjB4In0="],
				],
				bodyBase64: "eyJvayI6dHJ1ZX0=",
			},
		};
		expect(parseIdempotencyRecord(serializeIdempotencyRecord(record))).toEqual(record);
	});

	it("serializes expiresAt as a decimal string (uint256-safe)", () => {
		const json = JSON.parse(serializeIdempotencyRecord(baseRecord())) as { expiresAt: unknown };
		expect(json.expiresAt).toBe("1900000000");
	});
});

/** Each field is `unknown` so a test can inject a wrong-typed value. */
interface RawRecord {
	kawasekitVersion: unknown;
	key: unknown;
	txHash: unknown;
	payer: unknown;
	amount: unknown;
	network: unknown;
	responseSnapshot?: unknown;
	expiresAt: unknown;
}

/** Serialize a valid record, then override fields with (possibly invalid) values. */
function withOverrides(overrides: Partial<RawRecord>): string {
	const raw = JSON.parse(serializeIdempotencyRecord(baseRecord())) as RawRecord;
	return JSON.stringify({ ...raw, ...overrides });
}

describe("parse validation", () => {
	it("rejects a version mismatch with IdempotencyRecordVersionError", () => {
		expect(() => parseIdempotencyRecord(withOverrides({ kawasekitVersion: "2" }))).toThrow(
			IdempotencyRecordVersionError,
		);
	});

	it("rejects malformed JSON", () => {
		expect(() => parseIdempotencyRecord("{not json")).toThrow(IdempotencyRecordParseError);
	});

	it("rejects a non-object", () => {
		expect(() => parseIdempotencyRecord("[]")).toThrow(IdempotencyRecordParseError);
	});

	it("rejects a non-hex txHash", () => {
		expect(() => parseIdempotencyRecord(withOverrides({ txHash: "not-hex" }))).toThrow(
			IdempotencyRecordParseError,
		);
	});

	it("rejects an invalid payer address", () => {
		expect(() => parseIdempotencyRecord(withOverrides({ payer: "0xnotanaddress" }))).toThrow(
			IdempotencyRecordParseError,
		);
	});

	it("rejects a non-decimal amount", () => {
		expect(() => parseIdempotencyRecord(withOverrides({ amount: "1.5" }))).toThrow(
			IdempotencyRecordParseError,
		);
	});

	it("rejects an unsupported network", () => {
		// Base — not a kawasekit-supported chain.
		expect(() => parseIdempotencyRecord(withOverrides({ network: "eip155:8453" }))).toThrow(
			IdempotencyRecordParseError,
		);
	});

	it("rejects a malformed snapshot header pair", () => {
		const bad = withOverrides({
			responseSnapshot: { status: 200, headers: [["only-one"]], bodyBase64: "" },
		});
		expect(() => parseIdempotencyRecord(bad)).toThrow(IdempotencyRecordParseError);
	});
});
