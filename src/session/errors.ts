/**
 * Typed errors thrown by the `kawasekit/session` modules.
 *
 * Centralised so consumers can `instanceof`-discriminate without importing
 * deep paths.
 *
 * @packageDocumentation
 */

import type { Address } from "viem";

/**
 * Thrown when {@link parseSessionEnvelope} encounters an envelope whose
 * `kawasekitVersion` does not match the current
 * {@link KAWASEKIT_SESSION_ENVELOPE_VERSION}.
 *
 * The version field is intentionally a string ("1") so that future migrations
 * can introduce non-numeric variants (e.g. "1-jwe") without breaking the
 * parser ordering.
 */
export class SessionEnvelopeVersionError extends Error {
	readonly expected: string;
	readonly received: unknown;

	constructor(expected: string, received: unknown) {
		super(
			`Session envelope version mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(received)}.`,
		);
		this.name = "SessionEnvelopeVersionError";
		this.expected = expected;
		this.received = received;
	}
}

/**
 * Thrown by `restoreSessionAccount()` when an envelope's `chainId` differs
 * from the chain the consumer is restoring on. Catches the common mistake of
 * issuing on Polygon Amoy and trying to restore on Polygon mainnet.
 */
export class SessionEnvelopeChainMismatchError extends Error {
	readonly envelopeChainId: number;
	readonly clientChainId: number;

	constructor(envelopeChainId: number, clientChainId: number) {
		super(
			`Session envelope is for chain ${envelopeChainId} but the restore client is on chain ${clientChainId}.`,
		);
		this.name = "SessionEnvelopeChainMismatchError";
		this.envelopeChainId = envelopeChainId;
		this.clientChainId = clientChainId;
	}
}

/**
 * Thrown by `restoreSessionAccount()` when the session-key signer the consumer
 * passes does not match the `sessionKeyAddress` recorded in the envelope.
 *
 * Defence against accidentally restoring with the wrong private key — which
 * would otherwise succeed locally and only fail at UserOp validation time.
 */
export class SessionEnvelopeSignerMismatchError extends Error {
	readonly envelopeSignerAddress: Address;
	readonly providedSignerAddress: Address;

	constructor(envelopeSignerAddress: Address, providedSignerAddress: Address) {
		super(
			`Session envelope was issued for signer ${envelopeSignerAddress}, but the provided session-key signer is ${providedSignerAddress}.`,
		);
		this.name = "SessionEnvelopeSignerMismatchError";
		this.envelopeSignerAddress = envelopeSignerAddress;
		this.providedSignerAddress = providedSignerAddress;
	}
}

/**
 * Thrown when {@link parseSessionEnvelope} cannot decode the input as a
 * structurally valid envelope (malformed JSON, missing fields, bad types).
 */
export class SessionEnvelopeParseError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(`Failed to parse session envelope: ${reason}`, options);
		this.name = "SessionEnvelopeParseError";
		this.reason = reason;
	}
}
