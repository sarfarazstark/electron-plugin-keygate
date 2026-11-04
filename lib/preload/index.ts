/**
 * The preload for `sandbox: false`.
 *
 * ESM, because it sits alongside the app's own ESM preload. It installs
 * `window.keygate`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createKeygateBridge } from './api.ts';

const bridge = createKeygateBridge((channel, ...args) =>
	ipcRenderer.invoke(channel, ...args),
);

if (process.contextIsolated) {
	try {
		contextBridge.exposeInMainWorld('keygate', bridge);
	} catch (error) {
		console.error('electron-plugin-keygate: failed to expose the keygate bridge', error);
	}
} else {
	(window as unknown as { keygate: typeof bridge }).keygate = bridge;
}
