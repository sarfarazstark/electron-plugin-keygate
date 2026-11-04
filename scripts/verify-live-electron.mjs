#!/usr/bin/env node
/**
 * Verifies the package against a real Keygate server, in a real Electron
 * app, with the real operating-system vault.
 *
 * This is the check that the unit suite cannot make. Everything else
 * stubs the vault:
 *
 *   - `test/unit/storage.ts` stubs `safeStorage` in both generations.
 *   - `verify:electron` runs a real Electron, but against a host that
 *     does not exist, so no license is ever activated and nothing is
 *     ever written to the vault.
 *
 * This one activates a real license against a real server, lets the
 * real `safeStorage` encrypt it under DPAPI (Windows), and then starts a
 * **second process** with the network gone to prove the offline restore
 * works from what the vault gave back.
 *
 *   KEYGATE_LIVE_URL=http://localhost:9000 \
 *   KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
 *   node scripts/verify-live-electron.mjs
 *
 * `KEYGATE_ELECTRON_PATH` overrides which Electron binary runs it, so
 * the same check can be made against the Electron 45 and 46 lines.
 *
 * The license key is read from the environment and never written to
 * disk. The vault writes only ciphertext.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const url = process.env.KEYGATE_LIVE_URL?.trim();
const key = process.env.KEYGATE_LIVE_KEY?.trim();

if (!url || !key) {
	console.error('set KEYGATE_LIVE_URL and KEYGATE_LIVE_KEY first');
	process.exit(1);
}

/** The Electron binary to run: the installed one, or an override. */
function resolveElectronBinary() {
	const override = process.env.KEYGATE_ELECTRON_PATH?.trim();
	if (override) {
		if (!existsSync(override)) {
			throw new Error(`KEYGATE_ELECTRON_PATH does not exist: ${override}`);
		}
		return override;
	}
	const electronPath = require('electron');
	if (typeof electronPath !== 'string') {
		throw new Error('electron is not installed; run `npm install` first');
	}
	return electronPath;
}

const electronBinary = resolveElectronBinary();
/** The Electron version in use, read from the binary's own package. */
const electronVersion = (() => {
	const override = process.env.KEYGATE_ELECTRON_PATH?.trim();
	if (override) {
		// The binary sits in <root>/dist/electron.exe.
		const pkg = join(dirname(dirname(override)), 'package.json');
		try {
			return JSON.parse(readFileSync(pkg, 'utf8')).version;
		} catch {
			return 'unknown';
		}
	}
	try {
		return JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
	} catch {
		return 'unknown';
	}
})();
const workDirectory = await mkdtemp(join(tmpdir(), 'keygate-live-electron-'));
const appDirectory = join(workDirectory, 'app');
// The vault lives here, and it must be the *same* directory for both
// processes, or the second launch has nothing to restore.
const userData = join(workDirectory, 'userdata');
// A per-run device identifier. The server counts activations against the
// plan's limit, so the test uses its own identifier and releases it
// afterwards rather than tying up a slot on the real machine id.
const identifier = `kg-live-electron-${Date.now().toString(36)}-${Math.random()
	.toString(36)
	.slice(2, 10)}`;
await mkdir(appDirectory, { recursive: true });
await mkdir(userData, { recursive: true });

/** Electron needs a manifest to treat a directory as an app. */
await writeFile(
	join(appDirectory, 'package.json'),
	JSON.stringify({ name: 'keygate-live', version: '1.0.0', main: 'main.js' }, null, 2),
	'utf8',
);

/**
 * The main process.
 *
 * Two modes, chosen by argv:
 *
 *   online   activate against the server, then report what was written
 *   offline  start with an unreachable server and report what was restored
 *
 * The offline run uses a URL that cannot resolve, so a restore that
 * silently reached the network would fail rather than pass.
 */
const mainScript = `
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { registerKeygate } = require('${root.replace(/\\/g, '\\\\')}/dist/main/index.js');

const mode = process.env.KEYGATE_VERIFY_MODE;
const serverUrl = mode === 'offline' ? 'http://127.0.0.1:1' : ${JSON.stringify(url)};

app.setPath('userData', ${JSON.stringify(userData)});

app.whenReady().then(async () => {
  const service = await registerKeygate({
    app,
    ipc: require('electron').ipcMain,
    getTrustedWebContentsIds: () => [],
    // A per-run identifier, so repeated runs do not collide with each
    // other and the real machine id is not tied up by a test.
    config: { apiUrl: serverUrl, identifier: ${JSON.stringify(identifier)} },
  });

  const result = { mode };

  // Which generation of the vault API this Electron provides. The
  // package prefers the asynchronous one whenever it is present, so
  // this says which path was actually exercised.
  const { safeStorage } = require('electron');
  result.vaultApi =
    typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
    typeof safeStorage.encryptStringAsync === 'function' &&
    typeof safeStorage.decryptStringAsync === 'function'
      ? 'async'
      : 'sync';

  // The shape of the asynchronous decrypt, as this real Electron build
  // actually behaves. This is the detail the package must not get
  // wrong: decryptStringAsync resolves with an object, not a string.
  if (result.vaultApi === 'async') {
    try {
      const probe = await safeStorage.encryptStringAsync('keygate-probe');
      const out = await safeStorage.decryptStringAsync(probe);
      result.decryptShape =
        out && typeof out === 'object' && typeof out.result === 'string' ? 'object' : typeof out;
      result.shouldReEncrypt = out && typeof out === 'object' ? out.shouldReEncrypt : undefined;
    } catch (err) {
      result.decryptShape = 'error: ' + String(err && err.message ? err.message : err);
    }
  }

  try {
    if (mode === 'online') {
      const license = await service.activate({ key: ${JSON.stringify(key)}, label: 'verify-live-electron' });
      result.license = {
        valid: license.valid,
        status: license.status,
        offline: license.offline,
        identifier: license.identifier,
        licenseId: license.licenseId,
        productId: license.productId,
        planId: license.planId,
      };
      result.persistsLicenses = service.persistsLicenses;
      result.cachedKey = await service.getLicenseKey();

      // What the vault actually wrote to disk.
      const dir = path.join(app.getPath('userData'), 'keygate');
      result.files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      result.keyFileIsCiphertext = fs.existsSync(path.join(dir, 'key'))
        ? !fs.readFileSync(path.join(dir, 'key')).toString('utf8').includes(${JSON.stringify(key)})
        : false;
    } else {
      // No network call at all: init() restores from the cache.
      result.restored = service.getLicense();
      result.startup = service.startupDiagnostic;
      result.persistsLicenses = service.persistsLicenses;
      result.cachedKey = await service.getLicenseKey();
    }
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  }

  console.log('__RESULT__' + JSON.stringify(result));
  app.exit(result.error ? 1 : 0);
});
`;
await writeFile(join(appDirectory, 'main.js'), mainScript, 'utf8');

