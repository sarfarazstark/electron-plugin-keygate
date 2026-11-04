/**
 * The preload for `sandbox: true`.
 *
 * A sandboxed renderer loads a CommonJS file and cannot reach the
 * package's other modules at runtime. That constraint is met at the
 * **build** level: this file is bundled into a single self-contained
 * CommonJS file, with `electron` as the only external. The source
 * imports the same bridge the unsandboxed preload uses, so the two
 * cannot drift apart.
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
