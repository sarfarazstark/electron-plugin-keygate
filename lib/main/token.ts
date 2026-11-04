/**
 * Keygate's signed-token verification.
 *
 * The wire format, from the server's `license.Sign`:
 *
 *     <base64url(payload-json)>.<base64url(ed25519-signature)>
 *
 * Two details matter and both are easy to get wrong:
 *
 *  1. The signed bytes are the **base64url payload string**, not the raw
 *     JSON. Verifying against the decoded JSON instead fails against a
 *     real server on every token.
 *  2. The encoding is base64**url** without padding, and the separator is
 *     a single `.`.
 *
 * The payload is Keygate's own short-field JSON: `lid`, `pid`, `pln`,
 * `sts`, `did`, `ftr`, `iat`, `exp`, `vun`, `upd`, `grc`, `nce`, `fpr`.
 */
import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { KeygateError } from '../shared/errors.ts';
import type { KeygateTokenPayload } from '../shared/types.ts';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The payload fields the server always writes. */
const REQUIRED_FIELDS = ['lid', 'pid', 'pln', 'sts', 'did', 'iat', 'exp', 'grc', 'nce'] as const;

/**
 * The public key in the shape Node's crypto wants.
 *
 * Ed25519 keys are 32 raw bytes; Node's DER form wraps them in a fixed
 * 12-byte SPKI header. Hex from the server is raw bytes, so the header
 * is what turns it into something `createPublicKey` accepts.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface DecodedToken {
	payload: KeygateTokenPayload;
	/** The base64url payload half, exactly as it arrived. */
	encodedPayload: string;
}

/** Build a Node public key from a hex Ed25519 key. */
export function createEd25519PublicKey(hexPublicKey: string): ReturnType<typeof createPublicKey> {
	const cleaned = hexPublicKey.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(cleaned)) {
		throw new KeygateError({
			code: 'CONFIG',
			detail: 'the public key must be 64 hex characters (a 32-byte Ed25519 key)',
		});
	}
	const raw = Buffer.from(cleaned, 'hex');
	const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
	return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Decode a token without checking its signature.
 *
 * Used by tests and by callers that want to look at the payload before
 * deciding whether to trust it. Never treat the result as verified.
 */
export function decodeToken(raw: string): DecodedToken {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new KeygateError({ code: 'BAD_TOKEN', detail: 'the token is empty' });
	}

	// The separator is the last `.` — base64url never contains one, so
	// the split is unambiguous either way.
	const separator = trimmed.lastIndexOf('.');
	if (separator <= 0 || separator === trimmed.length - 1) {
		throw new KeygateError({
			code: 'BAD_TOKEN',
			detail: 'the token is not in the "<payload>.<signature>" form',
		});
	}

	const encodedPayload = trimmed.slice(0, separator);
	const encodedSignature = trimmed.slice(separator + 1);

	if (!BASE64URL.test(encodedPayload) || !BASE64URL.test(encodedSignature)) {
		throw new KeygateError({
			code: 'BAD_TOKEN',
			detail: 'the token contains characters that are not base64url',
		});
	}

	let payloadJson: string;
	let signature: Buffer;
	try {
		payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
		signature = Buffer.from(encodedSignature, 'base64url');
	} catch {
		throw new KeygateError({ code: 'BAD_TOKEN', detail: 'the token could not be decoded' });
	}

	if (signature.length !== 64) {
		throw new KeygateError({
			code: 'BAD_TOKEN',
			detail: `the signature must be 64 bytes, got ${signature.length}`,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		throw new KeygateError({ code: 'BAD_TOKEN', detail: 'the token payload is not valid JSON' });
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new KeygateError({ code: 'BAD_TOKEN', detail: 'the token payload is not an object' });
	}

	const payload = parsed as KeygateTokenPayload;
	for (const field of REQUIRED_FIELDS) {
		if (payload[field] === undefined || payload[field] === null) {
			throw new KeygateError({
				code: 'BAD_TOKEN',
				detail: `the token payload is missing "${field}"`,
			});
		}
	}
	if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
		throw new KeygateError({
			code: 'BAD_TOKEN',
			detail: 'the token payload has a non-numeric timestamp',
		});
	}
	if (payload.ftr !== undefined && (typeof payload.ftr !== 'object' || payload.ftr === null)) {
		throw new KeygateError({
			code: 'BAD_TOKEN',
			detail: 'the token payload has a malformed feature map',
		});
	}

	return { payload, encodedPayload };
}

/**
 * Verify a token's signature and return its payload.
 *
 * The signature covers the base64url payload half, which is why
 * `decodeToken` hands that half back alongside the parsed payload.
 */