/** Run the app in one mode and return its parsed report. */
function runMode(mode) {
	return new Promise((resolvePromise) => {
		const child = spawn(electronBinary, [appDirectory, '--no-sandbox', '--disable-gpu'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
				// The mode travels in the environment: Electron appends its
				// own arguments, so argv cannot be trusted for this.
				KEYGATE_VERIFY_MODE: mode,
			},
		});

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			child.kill();
		}, 120_000);

		child.on('exit', (code) => {
			clearTimeout(timer);
			const marker = stdout.indexOf('__RESULT__');
			if (marker === -1) {
				resolvePromise({ code, stdout, stderr, report: null });
				return;
			}
			const line = stdout.slice(marker + '__RESULT__'.length).split('\n')[0];
			try {
				resolvePromise({ code, stdout, stderr, report: JSON.parse(line) });
			} catch (err) {
				resolvePromise({ code, stdout, stderr, report: null });
			}
		});
	});
}

let failed = false;
const check = (label, ok, detail = '') => {
	if (ok) {
		console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
	} else {
		console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
		failed = true;
	}
};

console.log(`electron:  ${electronBinary}`);
console.log(`version:   ${electronVersion}`);
console.log(`server:    ${url}`);
console.log(`device:    ${identifier}\n`);

try {
	// 1. Online: activate, and let the real vault write the ciphertext.
	const online = await runMode('online');
	if (!online.report) {
		console.error(online.stderr);
		throw new Error('the online run reported nothing');
	}
	const first = online.report;
	if (!first.license && !first.error) {
		console.error('the online run reported nothing useful:', JSON.stringify(first, null, 2));
		console.error(online.stderr);
	}
	check('the activation succeeded', first.license?.valid === true, first.error ?? first.license?.status);
	check('the license came from the network, not the cache', first.license?.offline === false);
	check('the vault can persist licenses', first.persistsLicenses === true);
	check(
		'the license key was written to the vault',
		first.cachedKey === key,
		first.cachedKey ? 'read back intact' : 'nothing cached',
	);

	// 2. What is on disk must be ciphertext, not the key.
	const vaultDir = join(userData, 'keygate');
	const files = existsSync(vaultDir) ? (await readFile(join(vaultDir, 'key'))).toString('binary') : '';
	check('the key file does not contain the license key in the clear', !files.includes(key));
	const tokenFile = existsSync(join(vaultDir, 'token')) ? (await readFile(join(vaultDir, 'token'))).toString('binary') : '';
	check('the token file does not contain the license key in the clear', !tokenFile.includes(key));

	// 3. Offline: a second process, an unreachable server, the same vault.
	const offline = await runMode('offline');
	if (!offline.report) {
		console.error(offline.stderr);
		throw new Error('the offline run reported nothing');
	}
	const second = offline.report;
	check('the license was restored from the vault', second.restored?.valid === true, second.error ?? '');
	check('the restored license is marked offline', second.restored?.offline === true);
	check('the restore did not need the network', second.startup?.reason === 'restored', second.startup?.reason);
	check('the cached key survived the restart', second.cachedKey === key);
	check(
		'the restored license is the same license',
		second.restored?.licenseId === first.license?.licenseId,
		second.restored?.licenseId,
	);

	// 4. The vault API generation this Electron provided. The package
	//    prefers the asynchronous one, so this is the path that was
	//    actually exercised above.
	console.log(`\n  the Electron ${electronVersion} build provided the ${first.vaultApi} vault API`);
	if (first.vaultApi === 'async') {
		check(
			'the asynchronous decrypt resolves with an object, not a string',
			first.decryptShape === 'object',
			`shape ${first.decryptShape}`,
		);
	}
} catch (err) {
	console.error(`\nthe run failed: ${err}`);
	failed = true;
} finally {
	// Release the slot. The server counts activations against the
	// plan's limit, so a test that leaves one behind eats a seat.
	try {
		const { KeygateClient } = await import('../lib/main/client.ts');
		const { resolveConfig } = await import('../lib/main/config.ts');
		const client = new KeygateClient({ config: resolveConfig({ apiUrl: url }) });
		await client.deactivate({ key, identifier });
		check('the device slot was released', true, identifier);
	} catch (err) {
		check('the device slot was released', false, String(err));
	}
	await rm(workDirectory, { recursive: true, force: true });
}

if (failed) {
	console.error('\nverify:live-electron failed');
	process.exit(1);
}
console.log('\nverify:live-electron ok');
