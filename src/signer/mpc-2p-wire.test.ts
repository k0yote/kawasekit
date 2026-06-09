import { createHmac } from "node:crypto";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalIntentBytes, toWireIntent, WIRE_VERSION } from "./mpc-2p-wire";
import type { PaymentIntent } from "./types";

/**
 * The frozen A3 conformance vector — identical to the backend's
 * `kawasekit-mpc-2p` `src/auth.rs` test (`frozen_intent` / `FROZEN_CANONICAL` /
 * `FROZEN_TAG_HEX`). If this drifts, the SDK's A3 tag would no longer equal what
 * the co-signer verifies. Pinned on BOTH sides.
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

const FROZEN_CANONICAL =
	"kawasekit-mpc-2p/cosign-request/v2\n" +
	"token=0x1111111111111111111111111111111111111111\n" +
	"chainId=80002\n" +
	"from=0x2222222222222222222222222222222222222222\n" +
	"to=0x3333333333333333333333333333333333333333\n" +
	"value=123456\n" +
	"validAfter=0\n" +
	"validBefore=4000000000\n" +
	`nonce=0x${"44".repeat(32)}\n`;

const FROZEN_TAG_HEX = "0568e4126191dab0879c18e9adf9332d10b725dd5a7455a4008200be337ca59b";

describe("canonicalIntentBytes — A3 conformance vector (TS == Rust)", () => {
	it("reproduces the frozen canonical bytes exactly (314 bytes)", () => {
		const bytes = canonicalIntentBytes(FROZEN_INTENT);
		expect(new TextDecoder().decode(bytes)).toBe(FROZEN_CANONICAL);
		expect(bytes.length).toBe(314);
	});

	it("HMAC-SHA256 over the canonical bytes equals the backend's frozen tag", () => {
		// node:crypto in the TEST only — the SDK never does HMAC (the key lives in
		// the injected authenticator). This pins the canonical encoding to the
		// backend's `auth::canonical_intent_bytes` + key [0x42; 32].
		const key = Buffer.alloc(32, 0x42);
		const tag = createHmac("sha256", key)
			.update(Buffer.from(canonicalIntentBytes(FROZEN_INTENT)))
			.digest("hex");
		expect(tag).toBe(FROZEN_TAG_HEX);
	});

	it("is case-insensitive on addresses / nonce (lowercases them)", () => {
		const upper: PaymentIntent = {
			...FROZEN_INTENT,
			token: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x") as Hex,
			nonce: `0x${"44".repeat(32)}`.toUpperCase().replace("0X", "0x") as Hex,
		};
		expect(new TextDecoder().decode(canonicalIntentBytes(upper))).toBe(FROZEN_CANONICAL);
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
	it("is pinned to 1 (matches the backend)", () => {
		expect(WIRE_VERSION).toBe(1);
	});
});
