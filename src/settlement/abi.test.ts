import { toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { settlementAbi } from "./abi";

/**
 * The expected values below are NOT derived from `settlementAbi` — that would check the ABI against
 * itself. They were computed from the contract's own Solidity signatures with `cast sig` /
 * `cast sig-event` (kawasekit-contracts `src/settlement/Settlement.sol` at `3618d7c`), and four of
 * them were also observed on Polygon Amoy: `pay`'s selector in a landed UserOp's call data, and
 * `AlreadySettled` / `Expired` as the revert data of refused payments.
 */
const FROM_THE_CONTRACT = {
	pay: "0xb8a48717",
	orderRef: "0x66fd794c",
	settled: "0xd945af1d",
	ZeroAmount: "0x1f2a2005",
	Expired: "0x95693653",
	AlreadySettled: "0xb196a44a",
	Settled: "0xf9ce8733f4fe0b8d822b408e23a3fb9d57fb202f6fe87f52448ac12b52cb9fa9",
} as const;

function selectorOf(name: string): string {
	const item = settlementAbi.find((i) => i.name === name);
	if (item === undefined) throw new Error(`settlementAbi has no entry named ${name}`);
	// A function's and an error's selector are both the first four bytes of keccak("name(types)");
	// an event's topic is the whole hash. Built from the entry's name and input types only.
	const signature = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
	return item.type === "event" ? toEventSelector(signature) : toFunctionSelector(signature);
}

describe("settlementAbi", () => {
	for (const [name, expected] of Object.entries(FROM_THE_CONTRACT)) {
		it(`${name} has the selector the contract has`, () => {
			expect(selectorOf(name)).toBe(expected);
		});
	}

	it("has nothing beyond what the contract has", () => {
		expect(settlementAbi.map((i) => i.name).sort()).toEqual(Object.keys(FROM_THE_CONTRACT).sort());
	});

	it("indexes ref, payer and merchant — a payment can be found by its reference alone", () => {
		const settled = settlementAbi.find((i) => i.type === "event");
		expect(settled?.inputs.filter((i) => i.indexed).map((i) => i.name)).toEqual([
			"ref",
			"payer",
			"merchant",
		]);
	});
});
