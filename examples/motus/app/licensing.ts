/**
 * Motus — renderer usage.
 *
 * `electron-plugin-keygate/renderer` finds the bridge the preload
 * installed and hands back an API that deals in values and thrown
 * `KeygateError`s.
 */
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';
import type { KeygateLicense } from 'electron-plugin-keygate/renderer';

/**
 * The license state the UI renders from.
 *
 * `null` means unlicensed. `offline` means the state was restored from
 * the local cache and has not been confirmed with the server on this
 * launch — worth showing, because it tells the user the app is running
 * on a cached license.
 */
export type LicenseState =
	| { status: 'licensed'; license: KeygateLicense; offline: boolean }
	| { status: 'unlicensed'; reason: string }
	| { status: 'checking' };

/** Read the license the app starts with. */
export async function readLicense(): Promise<LicenseState> {
	try {
		const license = await keygate.getLicense();
		if (!license || !license.valid) {
			return { status: 'unlicensed', reason: 'no license is active' };
		}
		return { status: 'licensed', license, offline: license.offline };
	} catch (err) {
		return {
			status: 'unlicensed',
			reason: isKeygateError(err) ? err.detail : 'the license could not be read',
		};
	}
}

/**
 * Activate a license the customer pasted in.
 *
 * The key goes to the main process and is never stored in the renderer's
 * own storage — the main process encrypts it under the OS vault.
 */
export async function activateLicense(key: string): Promise<LicenseState> {
	try {
		const license = await keygate.activate({ key });
		return { status: 'licensed', license, offline: false };
	} catch (err) {
		if (!isKeygateError(err)) {
			return { status: 'unlicensed', reason: 'the license could not be activated' };
		}
		switch (err.code) {
			case 'LICENSE_EXPIRED':
			case 'LICENSE_CANCELED':
			case 'LICENSE_SUSPENDED':
			case 'LICENSE_REVOKED':
			case 'LICENSE_INVALID':
			case 'ACTIVATION_LIMIT':
			case 'DEVICE_HELD':
				// The customer has to act. These are not transient.
				return { status: 'unlicensed', reason: err.detail };
			default:
				// A network blip. Retrying later is reasonable.
				return { status: 'unlicensed', reason: err.detail };
		}
	}
}

/** Check in with the server, to pick up a renewal or a revocation. */
export async function refreshLicense(): Promise<LicenseState> {
	try {
		const license = await keygate.verify({});
		return { status: 'licensed', license, offline: false };
	} catch (err) {
		return {
			status: 'unlicensed',
			reason: isKeygateError(err) ? err.detail : 'the license could not be verified',
		};
	}
}

/**
 * Release this machine's activation slot.
 *
 * Worth offering when a customer is moving to a new machine: the slot
 * stays taken until it is released, and the license's device limit is
 * usually small.
 */
export async function releaseThisDevice(): Promise<boolean> {
	try {
		await keygate.deactivate({});
		return true;
	} catch {
		return false;
	}
}

/** Whether a feature is enabled. */
export async function hasFeature(feature: string): Promise<boolean> {
	const license = await keygate.getLicense();
	return license?.valid === true && license.entitlements.includes(feature);
}
