/**
 * Deploys the MockJPYC contract from the compiled artifact synced from
 * kawasekit-contracts (`script/sync-sdk-fixtures.sh`).
 *
 * The artifact is committed under `test/fixtures/` so SDK tests have no
 * runtime dependency on the contracts repo — but it can drift if the mock
 * changes. Re-run the sync script after editing MockJPYC.sol.
 */

import type {
	Abi,
	Account,
	Address,
	Chain,
	Hex,
	PublicClient,
	Transport,
	WalletClient,
} from "viem";
import MockJPYCArtifact from "../fixtures/MockJPYC.json";

export const mockJpycAbi = MockJPYCArtifact.abi as Abi;
export const mockJpycBytecode = MockJPYCArtifact.bytecode.object as Hex;

export async function deployMockJpyc(
	walletClient: WalletClient<Transport, Chain, Account>,
	publicClient: PublicClient,
): Promise<Address> {
	const hash = await walletClient.deployContract({
		abi: mockJpycAbi,
		bytecode: mockJpycBytecode,
	});
	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (!receipt.contractAddress) {
		throw new Error("MockJPYC deployment did not produce a contract address");
	}
	return receipt.contractAddress;
}
