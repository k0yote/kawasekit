/**
 * `KawasekitSessionEnvelope` — kawasekit's typed wrapper around ZeroDev's
 * opaque `serializePermissionAccount` blob.
 *
 * Why wrap ZeroDev's blob rather than use it directly?
 *
 * - **Fail-fast on restore**: chainId / version / signer mismatches surface as
 *   typed errors instead of confusing UserOp-time reverts.
 * - **Host-UI affordances**: `expiresAt` and `policySummary` are advisory
 *   fields a wallet can render ("this session expires in 2 hours, max 100
 *   JPYC/day") before handing the blob to {@link restoreSessionAccount}.
 * - **Version pin**: when ZeroDev changes their serialization format we bump
 *   {@link KAWASEKIT_SESSION_ENVELOPE_VERSION} and provide a migration; the
 *   inner `serialized` field stays opaque.
 *
 * Wire format: a single JSON string. Bigint fields (`expiresAt`,
 * `policySummary.maxPerTransfer`) round-trip via decimal-string encoding so
 * the JSON itself is portable through any transport (env var, HTTP header,
 * file).
 *
 * @packageDocumentation
 */

import { type Address, isAddress } from "viem";
import { isSupportedChainId, type SupportedChainId } from "../chains";
import { SessionEnvelopeParseError, SessionEnvelopeVersionError } from "./errors";

/**
 * Current envelope format version. Bumped when the envelope schema changes
 * in a way that breaks backward compatibility.
 */
export const KAWASEKIT_SESSION_ENVELOPE_VERSION = "1" as const;

/** Type of {@link KAWASEKIT_SESSION_ENVELOPE_VERSION}. */
export type KawasekitSessionEnvelopeVersion = typeof KAWASEKIT_SESSION_ENVELOPE_VERSION;

/**
 * Advisory summary of the spending policy attached to a session key. Useful
 * for host UI; **not** consulted at validation time (the on-chain validator
 * is the source of truth).
 */
export interface KawasekitSessionPolicySummary {
	readonly jpycAddress: Address;
	readonly maxPerTransfer: bigint;
	readonly maxTransfersPerDay: number;
}

/** kawasekit's typed envelope around a ZeroDev session-key serialization. */
export interface KawasekitSessionEnvelope {
	readonly kawasekitVersion: KawasekitSessionEnvelopeVersion;
	readonly chainId: SupportedChainId;
	readonly smartAccountAddress: Address;
	readonly sessionKeyAddress: Address;
	/** Optional unix-seconds expiry. Advisory + ideally enforced by a `TimestampPolicy`. */
	readonly expiresAt?: bigint;
	readonly policySummary?: KawasekitSessionPolicySummary;
	/** Opaque ZeroDev `serializePermissionAccount` output. */
	readonly serialized: string;
}

// ---------------------------------------------------------------------------
// Wire (JSON) shape
// ---------------------------------------------------------------------------

/**
 * Internal: the JSON shape we (de)serialize to/from. Bigint fields are stored
 * as decimal strings. Kept separate from {@link KawasekitSessionEnvelope} so
 * the public type stays bigint-friendly while the wire stays string-only.
 */
interface SessionEnvelopeJson {
	readonly kawasekitVersion: string;
	readonly chainId: number;
	readonly smartAccountAddress: string;
	readonly sessionKeyAddress: string;
	readonly expiresAt?: string;
	readonly policySummary?: {
		readonly jpycAddress: string;
		readonly maxPerTransfer: string;
		readonly maxTransfersPerDay: number;
	};
	readonly serialized: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UINT_DECIMAL = /^(0|[1-9][0-9]*)$/;

function assertAddress(value: unknown, field: string): Address {
	if (typeof value !== "string" || !isAddress(value, { strict: false })) {
		throw new SessionEnvelopeParseError(`\`${field}\` is not a valid address: ${String(value)}`);
	}
	return value as Address;
}

function assertString(value: unknown, field: string): string {
	if (typeof value !== "string" || value === "") {
		throw new SessionEnvelopeParseError(`\`${field}\` must be a non-empty string`);
	}
	return value;
}

function assertNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new SessionEnvelopeParseError(`\`${field}\` must be a finite number`);
	}
	return value;
}

