/**
 * The renderer entry.
 *
 * Application code imports this, not the bridge. It unwraps the envelope
 * so callers work with values and thrown `KeygateError`s:
 *
 *     import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';
 *
 *     try {
 *       const license = await keygate.activate({ key });
 *     } catch (err) {
 *       if (isKeygateError(err) && err.code === 'LICENSE_EXPIRED') { ... }
 *     }
 */
import { KeygateError, isKeygateErrorShape } from '../shared/errors.ts';
import type {
	KeygateEntitlements,
	KeygateLicense,
} from '../shared/types.ts';
import type { KeygateBridge } from '../preload/api.ts';

/** The API the renderer sees. */
export interface KeygateLicensingAPI {
	/** The license in force, or `null`. */
	getLicense(): Promise<KeygateLicense | null>;
	/** The cached license key, or `null`. */
	getLicenseKey(): Promise<string | null>;
	/** Activate a license on this device. */
	activate(options: {
		key: string;
		label?: string;
		identifier?: string;
		identifierType?: 'device' | 'user';
	}): Promise<KeygateLicense>;
	/** Verify a license against the server. */
	verify(options?: { key?: string; identifier?: string }): Promise<KeygateLicense>;
	/** Release this device's activation slot. */
	deactivate(options?: { key?: string; identifier?: string }): Promise<void>;
	/** The license's feature entitlements. */
	getEntitlements(options?: { key?: string; feature?: string }): Promise<KeygateEntitlements>;
	/** Forget the cached license state. Keeps the cached key. */
	resetLicense(): Promise<void>;
	/** Forget the cached license key too. */
	resetLicenseKey(): Promise<void>;
}

/** The bridge as it appears on `window`. */
declare global {
	// eslint-disable-next-line no-var
	var keygate: KeygateBridge | undefined;
}

/**
 * Unwrap an envelope, or throw.
 *
 * A failure envelope becomes a `KeygateError` carrying the server's own
 * code, so a caller can branch on `LICENSE_EXPIRED` or
 * `ACTIVATION_LIMIT` without parsing a message.
 */
async function unwrap<T>(operation: Promise<unknown>): Promise<T> {
	let result: unknown;
	try {
		result = await operation;
	} catch (err) {
		// No handler registered — Electron rejects the invoke.
		throw new KeygateError({
			code: 'IPC_UNREACHABLE',
			detail:
				err instanceof Error
					? `the licensing channel could not be reached: ${err.message}`
					: 'the licensing channel could not be reached',
		});
	}

	if (typeof result !== 'object' || result === null) {
		throw new KeygateError({
			code: 'unknown',
			detail: 'the licensing channel returned an unexpected answer',
		});
	}

	const envelope = result as { ok?: unknown; data?: unknown; error?: unknown };
	if (envelope.ok === true) {
		return envelope.data as T;
	}
	if (envelope.ok === false) {
		if (isKeygateErrorShape(envelope.error)) {
			throw new KeygateError(envelope.error);
		}
		throw new KeygateError({
			code: 'unknown',
			detail: 'the licensing channel returned a failure it could not describe',
		});
	}
	throw new KeygateError({
		code: 'unknown',
		detail: 'the licensing channel returned an envelope this package does not understand',
	});
}

/**
 * Build the API over a bridge.
 *
 * `null` — the window has no preload — produces an API whose every call
 * fails with `NO_KEYGATE_BRIDGE`, rather than a missing export.
 *
 * The bridge is read **per call** when a resolver is given, so a
 * preload that installs the bridge after this module is evaluated still
 * works. Electron runs the preload first, but a bundler that hoists
 * this module's evaluation above the preload's would otherwise see no
 * bridge at all.
 */
export function createKeygateLicensingApi(
	bridge: KeygateBridge | null | (() => KeygateBridge | null),
): KeygateLicensingAPI {
	const resolve = (): KeygateBridge | null =>
		typeof bridge === 'function' ? bridge() : bridge;

	const require = (): KeygateBridge => {
		const found = resolve();
		if (!found) {
			throw new KeygateError({
				code: 'NO_KEYGATE_BRIDGE',
				detail:
					'no keygate preload bridge is installed on this window; add the preload to the webPreferences',
			});
		}
		return found;
	};

	return {
		async getLicense() {
			return unwrap<KeygateLicense | null>(require().getLicense());
		},
		async getLicenseKey() {
			return unwrap<string | null>(require().getLicenseKey());
		},
		async activate(options) {
			return unwrap<KeygateLicense>(require().activate(options));
		},
		async verify(options) {
			return unwrap<KeygateLicense>(require().verify(options));
		},
		async deactivate(options) {
			await unwrap<null>(require().deactivate(options));
		},
		async getEntitlements(options) {
			return unwrap<KeygateEntitlements>(require().getEntitlements(options));
		},
		async resetLicense() {
			await unwrap<null>(require().resetLicense());
		},
		async resetLicenseKey() {
			await unwrap<null>(require().resetLicenseKey());
		},
	};
}

/**
 * The API bound to this window's bridge.
 *
 * The bridge is looked up on each call rather than captured here, so
 * the order in which the preload and this module are evaluated does not
 * matter.
 */
export const keygate: KeygateLicensingAPI = createKeygateLicensingApi(
	() => (typeof globalThis !== 'undefined' ? globalThis.keygate ?? null : null),
);

export { KeygateError, isKeygateError, asKeygateError } from '../shared/errors.ts';
export type { KeygateErrorCode, KeygateErrorShape } from '../shared/errors.ts';
export type {
	KeygateEntitlements,
	KeygateFeatureStatus,
	KeygateLicense,
} from '../shared/types.ts';
export { KEYGATE_CHANNELS } from '../shared/types.ts';
export type { KeygateBridge } from '../preload/api.ts';
