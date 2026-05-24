/**
 * In-process HTTP listener helper for unit tests.
 *
 * Spawns `node:http` on `127.0.0.1:0` (ephemeral port), runs `fn` with the
 * resulting base URL, and tears the server down on completion or error.
 *
 * Used in place of `prool` for HTTP-layer tests (faster than spawning a child
 * process and easier to debug; anvil-based tests still use prool).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type HttpListenerHandler = (
	req: IncomingMessage,
	res: ServerResponse,
) => void | Promise<void>;

export async function withHttpListener<T>(
	handler: HttpListenerHandler,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const server = createServer((req, res) => {
		void Promise.resolve(handler(req, res)).catch((err) => {
			res.statusCode = 500;
			res.setHeader("content-type", "text/plain");
			res.end(`handler threw: ${err instanceof Error ? err.message : String(err)}`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	try {
		const address = server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		return await fn(baseUrl);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** Read the entire request body as a UTF-8 string. */
export async function readBody(req: IncomingMessage): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
