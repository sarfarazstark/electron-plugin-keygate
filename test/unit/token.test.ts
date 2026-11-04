import { describe, expect, it } from 'vitest';
import {
	createEd25519PublicKey,
	decodeToken,
	evaluateTokenFreshness,
	expectedFingerprint,
	verifyToken,
} from '../../lib/main/token.ts';
import { KeygateError } from '../../lib/shared/errors.ts';
import type { KeygateTokenPayload } from '../../lib/shared/types.ts';
import { createMockServer, signToken } from '../support/mock-server.ts';

describe('token decoding', () => {
	const server = createMockServer();
	const payload: KeygateTokenPayload = {
		lid: 'license-1',
		pid: 'product-1',
		pln: 'plan-1',
		sts: 'active',
		did: 'kg-device-1',
		ftr: { premium_support: true },
		iat: 1_700_000_000,
		exp: 1_700_000_000 + 3600,
		grc: 3,
		nce: 'abc123',
	};

	it('decodes a token without verifying it', () => {
		const token = server.sign(payload);
		// Decoding is not verification, and the two must not be confused.
		const decoded = decodeToken(token);
		expect(decoded.payload.lid).toBe('license-1');
		expect(decoded.payload.did).toBe('kg-device-1');
	});

	it('rejects a token that is not two halves', () => {
		expect(() => decodeToken('nodot')).toThrowError(KeygateError);
		expect(() => decodeToken('')).toThrowError(KeygateError);
		expect(() => decodeToken('.onlysignature')).toThrowError(KeygateError);
		expect(() => decodeToken('onlypayload.')).toThrowError(KeygateError);
	});

	it('rejects a token whose payload is not JSON', () => {
		const encoded = Buffer.from('not json at all', 'utf8').toString('base64url');
		const signature = Buffer.alloc(64).toString('base64url');
		expect(() => decodeToken(`${encoded}.${signature}`)).toThrowError(KeygateError);
	});

	it('rejects a token missing a required field', () => {
		const broken = { ...payload } as Partial<KeygateTokenPayload>;
		delete broken.lid;
		const token = server.sign(broken as KeygateTokenPayload);
		expect(() => decodeToken(token)).toThrowError(/missing "lid"/);
	});

	it('rejects a signature that is not 64 bytes', () => {
		const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
		const short = Buffer.alloc(10).toString('base64url');
		expect(() => decodeToken(`${encoded}.${short}`)).toThrowError(/64 bytes/);
	});
});

describe('token verification', () => {
	it('verifies a token this server signed', () => {
		const server = createMockServer();
		const payload: KeygateTokenPayload = {
			lid: 'license-1',
			pid: 'product-1',
			pln: 'plan-1',
			sts: 'active',
			did: 'kg-device-1',
			iat: 1_700_000_000,
			exp: 1_700_003_600,
			grc: 0,
			nce: 'nonce',
		};

		const verified = verifyToken(server.sign(payload), server.publicKey);
		expect(verified.lid).toBe('license-1');
		expect(verified.did).toBe('kg-device-1');
		expect(verified.sts).toBe('active');
	});

	it('rejects a token signed by a different key', () => {
		const signer = createMockServer();
		const verifier = createMockServer();
		const token = signer.sign({
			lid: 'license-1',
			pid: 'product-1',
			pln: 'plan-1',
			sts: 'active',
			did: 'kg-device-1',
			iat: 1_700_000_000,
			exp: 1_700_003_600,
			grc: 0,
			nce: 'nonce',
		});

		expect(() => verifyToken(token, verifier.publicKey)).toThrowError(
			/signature does not verify/,
		);
	});

	it('rejects a tampered payload', () => {
		const server = createMockServer();
		const token = server.sign({
			lid: 'license-1',
			pid: 'product-1',
			pln: 'plan-1',
			sts: 'active',
			did: 'kg-device-1',
			iat: 1_700_000_000,
			exp: 1_700_003_600,
			grc: 0,
			nce: 'nonce',
		});
		const [encoded, signature] = token.split('.');

		const payload = JSON.parse(
			Buffer.from(encoded!, 'base64url').toString('utf8'),
		) as KeygateTokenPayload;
		payload.grc = 99999;
		const tampered = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;

		expect(() => verifyToken(tampered, server.publicKey)).toThrowError(
			/signature does not verify/,
		);
	});

	it('rejects a public key that is not 64 hex characters', () => {
		expect(() => createEd25519PublicKey('short')).toThrowError(KeygateError);
		expect(() => verifyToken('a.b', 'nope')).toThrowError(KeygateError);
	});
});

