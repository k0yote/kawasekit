import { type Address, decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { polygon, polygonAmoy } from "../chains";
import type { ConfiguredKernelClient } from "../client/transfer-jpyc";
import { getJpycAddress, jpycAbi } from "../tokens/jpyc";
import { settlementAbi } from "./abi";
import { getSettlementAddress, SettlementNotAvailableError } from "./deployments";
import { hashOrderRef } from "./order-hash";
import {
	buildSettlementPaymentCalls,
	SettlementOrderRefMismatchError,
	SettleOrderInputError,
	settleOrder,
} from "./settle-order";

const PAYER: Address = "0x1111111111111111111111111111111111111111";
const MERCHANT: Address = "0x2222222222222222222222222222222222222222";
const DETAILS: Hex = `0x${"33".repeat(32)}`;
const NOW = 1_800_000_000;
const VALID_UNTIL = BigInt(NOW + 900);
const ONE_YEN = 10n ** 18n;

interface RecordedCall {
	readonly to: Address;
	readonly value: bigint;
	readonly data: Hex;
}

/**
 * A fake kernel client that RECORDS what it is asked to encode and send. The existing
 * `transferJpyc` fake answers every call with `"0x"`; that is enough to drive validation branches,
 * but not to prove what a payment actually consists of — which is the whole point here.
 */
function recordingClient(chainId: number = polygonAmoy.id) {
	const encoded: RecordedCall[][] = [];
	const sent: Hex[] = [];
	let waited = 0;
	const client = {
		chain: { id: chainId },
		account: {
			address: PAYER,
			encodeCalls: (calls: readonly RecordedCall[]) => {
				encoded.push([...calls]);
				return Promise.resolve("0xe9ae5c53" as const);
			},
		},
		sendUserOperation: (args: { callData: Hex }) => {
			sent.push(args.callData);
			return Promise.resolve(`0x${"ab".repeat(32)}` as const);
		},
		waitForUserOperationReceipt: () => {
			waited += 1;
			return Promise.resolve({
				receipt: { transactionHash: `0x${"cd".repeat(32)}` },
				success: true,
			});
		},
		// A structural fake: only the members `settleOrder` touches exist. Same cast the
		// `transferJpyc` tests use for the same reason.
	} as unknown as ConfiguredKernelClient;
	return { client, encoded, sent, waitedCount: () => waited };
}

const base = { merchant: MERCHANT, amount: ONE_YEN, validUntil: VALID_UNTIL, details: DETAILS };

function expectedRef(amount: bigint = ONE_YEN): Hex {
	return hashOrderRef({
		chainId: polygonAmoy.id,
		settlement: getSettlementAddress(polygonAmoy.id),
		order: {
			token: getJpycAddress(polygonAmoy.id),
			payer: PAYER,
			merchant: MERCHANT,
			amount,
			validUntil: VALID_UNTIL,
			details: DETAILS,
		},
	});
}

describe("settleOrder — what a payment consists of", () => {
	it("is ONE UserOp carrying exactly [approve(Settlement, amount), pay(…)], in that order", async () => {
		const { client, encoded, sent } = recordingClient();
		await settleOrder(client, { ...base, nowSeconds: NOW });

		expect(sent).toHaveLength(1);
		expect(encoded).toHaveLength(1);
		const calls = encoded[0];
		expect(calls).toHaveLength(2);
		const [approve, pay] = calls ?? [];

		expect(approve?.to).toBe(getJpycAddress(polygonAmoy.id));
		expect(approve?.value).toBe(0n);
		const a = decodeFunctionData({ abi: jpycAbi, data: approve?.data ?? "0x" });
		expect(a.functionName).toBe("approve");
		expect(a.args).toEqual([getSettlementAddress(polygonAmoy.id), ONE_YEN]);

		expect(pay?.to).toBe(getSettlementAddress(polygonAmoy.id));
		expect(pay?.value).toBe(0n);
		const p = decodeFunctionData({ abi: settlementAbi, data: pay?.data ?? "0x" });
		expect(p.functionName).toBe("pay");
		expect(p.args).toEqual([
			getJpycAddress(polygonAmoy.id),
			MERCHANT,
			ONE_YEN,
			VALID_UNTIL,
			DETAILS,
		]);
	});

	it("approves exactly what it pays — never more", async () => {
		const { client, encoded } = recordingClient();
		await settleOrder(client, { ...base, amount: 1234n * ONE_YEN, nowSeconds: NOW });
		const [approve, pay] = encoded[0] ?? [];
		const a = decodeFunctionData({ abi: jpycAbi, data: approve?.data ?? "0x" });
		const p = decodeFunctionData({ abi: settlementAbi, data: pay?.data ?? "0x" });
		expect(a.args?.[1]).toBe(1234n * ONE_YEN);
		expect(p.args?.[2]).toBe(1234n * ONE_YEN);
	});

	it("returns the ref computed with the ACCOUNT as payer — the contract hashes msg.sender", async () => {
		const { client } = recordingClient();
		const result = await settleOrder(client, { ...base, nowSeconds: NOW });
		expect(result.ref).toBe(expectedRef());
		expect(result.userOpHash).toBe(`0x${"ab".repeat(32)}`);
		expect(result.transactionHash).toBe(`0x${"cd".repeat(32)}`);
		expect(result.success).toBe(true);
	});

	it("waitForReceipt: false returns after submitting, with the ref already known", async () => {
		const { client, waitedCount } = recordingClient();
		const result = await settleOrder(client, { ...base, nowSeconds: NOW, waitForReceipt: false });
		expect(waitedCount()).toBe(0);
		expect(result).toEqual({
			ref: expectedRef(),
			userOpHash: `0x${"ab".repeat(32)}`,
			transactionHash: null,
			success: null,
		});
	});

	it("buildSettlementPaymentCalls is the same two calls — one definition of the shape", async () => {
		const { client, encoded } = recordingClient();
		await settleOrder(client, { ...base, nowSeconds: NOW });
		expect(encoded[0]).toEqual([
			...buildSettlementPaymentCalls({
				settlement: getSettlementAddress(polygonAmoy.id),
				token: getJpycAddress(polygonAmoy.id),
				...base,
			}),
		]);
	});
});

describe("settleOrder — the check before paying", () => {
	it("accepts a matching expectedRef, in any letter case", async () => {
		const { client, sent } = recordingClient();
		// Cast: `toUpperCase` widens a `0x…` template literal to `string`; the value is still hex.
		const upper = `0x${expectedRef().slice(2).toUpperCase()}` as Hex;
		await settleOrder(client, { ...base, nowSeconds: NOW, expectedRef: upper });
		expect(sent).toHaveLength(1);
	});

	it("throws SettlementOrderRefMismatchError BEFORE anything is encoded or sent", async () => {
		const { client, encoded, sent } = recordingClient();
		const wrong = expectedRef(2n * ONE_YEN); // the ref of a different amount
		const attempt = settleOrder(client, { ...base, nowSeconds: NOW, expectedRef: wrong });
		await expect(attempt).rejects.toThrow(SettlementOrderRefMismatchError);
		await attempt.catch((error: unknown) => {
			if (!(error instanceof SettlementOrderRefMismatchError)) throw error;
			expect(error.expected).toBe(wrong);
			expect(error.computed).toBe(expectedRef());
		});
		expect(encoded).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});
});

describe("settleOrder — input validation (nothing is sent)", () => {
	const cases: readonly [string, Parameters<typeof settleOrder>[1], RegExp][] = [
		// Cast: a deliberately malformed address, to drive the validation branch.
		["a malformed merchant", { ...base, merchant: "0xnope" as Address }, /merchant/],
		["a zero amount", { ...base, amount: 0n }, /amount.*positive/],
		["a negative amount", { ...base, amount: -1n }, /amount.*positive/],
		// Cast: a deliberately short hex string, to drive the validation branch.
		["details that is not 32 bytes", { ...base, details: "0x1234" as Hex }, /details.*32 bytes/],
		["an expired validUntil", { ...base, validUntil: BigInt(NOW - 1) }, /validUntil.*past/],
		["a validUntil that is exactly now", { ...base, validUntil: BigInt(NOW) }, /validUntil.*past/],
		["a validUntil beyond uint64", { ...base, validUntil: 2n ** 64n }, /validUntil.*uint64/],
		// Cast: a deliberately short hex string, to drive the validation branch.
		[
			"an expectedRef that is not 32 bytes",
			{ ...base, expectedRef: "0xabcd" as Hex },
			/expectedRef/,
		],
	];

	for (const [name, params, message] of cases) {
		it(`rejects ${name}`, async () => {
			const { client, sent } = recordingClient();
			const attempt = settleOrder(client, { ...params, nowSeconds: NOW });
			await expect(attempt).rejects.toThrow(SettleOrderInputError);
			await expect(settleOrder(client, { ...params, nowSeconds: NOW })).rejects.toThrow(message);
			expect(sent).toHaveLength(0);
		});
	}

	it("rejects a chain kawasekit does not support", async () => {
		const { client, sent } = recordingClient(31_337);
		await expect(settleOrder(client, { ...base, nowSeconds: NOW })).rejects.toThrow(
			/not a kawasekit-supported chain/,
		);
		expect(sent).toHaveLength(0);
	});

	it("refuses a supported chain where Settlement is not deployed yet", async () => {
		const { client, sent } = recordingClient(polygon.id);
		await expect(settleOrder(client, { ...base, nowSeconds: NOW })).rejects.toThrow(
			SettlementNotAvailableError,
		);
		expect(sent).toHaveLength(0);
	});

	it("uses the real clock when nowSeconds is omitted", async () => {
		const { client, sent } = recordingClient();
		const future = BigInt(Math.floor(Date.now() / 1000) + 900);
		await settleOrder(client, { ...base, validUntil: future });
		expect(sent).toHaveLength(1);
		await expect(settleOrder(client, { ...base, validUntil: 1n })).rejects.toThrow(/past/);
	});
});
