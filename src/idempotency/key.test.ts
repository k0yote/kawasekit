import { describe, expect, it } from "vitest";
import { IdempotencyConfigError } from "./errors";
import {
	type CanonicalRequestIdentity,
	createIdempotencyKeyBuilder,
	deriveIdempotencyKey,
	normalizeIntentText,
} from "./key";

const KEY_RE = /^0x[0-9a-f]{64}$/;
// A fixed 32-byte secret for the keyed-hash branch.
const SECRET = `0x${"ab".repeat(32)}` as const;

describe("normalizeIntentText", () => {
	it("trims and collapses internal whitespace, preserving case", () => {
		expect(normalizeIntentText("  fetch_weather:  Tokyo \n")).toBe("fetch_weather: Tokyo");
		expect(normalizeIntentText("A\t\tB   C")).toBe("A B C");
	});

	it("does NOT lowercase (case is meaning-bearing)", () => {
		expect(normalizeIntentText("Tokyo")).toBe("Tokyo");
		expect(normalizeIntentText("Tokyo")).not.toBe(normalizeIntentText("tokyo"));
	});

	it("applies Unicode NFC so equivalent forms collapse", () => {
		// "é" as U+00E9 vs "e" + U+0301 combining accent.
		const composed = "café";
		const decomposed = "café";
		expect(composed).not.toBe(decomposed);
		expect(normalizeIntentText(composed)).toBe(normalizeIntentText(decomposed));
	});
});

describe("deriveIdempotencyKey", () => {
	const base: CanonicalRequestIdentity = { conversationId: "conv-1", stepId: "3" };

	it("is deterministic for the same identity", () => {
		expect(deriveIdempotencyKey(base)).toBe(deriveIdempotencyKey(base));
		expect(deriveIdempotencyKey(base)).toMatch(KEY_RE);
	});

	it("differs when any identity field differs", () => {
		const k = deriveIdempotencyKey(base);
		expect(deriveIdempotencyKey({ ...base, conversationId: "conv-2" })).not.toBe(k);
		expect(deriveIdempotencyKey({ ...base, stepId: "4" })).not.toBe(k);
		expect(deriveIdempotencyKey({ ...base, intent: "x" })).not.toBe(k);
		expect(deriveIdempotencyKey({ ...base, namespace: "sub-a" })).not.toBe(k);
	});

	it("treats NFC/whitespace-equivalent intents as the same key", () => {
		const a = deriveIdempotencyKey({ ...base, intent: "fetch:  Tokyo" });
		const b = deriveIdempotencyKey({ ...base, intent: "fetch: Tokyo" });
		expect(a).toBe(b);
	});

	it("avoids field-boundary ambiguity (concat collisions)", () => {
		// ("ab","c") must not collide with ("a","bc").
		const x = deriveIdempotencyKey({ conversationId: "ab", stepId: "c" });
		const y = deriveIdempotencyKey({ conversationId: "a", stepId: "bc" });
		expect(x).not.toBe(y);
	});

	it("keyed (secret) hash differs from the no-secret hash and is deterministic", () => {
		const plain = deriveIdempotencyKey(base);
		const keyed = deriveIdempotencyKey(base, SECRET);
		expect(keyed).toMatch(KEY_RE);
		expect(keyed).not.toBe(plain);
		expect(deriveIdempotencyKey(base, SECRET)).toBe(keyed);
	});

	it("rejects empty conversationId / stepId", () => {
		expect(() => deriveIdempotencyKey({ conversationId: "", stepId: "1" })).toThrow(
			IdempotencyConfigError,
		);
		expect(() => deriveIdempotencyKey({ conversationId: "c", stepId: "" })).toThrow(
			IdempotencyConfigError,
		);
	});
});

describe("createIdempotencyKeyBuilder", () => {
	it("assigns monotonic stepIds", () => {
		const keys = createIdempotencyKeyBuilder({ conversationId: "conv-1" });
		const k0 = keys.next("a");
		const k1 = keys.next("b");
		expect(k0).not.toBe(k1);
		expect(k0).toBe(deriveIdempotencyKey({ conversationId: "conv-1", stepId: "0", intent: "a" }));
		expect(k1).toBe(deriveIdempotencyKey({ conversationId: "conv-1", stepId: "1", intent: "b" }));
	});

	it("reproduces keys across a fresh builder (deterministic replay from start)", () => {
		const run1 = createIdempotencyKeyBuilder({ conversationId: "conv-1" });
		const a1 = run1.next("a");
		const b1 = run1.next("b");
		// Regeneration: a new builder for the same conversation replays from step 0.
		const run2 = createIdempotencyKeyBuilder({ conversationId: "conv-1" });
		expect(run2.next("a")).toBe(a1);
		expect(run2.next("b")).toBe(b1);
	});

	it("namespace partitions parallel sub-agents", () => {
		const a = createIdempotencyKeyBuilder({ conversationId: "conv-1", namespace: "sub-a" });
		const b = createIdempotencyKeyBuilder({ conversationId: "conv-1", namespace: "sub-b" });
		expect(a.next("x")).not.toBe(b.next("x"));
	});

	it("rejects an empty conversationId at construction", () => {
		expect(() => createIdempotencyKeyBuilder({ conversationId: "" })).toThrow(
			IdempotencyConfigError,
		);
	});
});
