/**
 * The IPC boundary.
 *
 * Every handler does the same three things, in this order:
 *
 *   1. **Sender policy** — the requesting web contents must be in the
 *      trust list *and* the frame must be that window's main frame. An
 *      iframe gets no licensing access even inside a trusted window.
 *   2. **Argument validation** — the payload is checked before any
 *      license is touched.
 *   3. **Envelope** — success is `{ ok: true, data }`, failure is
 *      `{ ok: false, error: { code, detail } }`. Nothing throws across
 *      the boundary: `contextBridge` strips custom fields off thrown
 *      objects, so a failure has to travel as data.
 */
import { asKeygateError, KeygateError } from '../shared/errors.ts';
import { KEYGATE_CHANNELS } from '../shared/types.ts';
import type { IpcResult } from '../shared/types.ts';
import {
	validateActivateArgs,
	validateDeactivateArgs,
	validateGetEntitlementsArgs,
	validateNoArgs,
	validateVerifyArgs,
} from '../shared/validate.ts';
import type { LicensingService } from './service.ts';

/** The part of Electron's `ipcMain` this package uses. */
export interface IpcMainLike {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** The part of Electron's `ipcMain` event this package inspects. */
export interface IpcEventLike {
	sender?: {
		id: number;
		mainFrame?: unknown;
	};
	senderFrame?: unknown;
}

/**
 * Build the trust check.
 *
 * The ids are re-read **per request**, so closing a window removes its
 * access without the app having to unregister anything.
 */
export function makeWindowTrustChecker(
	ids: () => number[],
): (event: unknown) => boolean {
	return (event: unknown): boolean => {
		if (typeof event !== 'object' || event === null) {
			return false;
		}
		const ipcEvent = event as IpcEventLike;
		const sender = ipcEvent.sender;
		if (!sender || typeof sender.id !== 'number') {
			return false;
		}
		if (!ids().includes(sender.id)) {
			return false;
		}
		// Main frame only. A frame from an embedded document is not the
		// window, whatever the window itself is trusted for.
		if (ipcEvent.senderFrame === undefined || ipcEvent.senderFrame === null) {
			return false;
		}
		return ipcEvent.senderFrame === sender.mainFrame;
	};
}

/** Wrap a handler so it never throws across the boundary. */
function toEnvelope<T>(run: () => Promise<T> | T): Promise<IpcResult<T>> {
	return Promise.resolve()
		.then(() => run())
		.then((data) => ({ ok: true as const, data }))
		.catch((err: unknown) => {
			const error = asKeygateError(err);
			return { ok: false as const, error: { code: error.code, detail: error.detail } };
		});
}

/**
 * Register the eight channels.
 *
 * `getService` is read per request: the service is built after the app
 * is ready, and it may be absent (licensing off) or replaced.
 */
export function registerKeygateIpc(
	ipc: IpcMainLike,
	getService: () => LicensingService | null,
	isTrustedSender: (event: unknown) => boolean,
): void {
	/** Every handler starts here. */
	const guard = (
		event: unknown,
		handler: (service: LicensingService) => Promise<unknown> | unknown,
	): Promise<IpcResult<unknown>> => {
		if (!isTrustedSender(event)) {
			return toEnvelope(() => {
				throw new KeygateError({
					code: 'UNTRUSTED_SENDER',
					detail: 'this window is not trusted for licensing operations',
				});
			});
		}
		const service = getService();
		if (!service) {
			return toEnvelope(() => {
				throw new KeygateError({
					code: 'LICENSING_DISABLED',
					detail: 'licensing is not configured in this build',
				});
			});
		}
		return toEnvelope(() => handler(service));
	};

	ipc.handle(KEYGATE_CHANNELS.getLicense, (event) =>
		guard(event, (service) => service.getLicense()),
	);

	ipc.handle(KEYGATE_CHANNELS.getLicenseKey, (event) =>
		guard(event, (service) => service.getLicenseKey()),
	);

	ipc.handle(KEYGATE_CHANNELS.activate, (event, ...args) =>
		guard(event, (service) => {
			const parsed = validateActivateArgs(args);
			if (!parsed.ok) {
				throw new KeygateError({ code: 'ERR', detail: parsed.detail });
			}
			return service.activate(parsed.value);
		}),
	);

	ipc.handle(KEYGATE_CHANNELS.verify, (event, ...args) =>
		guard(event, (service) => {
			const parsed = validateVerifyArgs(args);
			if (!parsed.ok) {
				throw new KeygateError({ code: 'ERR', detail: parsed.detail });
			}
			return service.verify(parsed.value);
		}),
	);

	ipc.handle(KEYGATE_CHANNELS.deactivate, (event, ...args) =>
		guard(event, (service) => {
			const parsed = validateDeactivateArgs(args);
			if (!parsed.ok) {
				throw new KeygateError({ code: 'ERR', detail: parsed.detail });
			}
			return service.deactivate(parsed.value);
		}),
	);

	ipc.handle(KEYGATE_CHANNELS.getEntitlements, (event, ...args) =>
		guard(event, (service) => {
			const parsed = validateGetEntitlementsArgs(args);
			if (!parsed.ok) {
				throw new KeygateError({ code: 'ERR', detail: parsed.detail });
			}
			return service.getEntitlements(parsed.value);
		}),
	);

	ipc.handle(KEYGATE_CHANNELS.resetLicense, (event, ...args) =>
		guard(event, (service) => {
			const parsed = validateNoArgs(args);
			if (!parsed.ok) {
				throw new KeygateError({ code: 'ERR', detail: parsed.detail });
			}
			return service.resetLicense();
		}),
	);

	ipc.handle(KEYGATE_CHANNELS.resetLicenseKey, (event, ...args) =>
		guard(event, (service) => {
			const parsed = validateNoArgs(args);
			if (!parsed.ok) {
				throw new KeygateError({ code: 'ERR', detail: parsed.detail });
			}
			return service.resetLicenseKey();
		}),
	);
}
