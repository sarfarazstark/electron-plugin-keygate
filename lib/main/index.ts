/**
 * The main-process entry point.
 *
 * `registerKeygate` is the one call an app makes. It wires the config,
 * the client, the storage and the IPC channels together, and returns the
 * service so the app can read the startup diagnostic.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeygateError } from '../shared/errors.ts';
import { KeygateClient } from './client.ts';
import type { FetchLike } from './client.ts';
import { configFromEnv, KeygateBuilder, resolveConfig } from './config.ts';
import type { KeygateConfig, KeygateConfigInput } from './config.ts';
import { makeWindowTrustChecker, registerKeygateIpc } from './ipc.ts';
import type { IpcMainLike } from './ipc.ts';
import { createDefaultLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { LicensingService } from './service.ts';
import type { ServiceInitArgs } from './service.ts';
import { buildSafeStorageCodec, KeygateStorage } from './storage.ts';
import type { SafeStorageLike } from './storage.ts';

export { KeygateBuilder, resolveConfig, configFromEnv } from './config.ts';
export type { KeygateConfig, KeygateConfigInput } from './config.ts';
export { KeygateClient } from './client.ts';
export type { FetchLike } from './client.ts';
export { LicensingService } from './service.ts';
export type { ServiceInitArgs, StartupDiagnostic } from './service.ts';
export { KeygateStorage, buildSafeStorageCodec } from './storage.ts';
export type { SecretCodec, SafeStorageLike } from './storage.ts';
export { registerKeygateIpc, makeWindowTrustChecker } from './ipc.ts';
export type { IpcMainLike } from './ipc.ts';
export { createDefaultLogger, createSilentLogger } from './logger.ts';
export type { Logger } from './logger.ts';
export { KeygateError, isKeygateError, asKeygateError } from '../shared/errors.ts';
export { KEYGATE_CHANNELS } from '../shared/types.ts';
export type {
	KeygateChannel,
	KeygateEntitlements,
	KeygateFeatureStatus,
	KeygateLicense,
	IpcResult,
} from '../shared/types.ts';

/** The part of Electron's `app` this package uses. */
export interface KeygateAppHost {
	readonly name: string;
	getPath(name: 'userData'): string;
	getVersion(): string;
	getLocale(): string;
	whenReady(): Promise<void>;
}

/** The options `registerKeygate` takes. */
export interface RegisterKeygateOptions {
	/** Electron's `app`. */
	app: KeygateAppHost;
	/** Electron's `ipcMain`. */
	ipc: IpcMainLike;
	/**
	 * The web contents ids allowed to use the licensing channels.
	 *
	 * Re-read per request, so a closed window loses access without the
	 * app having to unregister anything.
	 */
	getTrustedWebContentsIds: () => number[];
	/**
	 * The licensing config.
	 *
	 * Omitted — read it from `KEYGATE_*` in the environment. `null` —
	 * licensing is off in this build.
	 */
	config?: KeygateConfigInput | null;
	/** Where diagnostics go. Defaults to the console. */
	log?: Logger;
	/** Injection point for tests. */
	createService?: (args: ServiceInitArgs) => Promise<LicensingService | null>;
	/** Injection point for tests: the `fetch` the client uses. */
	fetchImpl?: FetchLike;
	/** Injection point for tests: Electron's `safeStorage`. */
	safeStorage?: SafeStorageLike;
}

/**
 * Register the Keygate licensing channels.
 *
 * The channels are registered **before** the app is ready, so an early
 * request answers `LICENSING_DISABLED` instead of hanging on a handler
 * that does not exist yet. The service is built after the app is ready,
 * when `userData` resolves.
 *
 * A licensing failure never takes the app down: the error is logged and
 * every channel reports it.
 */
