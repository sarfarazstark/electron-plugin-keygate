/**
 * Argument validation for the IPC boundary.
 *
 * The renderer is untrusted input: a compromised page can call any
 * channel with any payload. Every handler validates before it touches a
 * license, and a rejected call never reaches the service.
 *
 * Hand-rolled rather than pulled from a validation library so the package
 * ships with no runtime dependencies at all — `electron` stays the only
 * thing an app has to have.
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; detail: string };

const MAX_KEY_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_LABEL_LENGTH = 256;
const MAX_FEATURE_LENGTH = 128;

/**
 * Whether a string contains a control character — C0 (including NUL),
 * DEL, or the C1 range.
 *
 * Written as a codepoint scan rather than a regular expression: the
 * pattern would have to spell out raw control bytes, and a source file
 * carrying a literal NUL is a hazard in its own right.
 */
function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			return true;
		}
	}
	return false;
}

function ok<T>(value: T): Validated<T> {
	return { ok: true, value };
}

function fail<T>(detail: string): Validated<T> {
	return { ok: false, detail };
}

/** A plain object, not an array and not null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an optional string field, rejecting the wrong type, an over-long
 * value and anything with control characters in it.
 */
function readOptionalString(
	source: Record<string, unknown>,
	field: string,
	maxLength: number,
): Validated<string | undefined> {
	const value = source[field];
	if (value === undefined || value === null) {
		return ok(undefined);
	}
	if (typeof value !== 'string') {
		return fail(`${field} must be a string`);
	}
	if (value.length > maxLength) {
		return fail(`${field} must be at most ${maxLength} characters`);
	}
	if (hasControlCharacters(value)) {
		return fail(`${field} must not contain control characters`);
	}
	return ok(value);
}

function readRequiredString(
	source: Record<string, unknown>,
	field: string,
	maxLength: number,
): Validated<string> {
	const value = source[field];
	if (typeof value !== 'string') {
		return fail(`${field} is required and must be a string`);
	}
	if (value.length > maxLength) {
		return fail(`${field} must be at most ${maxLength} characters`);
	}
	if (hasControlCharacters(value)) {
		return fail(`${field} must not contain control characters`);
	}
	return ok(value);
}

/** The arguments for a channel that takes none. */
export function validateNoArgs(args: unknown[]): Validated<undefined> {
	if (!Array.isArray(args) || args.length === 0) {
		return ok(undefined);
	}
	// Electron hands over an empty array when the channel is invoked with
	// no arguments, but a caller that passes one `undefined` means the
	// same thing.
	if (args.length === 1 && args[0] === undefined) {
		return ok(undefined);
	}
	return fail('this channel takes no arguments');
}

/** `keygate:activate` — `{ key, label?, identifier? }`. */
export function validateActivateArgs(args: unknown[]): Validated<{
	key: string;
	label?: string;
	identifier?: string;
}> {
	if (!Array.isArray(args) || args.length !== 1) {
		return fail('expected exactly one argument object');
	}
	const source = args[0];
	if (!isPlainObject(source)) {
		return fail('expected an argument object');
	}
	const key = readRequiredString(source, 'key', MAX_KEY_LENGTH);
	if (!key.ok) {
		return fail(key.detail);
	}
	const label = readOptionalString(source, 'label', MAX_LABEL_LENGTH);
	if (!label.ok) {
		return fail(label.detail);
	}
	const identifier = readOptionalString(source, 'identifier', MAX_IDENTIFIER_LENGTH);
	if (!identifier.ok) {
		return fail(identifier.detail);
	}
	const result: { key: string; label?: string; identifier?: string } = { key: key.value };
	if (label.value !== undefined) {
		result.label = label.value;
	}
	if (identifier.value !== undefined) {
		result.identifier = identifier.value;
	}
	return ok(result);
}

/** `keygate:verify` — `{ key?, identifier? }`. */
export function validateVerifyArgs(args: unknown[]): Validated<{ key?: string; identifier?: string }> {
	if (!Array.isArray(args) || args.length !== 1) {
		return fail('expected exactly one argument object');
	}
	const source = args[0];
	if (!isPlainObject(source)) {
		return fail('expected an argument object');
	}
	const key = readOptionalString(source, 'key', MAX_KEY_LENGTH);
	if (!key.ok) {
		return fail(key.detail);
	}
	const identifier = readOptionalString(source, 'identifier', MAX_IDENTIFIER_LENGTH);
	if (!identifier.ok) {
		return fail(identifier.detail);
	}
	const result: { key?: string; identifier?: string } = {};
	if (key.value !== undefined) {
		result.key = key.value;
	}
	if (identifier.value !== undefined) {
		result.identifier = identifier.value;
	}
	return ok(result);
}

/** `keygate:deactivate` — `{ key?, identifier? }`. */
export function validateDeactivateArgs(
	args: unknown[],
): Validated<{ key?: string; identifier?: string }> {
	return validateVerifyArgs(args);
}

/** `keygate:get-entitlements` — `{ key?, feature? }`. */
export function validateGetEntitlementsArgs(
	args: unknown[],
): Validated<{ key?: string; feature?: string }> {
	if (!Array.isArray(args) || args.length !== 1) {
		return fail('expected exactly one argument object');
	}
	const source = args[0];
	if (!isPlainObject(source)) {
		return fail('expected an argument object');
	}
	const key = readOptionalString(source, 'key', MAX_KEY_LENGTH);
	if (!key.ok) {
		return fail(key.detail);
	}
	const feature = readOptionalString(source, 'feature', MAX_FEATURE_LENGTH);
	if (!feature.ok) {
		return fail(feature.detail);
	}
	const result: { key?: string; feature?: string } = {};
	if (key.value !== undefined) {
		result.key = key.value;
	}
	if (feature.value !== undefined) {
		result.feature = feature.value;
	}
	return ok(result);
}