function parseBigIntString(value: unknown, field: string): bigint {
	if (typeof value !== "string" || !UINT_DECIMAL.test(value)) {
		throw new SessionEnvelopeParseError(
			`\`${field}\` must be a non-negative decimal string: ${String(value)}`,
		);
	}
	return BigInt(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialises a {@link KawasekitSessionEnvelope} to a transportable JSON string.
 *
 * The output is plain UTF-8 JSON (no base64). Callers who need
 * URL-/header-safe transport can base64-encode the result themselves.
 *
 * @example
 * ```ts
 * import { serializeSessionEnvelope } from "kawasekit";
 *
 * const blob = serializeSessionEnvelope(envelope);
 * fs.writeFileSync("agent.session", blob);
 * ```
 */
export function serializeSessionEnvelope(envelope: KawasekitSessionEnvelope): string {
	const json: SessionEnvelopeJson = {
		kawasekitVersion: envelope.kawasekitVersion,
		chainId: envelope.chainId,
		smartAccountAddress: envelope.smartAccountAddress,
		sessionKeyAddress: envelope.sessionKeyAddress,
		serialized: envelope.serialized,
		...(envelope.expiresAt !== undefined ? { expiresAt: envelope.expiresAt.toString() } : {}),
		...(envelope.policySummary !== undefined
			? {
					policySummary: {
						jpycAddress: envelope.policySummary.jpycAddress,
						maxPerTransfer: envelope.policySummary.maxPerTransfer.toString(),
						maxTransfersPerDay: envelope.policySummary.maxTransfersPerDay,
					},
				}
			: {}),
	};
	return JSON.stringify(json);
}

/**
 * Parses a JSON string back into a {@link KawasekitSessionEnvelope}, asserting
 * shape and version invariants.
 *
 * @throws {SessionEnvelopeParseError} On malformed JSON or structural errors.
 * @throws {SessionEnvelopeVersionError} On `kawasekitVersion` mismatch.
 *
 * @example
 * ```ts
 * import { parseSessionEnvelope } from "kawasekit";
 *
 * const envelope = parseSessionEnvelope(fs.readFileSync("agent.session", "utf8"));
 * ```
 */
export function parseSessionEnvelope(input: string): KawasekitSessionEnvelope {
	let raw: unknown;
	try {
		raw = JSON.parse(input);
	} catch (cause) {
		throw new SessionEnvelopeParseError("input is not valid JSON", { cause });
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new SessionEnvelopeParseError("input is not a JSON object");
	}
	const obj = raw as {
		kawasekitVersion?: unknown;
		chainId?: unknown;
		smartAccountAddress?: unknown;
		sessionKeyAddress?: unknown;
		serialized?: unknown;
		expiresAt?: unknown;
		policySummary?: unknown;
	};

	if (obj.kawasekitVersion !== KAWASEKIT_SESSION_ENVELOPE_VERSION) {
		throw new SessionEnvelopeVersionError(KAWASEKIT_SESSION_ENVELOPE_VERSION, obj.kawasekitVersion);
	}
	const chainIdNum = assertNumber(obj.chainId, "chainId");
	if (!isSupportedChainId(chainIdNum)) {
		throw new SessionEnvelopeParseError(`chainId ${chainIdNum} is not a kawasekit-supported chain`);
	}
	const chainId: SupportedChainId = chainIdNum;
	const smartAccountAddress = assertAddress(obj.smartAccountAddress, "smartAccountAddress");
	const sessionKeyAddress = assertAddress(obj.sessionKeyAddress, "sessionKeyAddress");
	const serialized = assertString(obj.serialized, "serialized");

	const expiresAt =
		obj.expiresAt !== undefined ? parseBigIntString(obj.expiresAt, "expiresAt") : undefined;

	let policySummary: KawasekitSessionPolicySummary | undefined;
	if (obj.policySummary !== undefined) {
		if (
			obj.policySummary === null ||
			typeof obj.policySummary !== "object" ||
			Array.isArray(obj.policySummary)
		) {
			throw new SessionEnvelopeParseError("`policySummary` must be a JSON object");
		}
		const ps = obj.policySummary as {
			jpycAddress?: unknown;
			maxPerTransfer?: unknown;
			maxTransfersPerDay?: unknown;
		};
		policySummary = {
			jpycAddress: assertAddress(ps.jpycAddress, "policySummary.jpycAddress"),
			maxPerTransfer: parseBigIntString(ps.maxPerTransfer, "policySummary.maxPerTransfer"),
			maxTransfersPerDay: assertNumber(ps.maxTransfersPerDay, "policySummary.maxTransfersPerDay"),
		};
	}

	const base = {
		kawasekitVersion: KAWASEKIT_SESSION_ENVELOPE_VERSION,
		chainId,
		smartAccountAddress,
		sessionKeyAddress,
		serialized,
	} as const;
	if (expiresAt !== undefined && policySummary !== undefined) {
		return { ...base, expiresAt, policySummary };
	}
	if (expiresAt !== undefined) {
		return { ...base, expiresAt };
	}
	if (policySummary !== undefined) {
		return { ...base, policySummary };
	}
	return base;
}
