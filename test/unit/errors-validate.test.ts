import { describe, expect, it } from 'vitest';
import { asKeygateError, isKeygateError, KeygateError } from '../../lib/shared/errors.ts';
import {
	validateActivateArgs,
	validateDeactivateArgs,
	validateGetEntitlementsArgs,
	validateNoArgs,
	validateVerifyArgs,
} from '../../lib/shared/validate.ts';

describe('error model', () => {
	it('carries a code and a detail', () => {
		const err = new KeygateError({ code: 'CONFIG', detail: 'the public key is wrong' });
		expect(err.code).toBe('CONFIG');
		expect(err.detail).toBe('the public key is wrong');
		expect(err.message).toBe('Keygate Error: CONFIG: the public key is wrong');
		expect(err).toBeInstanceOf(Error);
	});

	it('recognises its own shape', () => {
		const err = new KeygateError({ code: 'CONFIG', detail: 'x' });
		expect(isKeygateError(err)).toBe(true);
	});

	it('recognises the shape across realms, without the prototype', () => {
		// A renderer may receive the error from another realm, where
		// `instanceof KeygateError` is false but the shape is intact.
		const foreign = { code: 'LICENSE_EXPIRED', detail: 'the license has expired' };
		expect(isKeygateError(foreign)).toBe(true);
		expect(isKeygateError(foreign)).not.toBe(false);
	});

	it('rejects values that are not the shape', () => {
		expect(isKeygateError(null)).toBe(false);
		expect(isKeygateError(undefined)).toBe(false);
		expect(isKeygateError('nope')).toBe(false);
		expect(isKeygateError({ code: 'X' })).toBe(false);
		expect(isKeygateError({ code: 1, detail: 'x' })).toBe(false);
	});

	it('coerces anything into a KeygateError', () => {
		expect(asKeygateError(new KeygateError({ code: 'CONFIG', detail: 'x' })).code).toBe(
			'CONFIG',
		);
		expect(asKeygateError(new Error('boom')).code).toBe('ERR');
		expect(asKeygateError(new Error('boom')).detail).toBe('boom');
		expect(asKeygateError('boom').detail).toBe('boom');
		expect(asKeygateError(undefined).code).toBe('unknown');
		expect(asKeygateError({ code: 'X', detail: 'y' }).code).toBe('X');
	});
});

describe('argument validation', () => {
	it('accepts a channel with no arguments', () => {
		expect(validateNoArgs([]).ok).toBe(true);
		expect(validateNoArgs([undefined]).ok).toBe(true);
	});

	it('rejects arguments on a channel that takes none', () => {
		const result = validateNoArgs(['something']);
		expect(result.ok).toBe(false);
	});

	it('requires a key for activate', () => {
		expect(validateActivateArgs([{}]).ok).toBe(false);
		expect(validateActivateArgs([{ key: 'KG-ABC' }]).ok).toBe(true);
		expect(validateActivateArgs([{ key: 'KG-ABC', label: 'Workstation' }]).ok).toBe(true);
	});

	it('rejects a key that is not a string', () => {
		expect(validateActivateArgs([{ key: 123 }]).ok).toBe(false);
		expect(validateActivateArgs([{ key: null }]).ok).toBe(false);
	});

	it('rejects an over-long key', () => {
		expect(validateActivateArgs([{ key: 'a'.repeat(257) }]).ok).toBe(false);
		expect(validateActivateArgs([{ key: 'a'.repeat(256) }]).ok).toBe(true);
	});

	it('rejects control characters in a key', () => {
		// A NUL in the middle of a key is a truncation attempt.
		const withNul = `KG-AB${String.fromCharCode(0)}CD`;
		expect(validateActivateArgs([{ key: withNul }]).ok).toBe(false);
		// A newline could split a header if the key were ever echoed.
		expect(validateActivateArgs([{ key: 'KG-AB\nCD' }]).ok).toBe(false);
		expect(validateActivateArgs([{ key: 'KG-AB\rCD' }]).ok).toBe(false);
		expect(validateActivateArgs([{ key: `KG-AB${String.fromCharCode(127)}CD` }]).ok).toBe(false);
	});

	it('rejects a non-object argument', () => {
		expect(validateActivateArgs(['a string']).ok).toBe(false);
		expect(validateActivateArgs([null]).ok).toBe(false);
		expect(validateActivateArgs([[]]).ok).toBe(false);
	});

	it('rejects the wrong number of arguments', () => {
		expect(validateActivateArgs([]).ok).toBe(false);
		expect(validateActivateArgs([{ key: 'a' }, { key: 'b' }]).ok).toBe(false);
	});

	it('accepts verify and deactivate with no key', () => {
		expect(validateVerifyArgs([{}]).ok).toBe(true);
		expect(validateDeactivateArgs([{}]).ok).toBe(true);
		expect(validateVerifyArgs([{ key: 'KG-ABC' }]).ok).toBe(true);
	});

	it('accepts an entitlement feature', () => {
		const result = validateGetEntitlementsArgs([{ feature: 'premium_support' }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.feature).toBe('premium_support');
		}
	});

	it('rejects an over-long feature name', () => {
		expect(validateGetEntitlementsArgs([{ feature: 'a'.repeat(129) }]).ok).toBe(false);
	});
});