export function verifyToken(raw: string, hexPublicKey: string): KeygateTokenPayload {
	const { payload, encodedPayload } = decodeToken(raw);
	const separator = raw.trim().lastIndexOf('.');
	const encodedSignature = raw.trim().slice(separator + 1);
	const signature = Buffer.from(encodedSignature, 'base64url');

	let publicKey: ReturnType<typeof createPublicKey>;
	try {
		publicKey = createEd25519PublicKey(hexPublicKey);
	} catch (err) {
		if (err instanceof KeygateError) {
			throw err;
		}
		throw new KeygateError({
			code: 'CONFIG',
			detail: 'the public key could not be loaded',
		});
	}

	// `null` is the algorithm for Ed25519 — there is only one.
	const ok = ed25519Verify(null, Buffer.from(encodedPayload, 'utf8'), publicKey, signature);
	if (!ok) {
		throw new KeygateError({
			code: 'BAD_TOKEN',
			detail: 'the token signature does not verify against the public key',
		});
	}

	return payload;
}

export interface TokenFreshnessOptions {
	/** The current time, in unix seconds. */
	now: number;
	/** How far the local clock may disagree with the server's. */
	maxClockDriftSeconds: number;
}

export interface TokenFreshness {
	/** Whether the token may still be used. */
	valid: boolean;
	/** Why not, when `valid` is false. */
	reason?: 'expired' | 'issued-in-the-future' | 'license-expired';
	/** Seconds until the token stops being usable. Zero once it has. */
	secondsRemaining: number;
	/** When the license itself lapses, in unix seconds. Zero when perpetual. */
	licenseValidUntil: number;
}

/**
 * How long a verified token may still be used.
 *
 * Two clocks matter, and the server keeps them distinct on purpose:
 *
 *  - `exp` is the **check-in interval** — how long the client may stay
 *    offline before it has to verify again.
 *  - `vun` is the **license term** — when the license itself lapses.
 *
 * The server clamps `exp` so it never outlives `vun` plus grace, so
 * honouring `exp` is enough on its own. Both are checked here anyway:
 * a client that only honoured `exp` would keep a revoked license alive
 * for the remainder of the check-in window, and the grace days the
 * server granted are the only thing allowed to extend the license term.
 */
export function evaluateTokenFreshness(
	payload: KeygateTokenPayload,
	options: TokenFreshnessOptions,
): TokenFreshness {
	const { now, maxClockDriftSeconds } = options;
	const graceSeconds = Math.max(0, payload.grc ?? 0) * 86_400;
	const licenseValidUntil = payload.vun && payload.vun > 0 ? payload.vun : 0;

	// A token issued in the future beyond the tolerated drift means the
	// local clock is behind, or the token was minted by someone else.
	if (payload.iat > now + maxClockDriftSeconds) {
		return {
			valid: false,
			reason: 'issued-in-the-future',
			secondsRemaining: 0,
			licenseValidUntil,
		};
	}

	// The license term, with the grace the server granted.
	if (licenseValidUntil > 0 && now > licenseValidUntil + graceSeconds) {
		return {
			valid: false,
			reason: 'license-expired',
			secondsRemaining: 0,
			licenseValidUntil,
		};
	}

	if (now > payload.exp) {
		return {
			valid: false,
			reason: 'expired',
			secondsRemaining: 0,
			licenseValidUntil,
		};
	}

	return {
		valid: true,
		secondsRemaining: payload.exp - now,
		licenseValidUntil,
	};
}

/**
 * The device binding the server computed into the token.
 *
 * `sha256(identifier + ":" + product_id)`, first 8 bytes, hex. The
 * server writes it; a client can check that the token it holds was
 * issued for the identifier and product it thinks it was.
 */
export function expectedFingerprint(identifier: string, productId: string): string {
	const digest = createHash('sha256').update(`${identifier}:${productId}`, 'utf8').digest();
	return digest.subarray(0, 8).toString('hex');
}

/**
 * Check that a token was issued for this device and product.
 *
 * The server binds the token to the pair with `fpr`. A token whose
 * binding does not match was issued for a different device, or a
 * different product, and must not be used here.
 *
 * The signature proves the server issued the token. This proves it
 * issued it *for this device*: without it, a token copied from another
 * machine would verify perfectly well and would leave this machine
 * looking licensed.
 */
export function tokenBindingMatches(
	payload: KeygateTokenPayload,
	identifier: string,
): boolean {
	if (!payload.fpr) {
		// A token without a binding is not bound to anything. Refusing it
		// would break against a server that does not write one; accepting
		// it silently would drop the check. The identifier comparison
		// below still applies.
		return payload.did === identifier;
	}
	if (payload.did !== identifier) {
		return false;
	}
	return payload.fpr === expectedFingerprint(identifier, payload.pid);
}
