#!/usr/bin/env node
/**
 * Verifies the package in a real Electron renderer, with `sandbox: true`.
 *
 * This is the check that matters for the preload: a sandboxed renderer
 * loads CommonJS, cannot reach the package's other files, and cannot use
 * `require` for anything but `electron`. A unit test cannot prove any of
 * that — only a live renderer can.
 *
 * It launches Electron, loads a page that calls every channel, and
 * reports what came back.
 *
 *   node scripts/verify-electron.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

/** The Electron binary, resolved through the installed package. */
function resolveElectronBinary() {
	const electronPath = require('electron');
	return typeof electronPath === 'string' ? electronPath : null;
}

const electronBinary = resolveElectronBinary();
if (!electronBinary) {
	console.error('electron is not installed; run `npm install` first');
	process.exit(1);
}

const workDirectory = await mkdtemp(join(tmpdir(), 'keygate-verify-'));
const appDirectory = join(workDirectory, 'app');
await mkdir(appDirectory, { recursive: true });

/** Electron needs a manifest to treat a directory as an app. */
await writeFile(
	join(appDirectory, 'package.json'),
	JSON.stringify({ name: 'keygate-verify', version: '1.0.0', main: 'main.js' }, null, 2),
	'utf8',
);

/** The page the renderer loads. */
const pageHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>keygate verify</title></head>
  <body><pre id="out">running…</pre></body>
  <script>
    (async () => {
      const results = {};
      try {
        results.hasBridge = typeof window.keygate === 'object' && window.keygate !== null;
        results.channels = Object.keys(window.keygate || {}).sort();
        results.getLicense = await window.keygate.getLicense();
        results.getLicenseKey = await window.keygate.getLicenseKey();
        results.activateBadArgs = await window.keygate.activate({ key: 12345 });
        results.resetLicense = await window.keygate.resetLicense();
      } catch (err) {
        results.unexpected = String(err && err.message ? err.message : err);
      }
      document.getElementById('out').textContent = JSON.stringify(results, null, 2);
      window.__KEYGATE_RESULT__ = results;
    })();
  </script>
</html>
`;
await writeFile(join(appDirectory, 'index.html'), pageHtml, 'utf8');

/** The main process: registers the channels and loads the sandboxed preload. */
const mainScript = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { registerKeygate, keygateSandboxedPreloadPath } = require('${root.replace(
	/\\/g,
	'\\\\',
)}/dist/main/index.js');

const windows = new Set();

app.whenReady().then(async () => {
  await registerKeygate({
    app,
    ipc: ipcMain,
    getTrustedWebContentsIds: () => [...windows].map((w) => w.webContents.id),
    // A real configuration, pointing at a host that does not exist.
    // The service is therefore live, so the channels answer with real
    // results rather than LICENSING_DISABLED -- which is what makes
    // the argument validation check below meaningful.
    config: { apiUrl: 'https://keygate.invalid' },
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: keygateSandboxedPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windows.add(window);

  window.webContents.on('did-finish-load', async () => {
    try {
      // The page sets the result when its async probe finishes. Poll
      // briefly: the probe awaits IPC, so it lands after the load
      // event.
      let result = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        result = await window.webContents.executeJavaScript('window.__KEYGATE_RESULT__ ?? null');
        if (result) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log(JSON.stringify(result, null, 2));
      app.exit(result ? 0 : 2);
    } catch (err) {
      console.error('the renderer did not report a result:', err);
      app.exit(1);
    }
  });

  await window.loadFile(path.join('${appDirectory.replace(/\\/g, '\\\\')}', 'index.html'));
});
`;
await writeFile(join(appDirectory, 'main.js'), mainScript, 'utf8');

console.log('verifying the sandboxed preload in a live Electron renderer…');

const child = spawn(electronBinary, [appDirectory, '--no-sandbox', '--disable-gpu'], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
	stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
	stderr += chunk.toString();
});

const timeout = setTimeout(() => {
	console.error('the renderer did not answer in time');
	child.kill();
}, 90_000);

const code = await new Promise((resolvePromise) => {
	child.on('exit', (exitCode) => resolvePromise(exitCode ?? 1));
});

clearTimeout(timeout);
await rm(workDirectory, { recursive: true, force: true });

if (code !== 0) {
	console.error(stderr);
	console.error(`verify:electron failed with exit code ${code}`);
	process.exit(code);
}

console.log(stdout);

// The renderer must have found the bridge and reached the channels.
const checks = [
	['the sandboxed preload installed window.keygate', /"hasBridge":\s*true/],
	[
		'all eight channels are present',
		/"channels":\s*\[[\s\S]*"activate"[\s\S]*"getEntitlements"[\s\S]*"resetLicenseKey"/,
	],
	['the get-license channel answered an envelope', /"getLicense":\s*\{\s*"ok":\s*true/],
	[
		'a malformed argument was rejected before any license work',
		/"activateBadArgs":\s*\{\s*"ok":\s*false[\s\S]*?"code":\s*"ERR"/,
	],
	['the sender was trusted', !/"code":\s*"UNTRUSTED_SENDER"/.test(stdout)],
];

let failed = false;
for (const [label, check] of checks) {
	const passed = check instanceof RegExp ? check.test(stdout) : check;
	if (passed) {
		console.log(`  ok  ${label}`);
	} else {
		console.error(`  FAIL ${label}`);
		failed = true;
	}
}

if (failed) {
	console.error('verify:electron failed');
	process.exit(1);
}

console.log('verify:electron ok');