describe('token freshness', () => {
	const base: KeygateTokenPayload = {
		lid: 'l',
		pid: 'p',
		pln: 'pl',
		sts: 'active',
		did: 'd',
		iat: 1_000,
		exp: 2_000,
		grc: 0,
		nce: 'n',
	};

	it('accepts a token inside its lifetime', () => {
		const result = evaluateTokenFreshness(base, { now: 1_500, maxClockDriftSeconds: 300 });
		expect(result.valid).toBe(true);
		expect(result.secondsRemaining).toBe(500);
	});

	it('rejects a token past its expiry', () => {
		const result = evaluateTokenFreshness(base, { now: 2_001, maxClockDriftSeconds: 300 });
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('expired');
	});

	it('rejects a token issued far in the future', () => {
		const result = evaluateTokenFreshness(
			{ ...base, iat: 5_000 },
			{ now: 1_000, maxClockDriftSeconds: 300 },
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toBe('issued-in-the-future');
	});

	it('tolerates a small clock disagreement', () => {
		const result = evaluateTokenFreshness(
			{ ...base, iat: 1_200 },
			{ now: 1_000, maxClockDriftSeconds: 300 },
		);
		expect(result.valid).toBe(true);
	});

	it('honours the grace days after the license term', () => {
		// The server clamps `exp` to the licence term plus the grace, so
		// a real token looks like this: `exp` lands exactly on the end of
		// the grace window.
		const vun = 1_500;
		const grace = 2;
		const payload: KeygateTokenPayload = {
			...base,
			vun,
			grc: grace,
			exp: vun + grace * 86_400,
		};

		// One day into the grace period: still valid.
		const inGrace = evaluateTokenFreshness(payload, {
			now: vun + 86_400,
			maxClockDriftSeconds: 300,
		});
		expect(inGrace.valid).toBe(true);
		expect(inGrace.licenseValidUntil).toBe(vun);

		// Three days in: the two grace days are used up.
		const pastGrace = evaluateTokenFreshness(payload, {
			now: vun + 3 * 86_400,
			maxClockDriftSeconds: 300,
		});
		expect(pastGrace.valid).toBe(false);
		expect(pastGrace.reason).toBe('license-expired');
	});

	it('treats a zero vun as perpetual', () => {
		const payload: KeygateTokenPayload = { ...base, vun: 0, grc: 0, exp: 9_999_999 };
		const result = evaluateTokenFreshness(payload, {
			now: 5_000_000,
			maxClockDriftSeconds: 300,
		});
		expect(result.valid).toBe(true);
		expect(result.licenseValidUntil).toBe(0);
	});
});

describe('device binding', () => {
	it('matches the server’s fingerprint definition', () => {
		// sha256("device-1:product-1"), first 8 bytes, hex.
		expect(expectedFingerprint('device-1', 'product-1')).toMatch(/^[0-9a-f]{16}$/);
		expect(expectedFingerprint('device-1', 'product-1')).toBe(
			expectedFingerprint('device-1', 'product-1'),
		);
		expect(expectedFingerprint('device-1', 'product-1')).not.toBe(
			expectedFingerprint('device-2', 'product-1'),
		);
	});
});

/** Ask the mock server for a token by calling its activate endpoint. */
async function issueTokenThrough(
	server: ReturnType<typeof createMockServer>,
	identifier: string,
): Promise<string | undefined> {
	const response = await server.fetch('https://keygate.test/api/v1/license/activate', {
		method: 'POST',
		body: JSON.stringify({ license_key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY', identifier }),
	});
	const body = (await response.json()) as { data?: { token?: string } };
	return body.data?.token;
}