export async function registerKeygate(
	options: RegisterKeygateOptions,
): Promise<LicensingService | null> {
	const log = options.log ?? createDefaultLogger();

	let service: LicensingService | null = null;

	// The channels exist from the first moment. Until the service is
	// built they answer LICENSING_DISABLED, which is a truthful answer
	// rather than a hung promise.
	registerKeygateIpc(
		options.ipc,
		() => service,
		makeWindowTrustChecker(options.getTrustedWebContentsIds),
	);

	const input = options.config === undefined ? configFromEnv() : options.config;
	if (!input) {
		log.info('licensing is not configured in this build');
		return null;
	}

	let config: KeygateConfig;
	try {
		config = resolveConfig(input);
	} catch (err) {
		const error = err instanceof KeygateError ? err : null;
		log.error(`the licensing configuration is unusable: ${error?.detail ?? 'unknown error'}`);
		return null;
	}

	try {
		await options.app.whenReady();
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'the app did not become ready';
		log.error(`the app did not become ready, so licensing could not start: ${detail}`);
		return null;
	}

	try {
		const deps: ServiceInitArgs = {
			config,
			client: new KeygateClient({
				config,
				...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
			}),
			storage: new KeygateStorage({
				directory: join(options.app.getPath('userData'), 'keygate'),
				codec: buildSafeStorageCodec(options.safeStorage ?? loadElectronSafeStorage()),
			}),
			log,
		};

		service = options.createService
			? await options.createService(deps)
			: new LicensingService(deps);

		if (service) {
			await service.init();
			log.info(
				`licensing is ready for ${options.app.name} ${options.app.getVersion()} (${options.app.getLocale()})`,
			);
		}
	} catch (err) {
		const error = err instanceof KeygateError ? err : null;
		const detail = error?.detail ?? (err instanceof Error ? err.message : 'unknown error');
		log.error(`the licensing service could not be started: ${detail}`);
		service = null;
	}

	return service;
}

/**
 * Load Electron's `safeStorage`.
 *
 * Imported lazily so this module can be loaded — and tested — outside
 * Electron. In a real app Electron is always there.
 */
function loadElectronSafeStorage(): SafeStorageLike {
	try {
		const require = createRequire(import.meta.url);
		const electron = require('electron') as { safeStorage?: SafeStorageLike };
		if (!electron.safeStorage) {
			throw new Error('electron.safeStorage is not available');
		}
		return electron.safeStorage;
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'electron could not be loaded';
		throw new KeygateError({
			code: 'STORAGE_UNAVAILABLE',
			detail: `the operating system encryption vault is not available: ${detail}`,
		});
	}
}

/**
 * The path to the preload for `sandbox: false`.
 *
 * ESM, because the app's own preload is ESM. A sandboxed renderer
 * cannot load it.
 */
export function keygatePreloadPath(): string {
	return resolvePreload('preload', 'index.mjs');
}

/**
 * The path to the preload for `sandbox: true`.
 *
 * CommonJS and self-contained, because that is what a sandboxed renderer
 * can load: it cannot use ESM, and it cannot reach the package's other
 * files.
 */
export function keygateSandboxedPreloadPath(): string {
	return resolvePreload('preload', 'sandboxed.cjs');
}

/**
 * Resolve a file inside this package.
 *
 * The package directory is found with **Node's own resolution** first:
 * `require.resolve('electron-plugin-keygate/package.json')` walks the
 * `node_modules` chain from the calling file and finds wherever the
 * package actually sits.
 *
 * That matters because the calling file is often not this one. An app
 * that bundles its main script -- with esbuild, with Vite, with
 * webpack -- inlines this package's code, and then `import.meta.url`
 * points at the *app's* bundle rather than at the package. Resolving
 * relative to it produced a path inside the app's own directory, and
 * the preload was not there.
 *
 * The `exports` map of the package that was found decides the file
 * name, so the path is right whether the package was installed, linked
 * or vendored. The layout fallback covers a source checkout with no
 * install step.
 */
function resolvePreload(subpath: string, fileName: string): string {
	const candidates: string[] = [];

	// 1. The installed package, wherever it is.
	try {
		const require = createRequire(import.meta.url);
		const manifestPath = require.resolve('electron-plugin-keygate/package.json');
		const packageRoot = dirname(manifestPath);
		const manifest = require(manifestPath) as {
			exports?: Record<string, { import?: string } | string>;
		};
		const entry = manifest.exports?.[subpath];
		const target = typeof entry === 'string' ? entry : entry?.import;
		if (target) {
			candidates.push(join(packageRoot, target));
		}
		candidates.push(join(packageRoot, 'dist', subpath, fileName));
	} catch {
		// Not installed as a dependency, or the manifest is unreadable.
	}

	// 2. This package's own layout, for a source checkout.
	const here = dirname(fileURLToPath(import.meta.url));
	candidates.push(resolve(here, '..', '..', 'dist', subpath, fileName));

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	// Nothing exists. Return the first candidate so the caller gets a
	// path it can report, rather than a silent failure.
	return candidates[0] ?? resolve(here, '..', '..', 'dist', subpath, fileName);
}
