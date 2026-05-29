/**
 * The reasoning-step idempotency **key authority** (M5-1).
 *
 * kawasekit cannot see the LLM intent — only the agent harness's `tool.execute`
 * boundary does. So the SDK is not a key *generator*; it is the *normalizer /
 * derivation authority*: given a deterministic request identity supplied by the
 * harness, it derives a stable, opaque key. The harness *sources* identity; the
 * SDK *normalizes and binds* it.
 *
 * `normalizeIntentText` is deliberately **non-semantic** (Unicode + whitespace
 * only). Idempotency needs *exact logical-request identity* — a semantic /
 * embedding match would either skip a legitimate payment (false collision) or
 * double-charge (false miss), both unacceptable for money.
 *
 * @packageDocumentation
 */

import { concatHex, type Hex, keccak256, stringToHex } from "viem";
import { IdempotencyConfigError } from "./errors";

/** Domain tag mixed into every derived key so it can never collide with another
 *  keccak preimage in the SDK (e.g. the EIP-3009 nonce derivation). */
const IDEMPOTENCY_KEY_DOMAIN_TAG = "kawasekit/idempotency-key/1";

/**
 * Deterministic, **non-semantic** normalization of an intent string:
 * Unicode NFC, trimmed, internal whitespace runs collapsed to a single space.
 *
 * **Not lowercased** — case can be meaning-bearing (identifiers, codes). This
 * function never attempts semantic equivalence; that is the caller's job via a
 * stable `stepId`.
 *
 * @example
 * ```ts
 * import { normalizeIntentText } from "kawasekit/idempotency";
 *
 * normalizeIntentText("  fetch_weather:  Tokyo \n"); // "fetch_weather: Tokyo"
 * ```
 */
export function normalizeIntentText(intent: string): string {
	return intent.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * The authoritative logical-request identity. The harness supplies these; the
 * SDK does not invent them.
 */
export interface CanonicalRequestIdentity {
	/** Stable per agent run / session. The cross-process dedup anchor. */
	readonly conversationId: string;
	/**
	 * Reasoning-step ordinal/identifier, stable for "the same logical step".
	 * The same step retried / replayed must carry the same `stepId`, or it is
	 * treated as a new payment. The harness owns numbering (see
	 * {@link createIdempotencyKeyBuilder}).
	 */
	readonly stepId: string;
	/** Optional human-meaningful label, folded in (normalized) for debuggability. */
	readonly intent?: string;
	/** Optional partition for parallel sub-agents / orchestrators. */
	readonly namespace?: string;
}

/** Stable, unambiguous string preimage for an identity (JSON array → no field
 *  boundary ambiguity). */
function canonicalIdentityString(identity: CanonicalRequestIdentity): string {
	if (identity.conversationId === "") {
		throw new IdempotencyConfigError("conversationId", "must be a non-empty string");
	}
	if (identity.stepId === "") {
		throw new IdempotencyConfigError("stepId", "must be a non-empty string");
	}
	return JSON.stringify([
		IDEMPOTENCY_KEY_DOMAIN_TAG,
		identity.conversationId,
		identity.stepId,
		identity.namespace ?? "",
		identity.intent !== undefined ? normalizeIntentText(identity.intent) : "",
	]);
}

/**
 * Derives the opaque wire idempotency key (`Idempotency-Key` header value) from
 * a request identity. Same identity ⇒ same key.
 *
 * Without a secret: `keccak256(domain ‖ canonical(identity))` — no plaintext
 * intent on the wire; forgery is bounded because a cached response is released
 * only after the server re-verifies a presented authorization. With a
 * `clientSecret`: a keccak-keyed hash `keccak256(secret ‖ preimage)` (Keccak/
 * SHA-3 is length-extension-resistant, so a prefix construction is a sound MAC;
 * KMAC is the rigorous upgrade) — unforgeable and not correlatable across
 * clients. The secret is **optional and off the fund path**: the on-chain
 * backstop ({@link deriveAuthorizationNonce}) never depends on it.
 *
 * @example
 * ```ts
 * import { deriveIdempotencyKey } from "kawasekit/idempotency";
 *
 * const key = deriveIdempotencyKey({
 *   conversationId: "conv-42",
 *   stepId: "3",
 *   intent: "fetch_weather:Tokyo",
 * });
 * ```
 */
export function deriveIdempotencyKey(
	identity: CanonicalRequestIdentity,
	clientSecret?: Hex,
): string {
	const preimage = stringToHex(canonicalIdentityString(identity));
	return clientSecret !== undefined
		? keccak256(concatHex([clientSecret, preimage]))
		: keccak256(preimage);
}

/** Parameters for {@link createIdempotencyKeyBuilder}. */
export interface CreateIdempotencyKeyBuilderParams {
	/** Stable per agent run. Reuse the SAME value across a regeneration so keys reproduce. */
	readonly conversationId: string;
	/** Optional HMAC-style secret (unforgeable wire keys); off the fund path. */
	readonly clientSecret?: Hex;
	/** Optional sub-agent / orchestrator partition. */
	readonly namespace?: string;
}

/** A per-conversation key dispenser. */
export interface IdempotencyKeyBuilder {
	/**
	 * Returns the key for the next reasoning step, assigning a monotonic
	 * `stepId` (`"0"`, `"1"`, …). Call once per logical step; reuse the returned
	 * string for retries of that step.
	 */
	next(intent?: string): string;
}

/**
 * Hands out keys + monotonic `stepId`s for one conversation. The harness adapter
 * calls `.next(intent)` once per tool execution.
 *
 * **stepId stability (Q4 hazard).** The counter resets to `0` per builder, so a
 * regeneration that replays the conversation **from the start** reproduces the
 * same `stepId`s (and therefore the same keys) — covering the "Regenerate"
 * scenario. A *partial* regeneration that does not replay from step 0 will NOT
 * reproduce them; in that case the harness must pin `stepId` explicitly via
 * {@link deriveIdempotencyKey}. Uncoordinated parallel orchestrators that reuse
 * `(conversationId, stepId)` for *different* intents collide — partition them
 * with `namespace`.
 *
 * @example
 * ```ts
 * import { createIdempotencyKeyBuilder } from "kawasekit/idempotency";
 *
 * const keys = createIdempotencyKeyBuilder({ conversationId: "conv-42" });
 * const k0 = keys.next("fetch_weather:Tokyo"); // stepId "0"
 * const k1 = keys.next("fetch_weather:Osaka"); // stepId "1"
 * ```
 */
export function createIdempotencyKeyBuilder(
	params: CreateIdempotencyKeyBuilderParams,
): IdempotencyKeyBuilder {
	if (params.conversationId === "") {
		throw new IdempotencyConfigError("conversationId", "must be a non-empty string");
	}
	let step = 0;
	return {
		next(intent?: string): string {
			const identity: CanonicalRequestIdentity = {
				conversationId: params.conversationId,
				stepId: String(step),
				...(intent !== undefined ? { intent } : {}),
				...(params.namespace !== undefined ? { namespace: params.namespace } : {}),
			};
			step += 1;
			return deriveIdempotencyKey(identity, params.clientSecret);
		},
	};
}
