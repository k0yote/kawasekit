import { createHmac } from "node:crypto";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
	type CoSignRequestEnvelope,
	canonicalRequestBytes,
	toWireIntent,
	WIRE_VERSION,
} from "./mpc-2p-wire";
import type { PaymentIntent } from "./types";

/**
 * The frozen A3 v2 conformance vector — identical to the backend's
 * `kawasekit-mpc-2p` `src/auth.rs` test (`FROZEN_CANONICAL` / `FROZEN_TAG_HEX`).
 * If this drifts, the SDK's A3 tag would no longer equal what the co-signer
 * verifies. Pinned on BOTH sides.
 */
const FROZEN_INTENT: PaymentIntent = {
	token: "0x1111111111111111111111111111111111111111",
	chainId: 80002,
	from: "0x2222222222222222222222222222222222222222",
	to: "0x3333333333333333333333333333333333333333",
	value: 123456n,
	validAfter: 0n,
	validBefore: 4_000_000_000n,
	nonce: `0x${"44".repeat(32)}` as Hex,
};

const FROZEN_ENV: CoSignRequestEnvelope = {
	ceremonyId: "ceremony-0000",
	ssid: "ssid-0000",
	intent: FROZEN_INTENT,
	freshnessTs: 1_700_000_000,
	freshnessNonce: `0x${"55".repeat(16)}` as Hex,
};

const FROZEN_CANONICAL =
	"kawasekit-mpc-2p/cosign-request/v3\n" +
	"wireVersion=2\n" +
	"ceremonyId=ceremony-0000\n" +
	"ssid=ssid-0000\n" +
	"token=0x1111111111111111111111111111111111111111\n" +
	"chainId=80002\n" +
	"from=0x2222222222222222222222222222222222222222\n" +
	"to=0x3333333333333333333333333333333333333333\n" +
	"value=123456\n" +
	"validAfter=0\n" +
	"validBefore=4000000000\n" +
	`nonce=0x${"44".repeat(32)}\n` +
	"freshnessTs=1700000000\n" +
	`freshnessNonce=0x${"55".repeat(16)}\n`;

const FROZEN_TAG_HEX = "15a8943e044d2561a6c1e9b00b01b08404757c15694cdd2a5e00c5a8891dbdf4";

describe("canonicalRequestBytes — A3 v2 conformance vector (TS == Rust)", () => {
	it("reproduces the frozen canonical bytes exactly (441 bytes)", () => {
		const bytes = canonicalRequestBytes(FROZEN_ENV);
		expect(new TextDecoder().decode(bytes)).toBe(FROZEN_CANONICAL);
		expect(bytes.length).toBe(441);
	});

	it("HMAC-SHA256 over the canonical bytes equals the backend's frozen tag", () => {
		// node:crypto in the TEST only — the SDK never does HMAC (the key lives in
		// the injected authenticator). This pins the canonical encoding to the
		// backend's `auth::canonical_request_bytes` + key [0x42; 32].
		const key = Buffer.alloc(32, 0x42);
		const tag = createHmac("sha256", key)
			.update(Buffer.from(canonicalRequestBytes(FROZEN_ENV)))
			.digest("hex");
		expect(tag).toBe(FROZEN_TAG_HEX);
	});

	it("is case-insensitive on addresses / nonces (lowercases them)", () => {
		const upper: CoSignRequestEnvelope = {
			...FROZEN_ENV,
			intent: {
				...FROZEN_INTENT,
				token: "0x1111111111111111111111111111111111111111"
					.toUpperCase()
					.replace("0X", "0x") as Hex,
				nonce: `0x${"44".repeat(32)}`.toUpperCase().replace("0X", "0x") as Hex,
			},
			freshnessNonce: `0x${"55".repeat(16)}`.toUpperCase().replace("0X", "0x") as Hex,
		};
		expect(new TextDecoder().decode(canonicalRequestBytes(upper))).toBe(FROZEN_CANONICAL);
	});
});

describe("toWireIntent — matches the Rust WireIntent encoding", () => {
	it("lowercases addresses, decimals integers, hex nonce", () => {
		expect(toWireIntent(FROZEN_INTENT)).toEqual({
			token: "0x1111111111111111111111111111111111111111",
			chain_id: 80002,
			from: "0x2222222222222222222222222222222222222222",
			to: "0x3333333333333333333333333333333333333333",
			value: "123456",
			valid_after: "0",
			valid_before: "4000000000",
			nonce: `0x${"44".repeat(32)}`,
		});
	});

	it("renders large bigints as decimal strings", () => {
		const big = toWireIntent({ ...FROZEN_INTENT, value: 10n ** 30n });
		expect(big.value).toBe("1000000000000000000000000000000");
	});
});

describe("WIRE_VERSION", () => {
	it("is pinned to 2 (matches the backend)", () => {
		expect(WIRE_VERSION).toBe(2);
	});
});
