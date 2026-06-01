import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createSpendingPolicy } from "../policy/spending-policy";
import { JPYC_V2_ADDRESS } from "../tokens/jpyc";
import { PolicyGatedSignerConfigError } from "./errors";
import { assertNonBypassable, requireNonBypassable } from "./gate";
import { createLocalPolicyGatedSigner } from "./local";
import type { NonBypassableEnforcement, PolicyGatedSigner } from "./types";

const account = privateKeyToAccount(
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const policy = createSpendingPolicy({
	session: { id: "s", notAfter: 2_000_000_000n },
	perToken: [{ token: JPYC_V2_ADDRESS, maxPerSign: 1000n }],
	recipientAllowlist: "any",
});
const local = createLocalPolicyGatedSigner({
	account,
	policy,
	asset: { kind: "known", id: "jpyc-v2" },
	acknowledgeAdvisory: true,
});

// M6-0 ships no cryptographic adapter; this typed stub exercises the gate's pass direction.
// cast: fabricate a non-bypassable signer for the positive type-gate assertion
const cryptographic = {
	...local,
	enforcement: "cryptographic",
} as PolicyGatedSigner<"cryptographic">;

describe("enforcement type-gate (compile-time)", () => {
	it("advisory is not assignable to a non-bypassable signer; cryptographic/hardware are", () => {
		expectTypeOf<PolicyGatedSigner<"advisory">>().not.toMatchTypeOf<
			PolicyGatedSigner<NonBypassableEnforcement>
		>();
		expectTypeOf<PolicyGatedSigner<"cryptographic">>().toMatchTypeOf<
			PolicyGatedSigner<NonBypassableEnforcement>
		>();
		expectTypeOf<PolicyGatedSigner<"hardware">>().toMatchTypeOf<
			PolicyGatedSigner<NonBypassableEnforcement>
		>();
	});

	it("requireNonBypassable rejects an advisory (local) signer — NEGATIVE direction", () => {
		// @ts-expect-error — "advisory" is not assignable to NonBypassableEnforcement.
		// This line compiling green IS the test: it proves the gate rejects local. Do not
		// rewrite to expectTypeOf — that cannot express a call-rejection.
		requireNonBypassable(local);
	});

	it("requireNonBypassable accepts a non-bypassable signer — POSITIVE direction", () => {
		expect(requireNonBypassable(cryptographic)).toBe(cryptographic);
		expectTypeOf(requireNonBypassable(cryptographic)).toEqualTypeOf<
			PolicyGatedSigner<"cryptographic">
		>();
	});
});

describe("assertNonBypassable (runtime backstop)", () => {
	it("throws for an advisory signer", () => {
		expect(() => assertNonBypassable(local)).toThrow(PolicyGatedSignerConfigError);
	});

	it("passes a non-bypassable signer", () => {
		expect(() => assertNonBypassable(cryptographic)).not.toThrow();
	});
});
