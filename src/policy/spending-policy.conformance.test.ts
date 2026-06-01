import type { Hex } from "viem";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { PaymentIntent } from "../signer/types";
import corpus from "./__fixtures__/spending-policy.vectors.json";
import {
	evaluateSpendingPolicy,
	type SpendingPolicy,
	type SpendState,
	type TokenLimit,
} from "./spending-policy";

/**
 * The B8 cross-language conformance corpus (SDK half). The same
 * `spending-policy.vectors.json` is consumed by the `mpc-2p` Go backend port
 * (M6-2); both must produce identical decisions. Encoding is pinned: decimal-
 * string bigints, EIP-55 addresses, `recipientAllowlist` null = any / [] = deny-all.
 */
interface VectorJson {
	readonly name: string;
	readonly policy: {
		readonly version: "1";
		readonly session: { readonly id: string; readonly notAfter: string };
		readonly perToken: ReadonlyArray<{
			readonly token: string;
			readonly maxPerSign: string;
			readonly cumulativeCap?: string;
		}>;
		readonly recipientAllowlist: readonly string[] | null;
		readonly revoked: boolean;
	};
	readonly intent: {
		readonly token: string;
		readonly chainId: number;
		readonly from: string;
		readonly to: string;
		readonly value: string;
		readonly validAfter: string;
		readonly validBefore: string;
		readonly nonce: string;
	};
	readonly state: { readonly spentPerToken: ReadonlyArray<{ token: string; spent: string }> };
	readonly now: string;
	readonly expected: { readonly ok: true } | { readonly ok: false; readonly reason: string };
}

function parsePolicy(p: VectorJson["policy"]): SpendingPolicy {
	const perToken: TokenLimit[] = p.perToken.map((l) =>
		l.cumulativeCap !== undefined
			? {
					token: getAddress(l.token),
					maxPerSign: BigInt(l.maxPerSign),
					cumulativeCap: BigInt(l.cumulativeCap),
				}
			: { token: getAddress(l.token), maxPerSign: BigInt(l.maxPerSign) },
	);
	return {
		version: "1",
		session: { id: p.session.id, notAfter: BigInt(p.session.notAfter) },
		perToken,
		...(p.recipientAllowlist !== null
			? { recipientAllowlist: p.recipientAllowlist.map((a) => getAddress(a)) }
			: {}),
		revoked: p.revoked,
	};
}

function parseIntent(i: VectorJson["intent"]): PaymentIntent {
	return {
		token: getAddress(i.token),
		chainId: i.chainId,
		from: getAddress(i.from),
		to: getAddress(i.to),
		value: BigInt(i.value),
		validAfter: BigInt(i.validAfter),
		validBefore: BigInt(i.validBefore),
		// fixture-controlled 32-byte hex nonce
		nonce: i.nonce as Hex,
	};
}

function parseState(s: VectorJson["state"]): SpendState {
	return {
		spentPerToken: s.spentPerToken.map((e) => ({
			token: getAddress(e.token),
			spent: BigInt(e.spent),
		})),
	};
}

describe("spending-policy conformance corpus (B8 — SDK half)", () => {
	// trusted in-repo fixture; shape asserted by the VectorJson interface
	const vectors = corpus.vectors as unknown as readonly VectorJson[];

	it("covers every rejection reason at least once", () => {
		const reasons = new Set(vectors.flatMap((v) => (v.expected.ok ? [] : [v.expected.reason])));
		expect(reasons).toEqual(
			new Set([
				"revoked",
				"expired",
				"token_not_allowed",
				"recipient_not_allowed",
				"amount_exceeds_per_sign",
				"amount_exceeds_cumulative",
			]),
		);
	});

	for (const v of vectors) {
		it(v.name, () => {
			const decision = evaluateSpendingPolicy(
				parsePolicy(v.policy),
				parseIntent(v.intent),
				parseState(v.state),
				BigInt(v.now),
			);
			if (v.expected.ok) {
				expect(decision).toEqual({ ok: true });
			} else {
				expect(decision.ok).toBe(false);
				if (!decision.ok) {
					expect(decision.rejection.reason).toBe(v.expected.reason);
				}
			}
		});
	}
});
