import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A dynamic import of an absolute path, as a file URL on Windows. */
const importBuilt = (relativePath) => import(pathToFileURL(resolve(root, relativePath)).href);

const main = await importBuilt('dist/main/index.js');
console.log('main exports:', Object.keys(main).sort().join(', '));

const renderer = await importBuilt('dist/renderer/index.js');
console.log('renderer exports:', Object.keys(renderer).sort().join(', '));

const preloadApi = await importBuilt('dist/preload/api.js');
console.log('preload/api exports:', Object.keys(preloadApi).sort().join(', '));

// The preload path helpers must resolve to files that exist.
const paths = {
	sandboxed: main.keygateSandboxedPreloadPath(),
	unsandboxed: main.keygatePreloadPath(),
};
const { existsSync } = await import('node:fs');
for (const [name, path] of Object.entries(paths)) {
	console.log(`${name} preload: ${path} -> ${existsSync(path) ? 'exists' : 'MISSING'}`);
}

// The manifest's exports map must agree with what was built.
const manifest = require(resolve(root, 'package.json'));
for (const [subpath, entry] of Object.entries(manifest.exports)) {
	const target = typeof entry === 'string' ? entry : entry.import;
	console.log(`exports["${subpath}"] -> ${target} -> ${existsSync(resolve(root, target)) ? 'exists' : 'MISSING'}`);
}
