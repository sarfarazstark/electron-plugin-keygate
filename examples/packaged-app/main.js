/**
 * The packaged example's main process.
 *
 * It mirrors what a real app does: register the licensing channels in
 * the main process and load the sandboxed preload into a sandboxed
 * window.
 *
 * The preload path comes from the package's own exports map, so this
 * file also tests that the map resolves to something Electron can read
 * from inside the asar.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerKeygate, keygateSandboxedPreloadPath } from 'electron-plugin-keygate';

const resultPath = process.env.KEYGATE_RESULT_PATH ?? join(app.getPath('temp'), 'keygate-packaged.json');
const windows = new Set();

app.whenReady().then(async () => {
	const preloadPath = keygateSandboxedPreloadPath();

	await registerKeygate({
		app,
		ipc: ipcMain,
		getTrustedWebContentsIds: () => [...windows].map((window) => window.webContents.id),
		config: { apiUrl: process.env.KEYGATE_API_URL ?? 'https://keygate.invalid' },
	});

	const window = new BrowserWindow({
		show: false,
		width: 800,
		height: 600,
		webPreferences: {
			preload: preloadPath,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	windows.add(window);

	window.webContents.on('did-finish-load', async () => {
		let result = null;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			result = await window.webContents.executeJavaScript('window.__KEYGATE_RESULT__ ?? null');
			if (result) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		writeFileSync(
			resultPath,
			JSON.stringify({ preloadPath, isPackaged: app.isPackaged, result }, null, 2),
			'utf8',
		);
		app.exit(result ? 0 : 2);
	});

	await window.loadFile(join(import.meta.dirname, '..', 'index.html'));
});
