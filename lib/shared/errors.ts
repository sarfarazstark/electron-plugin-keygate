/**
 * Structured errors.
 *
 * Every failure that crosses a process boundary is `{ code, detail }`.
 * The code is a stable identifier a program can branch on; the detail is
 * a human-readable sentence. The detail never contains key material.
 */

export type KeygateErrorCode =
	/** Configuration is unusable — bad API URL, bad public key, no identifier. */
	| 'CONFIG'
	/** No licensing configuration in this build. */
	| 'LICENSING_DISABLED'
	/** The requesting frame is not a trusted main frame. */
	| 'UNTRUSTED_SENDER'
	/** This machine has no usable device identifier. */
	| 'NO_IDENTIFIER'
	/** The request never reached the server, or timed out. */
	| 'REQUEST_ERROR'
	/** The server answered with a status this package does not understand. */
	| 'HTTP_ERROR'
	/** The server answered 2xx with a body this package cannot use. */
	| 'BAD_RESPONSE'
	/** The signed token is malformed or its signature does not verify. */
	| 'BAD_TOKEN'
	/** The signed token is past its offline lifetime. */
	| 'TOKEN_EXPIRED'
	/** The cached offline state is past its lifetime or unverifiable. */
	| 'BAD_CACHE'
	/** The OS encryption vault is unusable. */
	| 'STORAGE_UNAVAILABLE'
	/** Stored ciphertext could not be decrypted. */
	| 'STORAGE_DECRYPT_FAILED'
	/** The license is not activated for this device. */
	| 'NOT_ACTIVATED'
	/** There is no license to act on. */
	| 'NO_LICENSE'
	/** The license term is over, grace included. */
	| 'EXPIRED'
	/** The server does not know this license. */
	| 'NOT_FOUND'
	/** Local filesystem or parse failure. */
	| 'ERR'
	/** The renderer has no preload bridge on this window. */
	| 'NO_KEYGATE_BRIDGE'
	/** No handler is registered for the channel. */
	| 'IPC_UNREACHABLE'
	/** The envelope was not shaped the way this package expects. */
	| 'unknown'
	/** Any code the Keygate server itself returned, verbatim. */
	| (string & {});

export interface KeygateErrorShape {
	code: KeygateErrorCode;
	detail: string;
}

/** The error type the renderer entry throws. */
export class KeygateError extends Error implements KeygateErrorShape {
	readonly code: KeygateErrorCode;
	readonly detail: string;

	constructor(error: KeygateErrorShape) {
		super(`Keygate Error: ${error.code}: ${error.detail}`);
		this.name = 'KeygateError';
		this.code = error.code;
		this.detail = error.detail;
	}
}

/**
 * Coerce anything thrown into a `KeygateError`.
 *
 * The `detail` of a non-Keygate error is the error's own message, which
 * keeps stack traces out of the renderer but leaves the reason intact.
 */
export function asKeygateError(err: unknown): KeygateError {
	if (err instanceof KeygateError) {
		return err;
	}
	if (isKeygateErrorShape(err)) {
		return new KeygateError(err);
	}
	if (err instanceof Error) {
		return new KeygateError({ code: 'ERR', detail: err.message });
	}
	if (typeof err === 'string' && err.length > 0) {
		return new KeygateError({ code: 'ERR', detail: err });
	}
	return new KeygateError({ code: 'unknown', detail: 'an unknown error occurred' });
}

/** Whether a value already carries the `{ code, detail }` shape. */
export function isKeygateErrorShape(err: unknown): err is KeygateErrorShape {
	if (typeof err !== 'object' || err === null) {
		return false;
	}
	const candidate = err as { code?: unknown; detail?: unknown };
	return typeof candidate.code === 'string' && typeof candidate.detail === 'string';
}

/**
 * Whether a thrown value is a `KeygateError`.
 *
 * Cross-realm safe: it checks the shape rather than the prototype, so a
 * renderer that received the error from another realm still recognises it.
 */
export function isKeygateError(err: unknown): err is KeygateErrorShape {
	return isKeygateErrorShape(err);
}
