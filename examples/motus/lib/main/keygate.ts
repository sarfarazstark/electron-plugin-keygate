/**
 * Motus — main-process wiring.
 *
 * Drop this next to `lib/main/` and call `initKeygate()` from
 * `app.whenReady()`.
 *
 * The whole integration is three steps:
 *
 *   1. register the channels, with the window ids as the trust list
 *   2. add the sandboxed preload to the window
 *   3. import `electron-plugin-keygate/renderer` in the renderer
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerKeygate } from 'electron-plugin-keygate';
import type { LicensingService } from 'electron-plugin-keygate';

/** The windows allowed to use the licensing channels. */
const licensedWindows = new Set<BrowserWindow>();

let service: LicensingService | null = null;

/**
 * Register the licensing channels.
 *
 * `getTrustedWebContentsIds` is re-read per request, so a closed window
 * loses access by itself and there is nothing to clean up on 'closed'.
 */
export async function initKeygate(): Promise<LicensingService | null> {
	service = await registerKeygate({
		app,
		ipc: ipcMain,
		getTrustedWebContentsIds: () =>
			[...licensedWindows].map((window) => window.webContents.id),
		// The config comes from KEYGATE_API_URL and friends. When
		// KEYGATE_API_URL is unset, licensing is off and this returns
		// null — a build without Keygate keeps working unchanged.
	});

	if (!service) {
		// Licensing is not configured in this build. Not an error.
		return null;
	}

	const diagnostic = service.startupDiagnostic;
	if (diagnostic.reason === 'restored') {
		// The license was restored from the local cache, without a
		// network call. The app is licensed.
		console.info('[keygate] restored the cached license offline');
	} else if (diagnostic.reason === 'no-cache') {
		// First launch, or the user cleared it. The renderer will ask
		// for a key.
		console.info('[keygate] no cached license; the app starts unlicensed');
	} else {
		// 'bad-token', 'expired', 'storage-unavailable', 'no-public-key'.
		// The reason is a main-process diagnostic on purpose — it is not
		// an IPC channel, so it never reaches the renderer.
		console.warn(`[keygate] starting unlicensed: ${diagnostic.reason}`);
	}

	return service;
}

/** Track a window so it can use the licensing channels. */
export function trackLicensedWindow(window: BrowserWindow): void {
	licensedWindows.add(window);
	window.on('closed', () => {
		licensedWindows.delete(window);
	});
}

/** The licensing service, for the main process's own use. */
export function getLicensingService(): LicensingService | null {
	return service;
}
