/**
 * The demo's main process.
 *
 * It is the whole integration, in one file: register the licensing
 * channels, load the sandboxed preload, and trust the window that owns
 * the UI.
 *
 * The server is the one from `KEYGATE_API_URL`, defaulting to a local
 * Keygate server. Nothing here is specific to the demo — it is the wiring
 * the README describes.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { registerKeygate, keygateSandboxedPreloadPath, configFromEnv } from 'electron-plugin-keygate';

// `configFromEnv()` reads KEYGATE_API_URL, KEYGATE_PUBLIC_KEY and
// KEYGATE_IDENTIFIER. It returns null when the API URL is unset — that is
// the switch that turns licensing off — so the demo falls back to a local
// server instead, and says which one it is in the header.
const config = configFromEnv() ?? { apiUrl: 'http://localhost:9000' };
const windows = new Set();

app.whenReady().then(async () => {
	const window = new BrowserWindow({
		width: 520,
		height: 840,
		minWidth: 420,
		minHeight: 520,
		title: 'Keygate demo',
		webPreferences: {
			// The sandboxed bridge: one self-contained CommonJS file that a
			// sandboxed renderer is allowed to load.
			preload: keygateSandboxedPreloadPath(),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	windows.add(window);
	window.on('closed', () => windows.delete(window));

	await registerKeygate({
		app,
		ipc: ipcMain,
		// Re-read per request, so a closed window loses access by itself.
		getTrustedWebContentsIds: () => [...windows].map((w) => w.webContents.id),
		config,
	});

	// The server the demo is talking to is passed to the page, so the UI
	// can say which one it is rather than leaving you guessing.
	await window.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'), {
		query: { server: config.apiUrl },
	});
});
