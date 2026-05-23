/**
 * Anvil lifecycle helper for unit tests.
 *
 * Wraps `prool` so a test file can call `startAnvil()` in `beforeAll` and
 * `stopAnvil()` in `afterAll`. The default port is chosen to not collide with
 * a typical local anvil running on 8545.
 */

import { Instance } from "prool";

type AnvilInstance = ReturnType<typeof Instance.anvil>;

let active: AnvilInstance | null = null;

export interface AnvilHandle {
	readonly rpcUrl: string;
	readonly chainId: number;
}

export interface StartAnvilOptions {
	readonly port?: number;
	readonly chainId?: number;
}

export async function startAnvil(opts: StartAnvilOptions = {}): Promise<AnvilHandle> {
	if (active !== null) {
		throw new Error("anvil is already running. Call stopAnvil() before starting another instance.");
	}
	const chainId = opts.chainId ?? 31_337;
	const instance = Instance.anvil({
		port: opts.port ?? 8556,
		chainId,
	});
	await instance.start();
	active = instance;
	return {
		rpcUrl: `http://${instance.host}:${instance.port}`,
		chainId,
	};
}

export async function stopAnvil(): Promise<void> {
	if (active === null) {
		return;
	}
	await active.stop();
	active = null;
}
