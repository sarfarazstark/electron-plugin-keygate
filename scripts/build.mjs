#!/usr/bin/env node
/**
 * Builds the five published entry points.
 *
 * The package ships no runtime dependencies, so every bundle is
 * self-contained except for `electron` itself, which is a peer dependency
 * and must stay external (the app supplies it).
 *
 *   dist/main/index.js         ESM  — main process
 *   dist/renderer/index.js     ESM  — renderer process
 *   dist/preload/index.mjs     ESM  — preload for sandbox: false
 *   dist/preload/sandboxed.cjs CJS  — preload for sandbox: true
 *   dist/preload/api.js        ESM  — createKeygateBridge(invoke), no electron import
 *
 * Type declarations come from `tsc -p tsconfig.build.json`, which mirrors
 * this directory layout under `dist/`.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await rm(resolve(root, 'dist'), { recursive: true, force: true });

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	sourcemap: true,
	target: 'node20',
	platform: 'node',
	logLevel: 'info',
};

await build({
	...shared,
	entryPoints: { index: 'lib/main/index.ts' },
	outdir: 'dist/main',
	format: 'esm',
	external: ['electron'],
});

await build({
	...shared,
	entryPoints: { index: 'lib/renderer/index.ts' },
	outdir: 'dist/renderer',
	format: 'esm',
});

await build({
	...shared,
	entryPoints: { index: 'lib/preload/index.ts' },
	outdir: 'dist/preload',
	format: 'esm',
	outExtension: { '.js': '.mjs' },
	external: ['electron'],
});

await build({
	...shared,
	entryPoints: { sandboxed: 'lib/preload/sandboxed.ts' },
	outdir: 'dist/preload',
	format: 'cjs',
	outExtension: { '.js': '.cjs' },
	external: ['electron'],
});

await build({
	...shared,
	entryPoints: { api: 'lib/preload/api.ts' },
	outdir: 'dist/preload',
	format: 'esm',
});

const tsc = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
const result = spawnSync(resolve(root, 'node_modules', '.bin', tsc), ['-p', 'tsconfig.build.json'], {
	cwd: root,
	stdio: 'inherit',
	shell: process.platform === 'win32',
});
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

console.log('build: ok');
