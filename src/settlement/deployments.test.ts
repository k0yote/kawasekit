import { describe, expect, it } from "vitest";
import { polygon, polygonAmoy, supportedChains } from "../chains";
import {
	getSettlementAddress,
	SETTLEMENT_V1_ADDRESS,
	SettlementNotAvailableError,
	settlementDeployments,
} from "./deployments";

describe("settlement deployments", () => {
	it("has an entry for every supported chain, all at the one CREATE2 address", () => {
		for (const chain of supportedChains) {
			const deployment = settlementDeployments[chain.id];
			expect(deployment.chainId).toBe(chain.id);
			expect(deployment.address).toBe(SETTLEMENT_V1_ADDRESS);
		}
	});

	it("is live on Polygon Amoy only", () => {
		const live = supportedChains.filter((c) => settlementDeployments[c.id].isLive).map((c) => c.id);
		expect(live).toEqual([polygonAmoy.id]);
	});

	it("returns the address where it is live", () => {
		expect(getSettlementAddress(polygonAmoy.id)).toBe("0x25BA7329A4c5772945B9d2C0E80ec7dfd41EE485");
	});

	it("refuses a chain where the contract is not deployed — paying an address with no code would not fail loudly", () => {
		expect(() => getSettlementAddress(polygon.id)).toThrow(SettlementNotAvailableError);
		expect(() => getSettlementAddress(polygon.id)).toThrow(/not yet deployed on chain ID 137/);
	});
});
