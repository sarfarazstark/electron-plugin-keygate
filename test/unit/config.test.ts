import { describe, expect, it } from 'vitest';
import {
	DEFAULT_API_URL,
	DEFAULT_MAX_CLOCK_DRIFT_SECONDS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	KeygateBuilder,
	configFromEnv,
	isHexPublicKey,
	normalizeApiUrl,
	resolveConfig,
} from '../../lib/main/config.ts';
import { KeygateError } from '../../lib/shared/errors.ts';

describe('resolveConfig', () => {
	it('defaults to the hosted Keygate server', () => {
		const config = resolveConfig({});
		expect(config.apiUrl).toBe(DEFAULT_API_URL);
		expect(config.publicKey).toBeNull();
		expect(config.identifier).toBeNull();
		expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
		expect(config.maxClockDriftSeconds).toBe(DEFAULT_MAX_CLOCK_DRIFT_SECONDS);
	});

	it('accepts a custom server', () => {
		const config = resolveConfig({ apiUrl: 'https://license.example.com' });
		expect(config.apiUrl).toBe('https://license.example.com');
	});

	it('strips a trailing slash from the API URL', () => {
		expect(resolveConfig({ apiUrl: 'https://license.example.com/' }).apiUrl).toBe(
			'https://license.example.com',
		);
		expect(normalizeApiUrl('https://license.example.com///')).toBe(
			'https://license.example.com',
		);
	});

	it('rejects a URL that is not a URL', () => {
		expect(() => resolveConfig({ apiUrl: 'not a url' })).toThrowError(KeygateError);
		expect(() => resolveConfig({ apiUrl: '' })).toThrowError(KeygateError);
	});

	it('rejects a scheme that is not http or https', () => {
		expect(() => resolveConfig({ apiUrl: 'ftp://license.example.com' })).toThrowError(
			/http or https/,
		);
	});

	it('rejects a public key that is not 64 hex characters', () => {
		expect(() => resolveConfig({ publicKey: 'abc' })).toThrowError(/64 hex characters/);
		expect(() => resolveConfig({ publicKey: 'z'.repeat(64) })).toThrowError(
			/64 hex characters/,
		);
	});

	it('accepts a 64-character hex public key and lowercases it', () => {
		const key = 'A'.repeat(64);
		expect(resolveConfig({ publicKey: key }).publicKey).toBe('a'.repeat(64));
	});

	it('treats an empty public key as unset', () => {
		expect(resolveConfig({ publicKey: '' }).publicKey).toBeNull();
		expect(resolveConfig({ publicKey: '   ' }).publicKey).toBeNull();
	});

	it('clamps the request timeout into a sane range', () => {
		expect(resolveConfig({ requestTimeoutMs: 5 }).requestTimeoutMs).toBe(1_000);
		expect(resolveConfig({ requestTimeoutMs: 999_999 }).requestTimeoutMs).toBe(120_000);
		expect(resolveConfig({ requestTimeoutMs: Number.NaN }).requestTimeoutMs).toBe(
			DEFAULT_REQUEST_TIMEOUT_MS,
		);
	});

	it('rejects a negative clock drift', () => {
		expect(resolveConfig({ maxClockDriftSeconds: -1 }).maxClockDriftSeconds).toBe(
			DEFAULT_MAX_CLOCK_DRIFT_SECONDS,
		);
	});
});

describe('isHexPublicKey', () => {
	it('accepts 64 hex characters in either case', () => {
		expect(isHexPublicKey('a'.repeat(64))).toBe(true);
		expect(isHexPublicKey('F'.repeat(64))).toBe(true);
	});

	it('rejects anything else', () => {
		expect(isHexPublicKey('a'.repeat(63))).toBe(false);
		expect(isHexPublicKey('a'.repeat(65))).toBe(false);
		expect(isHexPublicKey('g'.repeat(64))).toBe(false);
	});
});

describe('configFromEnv', () => {
	it('returns null when the API URL is unset — that disables licensing', () => {
		expect(configFromEnv({})).toBeNull();
		expect(configFromEnv({ KEYGATE_PUBLIC_KEY: 'a'.repeat(64) })).toBeNull();
	});

	it('reads every setting', () => {
		const config = configFromEnv({
			KEYGATE_API_URL: 'https://license.example.com',
			KEYGATE_PUBLIC_KEY: 'b'.repeat(64),
			KEYGATE_IDENTIFIER: 'kg-abc',
			KEYGATE_REQUEST_TIMEOUT_MS: '5000',
			KEYGATE_MAX_CLOCK_DRIFT_SECONDS: '60',
		});
		expect(config).toEqual({
			apiUrl: 'https://license.example.com',
			publicKey: 'b'.repeat(64),
			identifier: 'kg-abc',
			requestTimeoutMs: 5000,
			maxClockDriftSeconds: 60,
		});
	});

	it('ignores a non-numeric timeout', () => {
		const config = configFromEnv({
			KEYGATE_API_URL: 'https://license.example.com',
			KEYGATE_REQUEST_TIMEOUT_MS: 'soon',
		});
		expect(config?.requestTimeoutMs).toBeUndefined();
	});
});

describe('KeygateBuilder', () => {
	it('builds a config', () => {
		const config = KeygateBuilder.new('https://license.example.com')
			.publicKey('c'.repeat(64))
			.identifier('kg-device')
			.requestTimeoutMs(4_000)
			.maxClockDriftSeconds(90)
			.build();
		expect(config.apiUrl).toBe('https://license.example.com');
		expect(config.publicKey).toBe('c'.repeat(64));
		expect(config.identifier).toBe('kg-device');
		expect(config.requestTimeoutMs).toBe(4_000);
		expect(config.maxClockDriftSeconds).toBe(90);
	});

	it('starts from a pinned public key', () => {
		expect(KeygateBuilder.withPublicKey('d'.repeat(64)).build().publicKey).toBe(
			'd'.repeat(64),
		);
	});

	it('refuses to build an unusable config', () => {
		expect(() => KeygateBuilder.new().publicKey('nope').build()).toThrowError(KeygateError);
	});
});
