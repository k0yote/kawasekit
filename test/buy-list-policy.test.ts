import { type Address, decodeAbiParameters, getAddress, type Hex, pad, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import {
	createBuyListPolicies,
	createLegacyTransferBuyListPolicies,
	JPYC_DECIMALS,
	JPYC_V2_ADDRESS,
	SETTLEMENT_V1_ADDRESS,
} from "../src";

const JPYC = getAddress(JPYC_V2_ADDRESS);
const SETTLEMENT = getAddress(SETTLEMENT_V1_ADDRESS);
const MERCHANT_A = getAddress(`0x${"11".repeat(20)}`);
const MERCHANT_B = getAddress(`0x${"22".repeat(20)}`);
const STRANGER = getAddress(`0x${"33".repeat(20)}`);
const OTHER_CONTRACT = getAddress(`0x${"44".repeat(20)}`);
const VALID_UNTIL = 2_000_000_000;

/** Selectors, as they appear inside the encoded permissions (no `0x`). */
const APPROVE = "095ea7b3";
const PAY = "b8a48717";
const TRANSFER = "a9059cbb";

function base() {
	return {
		jpycAddress: JPYC,
		settlementAddress: SETTLEMENT,
		merchants: [MERCHANT_A, MERCHANT_B],
		maxPerTransfer: parseUnits("500", JPYC_DECIMALS),
		validUntil: VALID_UNTIL,
	} as const;
}

/**
 * The ENFORCED on-chain callPolicy bytes (lowercased). `getPolicyData()` is what the deployed
 * CallPolicy checks a UserOp against — unlike `policyParams`, which only echoes the input. Every
 * claim about what a key may do is read from here, or a mis-encoded rule would pass the test while
 * allowing something else on chain.
 */
function enforced(policies: ReturnType<typeof createBuyListPolicies>): string {
	return policies[0].getPolicyData().toLowerCase();
}
/** The 32-byte word an address occupies in the encoded rule data (no `0x`). */
function word(addr: Address): string {
	return pad(addr, { size: 32 }).slice(2).toLowerCase();
}
/** The 20-byte form a permission's TARGET takes (no `0x`). */
function target(addr: Address): string {
	return addr.slice(2).toLowerCase();
}

describe("createBuyListPolicies — what the key may call", () => {
	it("is [callPolicy, timestampPolicy]", () => {
		const policies = createBuyListPolicies(base());
		expect(policies).toHaveLength(2);
		expect(policies[0].policyParams.type).toBe("call");
		expect(policies[1].policyParams.type).toBe("timestamp");
	});

	it("permits approve and pay — and NOT transfer", () => {
		const data = enforced(createBuyListPolicies(base()));
		expect(data).toContain(APPROVE);
		expect(data).toContain(PAY);
		// The point of the 0.11.0 scope: a buy-list key cannot move JPYC except through Settlement,
		// so every yen it moves carries an order reference. (Proven on Polygon Amoy: a bare
		// `JPYC.transfer` under this scope is refused with `InvalidCallData()`.)
		expect(data).not.toContain(TRANSFER);
	});

	it("is a different scope from the legacy one, which permitted transfer", () => {
		const { settlementAddress: _unused, ...legacyParams } = base();
		const legacy = createLegacyTransferBuyListPolicies(legacyParams)[0]
			.getPolicyData()
			.toLowerCase();
		expect(legacy).toContain(TRANSFER);
		expect(legacy).not.toContain(PAY);
	});

	it("targets JPYC for approve and Settlement for pay — nothing else", () => {
		const data = enforced(createBuyListPolicies(base()));
		expect(data).toContain(target(JPYC));
		expect(data).toContain(target(SETTLEMENT));
		expect(data).not.toContain(target(OTHER_CONTRACT));
	});
});

/**
 * The layout the deployed CallPolicy (V0_0_2+) reads — `@zerodev/permissions`' own
 * `encodePermissionData`. Decoding the ENFORCED bytes with it lets each rule be asserted exactly:
 * which function, which argument (`offset` = index × 32), which condition, which values.
 */
const PERMISSIONS_LAYOUT = [
	{
		type: "tuple[]",
		components: [
			{ name: "callType", type: "bytes1" },
			{ name: "target", type: "address" },
			{ name: "selector", type: "bytes4" },
			{ name: "valueLimit", type: "uint256" },
			{
				name: "rules",
				type: "tuple[]",
				components: [
					{ name: "condition", type: "uint8" },
					{ name: "offset", type: "uint64" },
					{ name: "params", type: "bytes32[]" },
				],
			},
		],
	},
] as const;

/** `ParamCondition` as the contract numbers it. */
const EQUAL = 0;
const LESS_THAN_OR_EQUAL = 4;
const ONE_OF = 6;

function decoded(policies: ReturnType<typeof createBuyListPolicies>) {
	const [permissions] = decodeAbiParameters(PERMISSIONS_LAYOUT, policies[0].getPolicyData());
	return permissions;
}
function addressParam(addr: Address): Hex {
	return pad(addr, { size: 32 }).toLowerCase() as Hex; // pad() of an address is 32 bytes of hex
}
function uintParam(value: bigint): Hex {
	return `0x${value.toString(16).padStart(64, "0")}`;
}

describe("createBuyListPolicies — the enforced rules, decoded", () => {
	// A substring check cannot isolate a rule: the padded Settlement address appears BOTH as `pay`'s
	// target and as `approve`'s spender rule, so "the bytes contain it" stays true when the spender
	// rule is dropped. That exact mutant survived the first version of this file. These assertions
	// decode the bytes the chain enforces and pin every rule to its function and its argument.
	const cap = parseUnits("500", JPYC_DECIMALS);

	it("is exactly two permissions: approve on JPYC, pay on Settlement, no ETH value, single-call type", () => {
		const permissions = decoded(createBuyListPolicies(base()));
		expect(permissions).toHaveLength(2);
		expect(permissions.map((p) => [getAddress(p.target), p.selector])).toEqual([
			[JPYC, `0x${APPROVE}`],
			[SETTLEMENT, `0x${PAY}`],
		]);
		for (const p of permissions) {
			expect(p.valueLimit).toBe(0n);
			// 0x00 = CallType.CALL — the type a batch's entries were validated under on Polygon Amoy.
			expect(p.callType).toBe("0x00");
		}
	});

	it("approve: spender == Settlement, amount <= cap — and nothing else", () => {
		const approve = decoded(createBuyListPolicies(base()))[0];
		expect(approve?.rules).toEqual([
			{ condition: EQUAL, offset: 0n, params: [addressParam(SETTLEMENT)] },
			{ condition: LESS_THAN_OR_EQUAL, offset: 32n, params: [uintParam(cap)] },
		]);
	});

	it("pay: token == JPYC, merchant ONE_OF the allowlist, amount <= cap; validUntil and details free", () => {
		const pay = decoded(createBuyListPolicies(base()))[1];
		expect(pay?.rules).toEqual([
			{ condition: EQUAL, offset: 0n, params: [addressParam(JPYC)] },
			{
				condition: ONE_OF,
				offset: 32n,
				params: [addressParam(MERCHANT_A), addressParam(MERCHANT_B)],
			},
			{ condition: LESS_THAN_OR_EQUAL, offset: 64n, params: [uintParam(cap)] },
		]);
	});
});

describe("createBuyListPolicies — each argument's constraint is in the bytes", () => {
	// `toCallPolicy` is generic over ONE abi, so a two-function scope is declared against the general
	// `Abi` type and its argument conditions are not type-checked. Each one is therefore proven
	// DIFFERENTIALLY: change exactly one input and the enforced bytes must change.

	it("approve's spender is the Settlement address", () => {
		const a = enforced(createBuyListPolicies(base()));
		const b = enforced(createBuyListPolicies({ ...base(), settlementAddress: OTHER_CONTRACT }));
		expect(a).toContain(word(SETTLEMENT));
		expect(b).toContain(word(OTHER_CONTRACT));
		expect(b).not.toContain(word(SETTLEMENT));
	});

	it("pay's token is JPYC", () => {
		const a = enforced(createBuyListPolicies(base()));
		const b = enforced(createBuyListPolicies({ ...base(), jpycAddress: OTHER_CONTRACT }));
		expect(a).toContain(word(JPYC));
		expect(b).not.toContain(word(JPYC));
	});

	it("pay's merchant is one of the allowlist, and a stranger is not in it", () => {
		const data = enforced(createBuyListPolicies(base()));
		expect(data).toContain(word(MERCHANT_A));
		expect(data).toContain(word(MERCHANT_B));
		expect(data).not.toContain(word(STRANGER));
	});

	it("the cap bounds BOTH the approval and the payment", () => {
		const lo = parseUnits("500", JPYC_DECIMALS);
		const hi = parseUnits("501", JPYC_DECIMALS);
		const capWord = (v: bigint) => v.toString(16).padStart(64, "0");
		const data = enforced(createBuyListPolicies({ ...base(), maxPerTransfer: lo }));
		// once in approve's rule, once in pay's
		expect(data.split(capWord(lo)).length - 1).toBe(2);
		expect(enforced(createBuyListPolicies({ ...base(), maxPerTransfer: hi }))).not.toContain(
			capWord(lo),
		);
	});

	it("normalizes and de-duplicates mixed-case merchants", () => {
		const lower = MERCHANT_A.toLowerCase();
		const a = enforced(createBuyListPolicies({ ...base(), merchants: [MERCHANT_A] }));
		// Cast: a lowercased address is still an address; viem's type wants the checksum form.
		const b = enforced(
			createBuyListPolicies({ ...base(), merchants: [lower as Address, MERCHANT_A] }),
		);
		expect(b).toBe(a);
	});
});

describe("createBuyListPolicies — the window", () => {
	it("carries validUntil, and validAfter defaulting to 0", () => {
		const ts = createBuyListPolicies(base())[1].policyParams;
		if (ts.type !== "timestamp") throw new Error("expected timestamp");
		expect(ts.validUntil).toBe(VALID_UNTIL);
		expect(ts.validAfter ?? 0).toBe(0);
	});

	it("carries an explicit validAfter", () => {
		const ts = createBuyListPolicies({ ...base(), validAfter: 1_900_000_000 })[1].policyParams;
		if (ts.type !== "timestamp") throw new Error("expected timestamp");
		expect(ts.validAfter).toBe(1_900_000_000);
	});
});

describe("createBuyListPolicies — refusals", () => {
	it("an empty merchant list", () => {
		expect(() => createBuyListPolicies({ ...base(), merchants: [] })).toThrow(
			/merchants must not be empty/,
		);
	});
	it("a non-positive cap", () => {
		expect(() => createBuyListPolicies({ ...base(), maxPerTransfer: 0n })).toThrow(
			/maxPerTransfer must be positive/,
		);
	});
	it("a malformed Settlement address", () => {
		// Cast: a deliberately malformed address, to drive the validation branch.
		const bad = "0x1234" as Address;
		expect(() => createBuyListPolicies({ ...base(), settlementAddress: bad })).toThrow(
			/settlementAddress/,
		);
	});
	it("a Settlement address equal to the token — approve(spender = token) is never what was meant", () => {
		expect(() => createBuyListPolicies({ ...base(), settlementAddress: JPYC })).toThrow(
			/settlementAddress must differ from jpycAddress/,
		);
	});
	it("a non-positive validUntil", () => {
		expect(() => createBuyListPolicies({ ...base(), validUntil: 0 })).toThrow(
			/validUntil must be a positive/,
		);
	});
	it("validAfter at or after validUntil", () => {
		expect(() => createBuyListPolicies({ ...base(), validAfter: VALID_UNTIL })).toThrow(
			/validAfter .* must be before validUntil/,
		);
	});
});
