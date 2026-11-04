/**
 * The preload bridge.
 *
 * This module has no `electron` import on purpose: the same code runs in
 * the unsandboxed ESM preload, in the sandboxed CommonJS preload, and in
 * tests, where there is no Electron at all. The `invoke` function is
 * passed in.
 */
import { KEYGATE_CHANNELS } from '../shared/types.ts';
import type {
	IpcResult,
	KeygateEntitlements,
	KeygateLicense,
} from '../shared/types.ts';

/** The `invoke` function the bridge is built on. */
export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * The object the preload installs on `window`.
 *
 * Every method resolves the envelope **untouched**. The unwrapping
 * happens in the renderer entry, because `contextBridge` strips custom
 * fields off thrown objects — a failure has to cross as data, not as a
 * thrown error.
 */
export interface KeygateBridge {
	getLicense(): Promise<IpcResult<KeygateLicense | null>>;
	getLicenseKey(): Promise<IpcResult<string | null>>;
	activate(options: { key: string; label?: string; identifier?: string }): Promise<IpcResult<KeygateLicense>>;
	verify(options?: { key?: string; identifier?: string }): Promise<IpcResult<KeygateLicense>>;
	deactivate(options?: { key?: string; identifier?: string }): Promise<IpcResult<null>>;
	getEntitlements(options?: { key?: string; feature?: string }): Promise<IpcResult<KeygateEntitlements>>;
	resetLicense(): Promise<IpcResult<null>>;
	resetLicenseKey(): Promise<IpcResult<null>>;
}

/**
 * Build the bridge over an `invoke` function.
 *
 * `invoke` is the Electron `ipcRenderer.invoke`, bound to
 * `ipcRenderer`.
 */
export function createKeygateBridge(invoke: Invoke): KeygateBridge {
	const call = async <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> => {
		const result = await invoke(channel, ...args);
		return result as IpcResult<T>;
	};

	return {
		getLicense: () => call<KeygateLicense | null>(KEYGATE_CHANNELS.getLicense),
		getLicenseKey: () => call<string | null>(KEYGATE_CHANNELS.getLicenseKey),
		activate: (options) => call<KeygateLicense>(KEYGATE_CHANNELS.activate, options),
		verify: (options) => call<KeygateLicense>(KEYGATE_CHANNELS.verify, options ?? {}),
		deactivate: (options) => call<null>(KEYGATE_CHANNELS.deactivate, options ?? {}),
		getEntitlements: (options) =>
			call<KeygateEntitlements>(KEYGATE_CHANNELS.getEntitlements, options ?? {}),
		resetLicense: () => call<null>(KEYGATE_CHANNELS.resetLicense),
		resetLicenseKey: () => call<null>(KEYGATE_CHANNELS.resetLicenseKey),
	};
}
