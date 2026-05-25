/**
 * `x402Middleware()` — Hono adapter for {@link createX402Handler}.
 *
 * Thin shim (~40 LoC). All payment logic lives in `src/x402/server.ts`; this
 * file just bridges Hono's `(c, next) => void` middleware shape to that
 * factory's WHATWG `Request → Response` shape.
 *
 * `hono` is a **peer dependency** (optional). kawasekit does not import any
 * runtime code from `hono` — only its `MiddlewareHandler` type — so users who
 * never touch this subpath pay nothing.
 *
 * @packageDocumentation
 */

import type { MiddlewareHandler } from "hono";
import type { CreateX402HandlerParams, X402HandlerContext } from "../server";
import { createX402Handler } from "../server";

/** Default key under which the {@link X402HandlerContext} is stored on Hono's context. */
export const X402_HONO_CONTEXT_KEY = "x402" as const;

/**
 * Convenience env shape for a Hono app that uses this middleware with the
 * default `contextKey`. Spread into your `Hono<...>` generic so that
 * `c.get("x402")` is strongly typed:
 *
 * @example
 * ```ts
 * const app = new Hono<X402HonoEnv>();
 * app.get("/paid", (c) => {
 *   const settlement = c.get("x402").settlement; // typed
 * });
 * ```
 */
export interface X402HonoEnv {
	Variables: {
		[X402_HONO_CONTEXT_KEY]: X402HandlerContext;
	};
}

/** Parameters for {@link x402Middleware}. */
export interface X402MiddlewareParams extends Omit<CreateX402HandlerParams, "handler"> {
	/**
	 * Hono context variable key under which the {@link X402HandlerContext}
	 * is stored. Route handlers read it via `c.get(contextKey)`.
	 * Defaults to {@link X402_HONO_CONTEXT_KEY}.
	 */
	readonly contextKey?: string;
}

/**
 * Returns a Hono middleware that enforces the x402 v2 payment flow on every
 * request it matches. Mount it on the protected route or globally.
 *
 * After successful settlement the downstream route handler is invoked, and
 * the {@link X402HandlerContext} is available via `c.get(contextKey)`. When
 * `requirementsFor` returns `null` / `[]`, the middleware bypasses the
 * payment flow entirely and `c.get(contextKey)` is `undefined`.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import {
 *   buildPaymentRequirements,
 *   createSelfFacilitator,
 *   JPYC_DECIMALS,
 *   JPYC_V2_ADDRESS,
 *   polygonAmoy,
 * } from "kawasekit";
 * import { x402Middleware } from "kawasekit/x402/hono";
 * import { parseUnits } from "viem";
 *
 * const app = new Hono();
 * app.use(
 *   "/weather/*",
 *   x402Middleware({
 *     facilitator: createSelfFacilitator({ walletClient, publicClient }),
 *     requirementsFor: () => [
 *       buildPaymentRequirements({
 *         chainId: polygonAmoy.id,
 *         asset: JPYC_V2_ADDRESS,
 *         payTo: "0x...",
 *         amount: parseUnits("0.001", JPYC_DECIMALS),
 *       }),
 *     ],
 *   }),
 * );
 * app.get("/weather/:city", (c) => c.json({ city: c.req.param("city"), weather: "sunny" }));
 * ```
 */
export function x402Middleware(params: X402MiddlewareParams): MiddlewareHandler {
	const contextKey = params.contextKey ?? X402_HONO_CONTEXT_KEY;
	return async (c, next) => {
		const handler = createX402Handler({
			facilitator: params.facilitator,
			requirementsFor: params.requirementsFor,
			...(params.resourceFor ? { resourceFor: params.resourceFor } : {}),
			handler: async (_request, ctx) => {
				if (ctx !== null) {
					// Hono's `c.set` constrains `key` to `keyof Variables`. The
					// middleware can't predict the caller's Variables shape, so
					// the cast is the documented escape hatch — users who want
					// strong typing on `c.get(contextKey)` spread X402HonoEnv
					// into their `new Hono<...>()` generic.
					c.set(contextKey as never, ctx);
				}
				await next();
				return c.res;
			},
		});
		c.res = await handler(c.req.raw);
	};
}
