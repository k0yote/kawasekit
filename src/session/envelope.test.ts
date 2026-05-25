import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { polygonAmoy } from "../chains";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import {
	KAWASEKIT_SESSION_ENVELOPE_VERSION,
	type KawasekitSessionEnvelope,
	parseSessionEnvelope,
	serializeSessionEnvelope,
} from "./envelope";
import { SessionEnvelopeParseError, SessionEnvelopeVersionError } from "./errors";

const SMART_ACCOUNT: Address = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SESSION_KEY: Address = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

const MIN: KawasekitSessionEnvelope = {
	kawasekitVersion: KAWASEKIT_SESSION_ENVELOPE_VERSION,
	chainId: polygonAmoy.id,
	smartAccountAddress: SMART_ACCOUNT,
	sessionKeyAddress: SESSION_KEY,
	serialized: "ZeroDevOpaqueBlobBase64StringHere",
};

describe("KAWASEKIT_SESSION_ENVELOPE_VERSION", () => {
	it("is '1'", () => {
		expect(KAWASEKIT_SESSION_ENVELOPE_VERSION).toBe("1");
	});
});

describe("serializeSessionEnvelope + parseSessionEnvelope — roundtrip", () => {
	it("roundtrips a minimal envelope", () => {
		const serialized = serializeSessionEnvelope(MIN);
		expect(typeof serialized).toBe("string");
		expect(JSON.parse(serialized)).toBeTypeOf("object");
		expect(parseSessionEnvelope(serialized)).toEqual(MIN);
	});

	it("roundtrips with expiresAt (bigint preserved)", () => {
		const envelope: KawasekitSessionEnvelope = {
			...MIN,
			expiresAt: 1_999_999_999n,
		};
		const parsed = parseSessionEnvelope(serializeSessionEnvelope(envelope));
		expect(parsed.expiresAt).toBe(1_999_999_999n);
		expect(typeof parsed.expiresAt).toBe("bigint");
	});

	it("roundtrips with policySummary (bigint maxPerTransfer preserved)", () => {
		const envelope: KawasekitSessionEnvelope = {
			...MIN,
			policySummary: {
				jpycAddress: JPYC_V2_ADDRESS,
				maxPerTransfer: 10n * 10n ** 18n,
				maxTransfersPerDay: 24,
			},
		};
		const parsed = parseSessionEnvelope(serializeSessionEnvelope(envelope));
		expect(parsed.policySummary?.maxPerTransfer).toBe(10n * 10n ** 18n);
		expect(parsed.policySummary?.maxTransfersPerDay).toBe(24);
		expect(parsed.policySummary?.jpycAddress).toBe(JPYC_V2_ADDRESS);
	});

	it("roundtrips with both expiresAt and policySummary", () => {
		const envelope: KawasekitSessionEnvelope = {
			...MIN,
			expiresAt: 1_999_999_999n,
			policySummary: {
				jpycAddress: JPYC_V2_ADDRESS,
				maxPerTransfer: 1n,
				maxTransfersPerDay: 1,
			},
		};
		expect(parseSessionEnvelope(serializeSessionEnvelope(envelope))).toEqual(envelope);
	});

	it("omits optional fields entirely when not provided (exactOptionalPropertyTypes)", () => {
		const serialized = serializeSessionEnvelope(MIN);
		const json = JSON.parse(serialized);
		expect("expiresAt" in json).toBe(false);
		expect("policySummary" in json).toBe(false);
	});
});

describe("parseSessionEnvelope — validation", () => {
	it("rejects malformed JSON", () => {
		expect(() => parseSessionEnvelope("not json {[")).toThrow(SessionEnvelopeParseError);
	});

	it("rejects a non-object root (array)", () => {
		expect(() => parseSessionEnvelope("[1,2,3]")).toThrow(SessionEnvelopeParseError);
	});

	it("rejects a non-object root (null)", () => {
		expect(() => parseSessionEnvelope("null")).toThrow(SessionEnvelopeParseError);
	});

	it("rejects a non-object root (string)", () => {
		expect(() => parseSessionEnvelope('"hello"')).toThrow(SessionEnvelopeParseError);
	});

	it("rejects wrong kawasekitVersion with SessionEnvelopeVersionError carrying expected + received", () => {
		const bad = JSON.stringify({ ...MIN, kawasekitVersion: "2" });
		try {
			parseSessionEnvelope(bad);
			expect.fail("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionEnvelopeVersionError);
			expect((error as SessionEnvelopeVersionError).expected).toBe("1");
			expect((error as SessionEnvelopeVersionError).received).toBe("2");
		}
	});

	it("rejects a missing kawasekitVersion as a version error", () => {
		const { kawasekitVersion: _ignored, ...rest } = MIN;
		void _ignored;
		expect(() => parseSessionEnvelope(JSON.stringify(rest))).toThrow(SessionEnvelopeVersionError);
	});

	it("rejects unsupported chainId (e.g. eip155:1)", () => {
		const bad = JSON.stringify({ ...MIN, chainId: 1 });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects a non-numeric chainId", () => {
		const bad = JSON.stringify({ ...MIN, chainId: "80002" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects malformed smartAccountAddress", () => {
		const bad = JSON.stringify({ ...MIN, smartAccountAddress: "0xdeadbeef" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects malformed sessionKeyAddress", () => {
		const bad = JSON.stringify({ ...MIN, sessionKeyAddress: "not-an-address" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects empty serialized", () => {
		const bad = JSON.stringify({ ...MIN, serialized: "" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects missing serialized", () => {
		const { serialized: _ignored, ...rest } = MIN;
		void _ignored;
		expect(() => parseSessionEnvelope(JSON.stringify(rest))).toThrow(SessionEnvelopeParseError);
	});

	it("rejects negative expiresAt", () => {
		const bad = JSON.stringify({ ...MIN, expiresAt: "-1" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects expiresAt with leading zeros", () => {
		const bad = JSON.stringify({ ...MIN, expiresAt: "01" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects non-string expiresAt (e.g. number)", () => {
		const bad = JSON.stringify({ ...MIN, expiresAt: 100 });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects malformed policySummary (not an object)", () => {
		const bad = JSON.stringify({ ...MIN, policySummary: "nope" });
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects policySummary with malformed jpycAddress", () => {
		const bad = JSON.stringify({
			...MIN,
			policySummary: {
				jpycAddress: "0xbad",
				maxPerTransfer: "1",
				maxTransfersPerDay: 1,
			},
		});
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects policySummary with malformed maxPerTransfer", () => {
		const bad = JSON.stringify({
			...MIN,
			policySummary: {
				jpycAddress: JPYC_V2_ADDRESS,
				maxPerTransfer: "1.5",
				maxTransfersPerDay: 1,
			},
		});
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});

	it("rejects policySummary with non-numeric maxTransfersPerDay", () => {
		const bad = JSON.stringify({
			...MIN,
			policySummary: {
				jpycAddress: JPYC_V2_ADDRESS,
				maxPerTransfer: "1",
				maxTransfersPerDay: "10",
			},
		});
		expect(() => parseSessionEnvelope(bad)).toThrow(SessionEnvelopeParseError);
	});
});
