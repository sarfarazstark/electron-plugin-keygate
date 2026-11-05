/**
 * Builds the demo.
 *
 * Two bundles, the way a real app would do it:
 *
 *   - the main process, with `electron` left external
 *   - the renderer, which imports `electron-plugin-keygate/renderer`
 *
 * The package itself is **not** bundled into the renderer bundle from
 * source: it is resolved from `node_modules`, so the demo exercises the
 * same import an application would write.
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

// The demo consumes the package the way an app does: through its
// `exports` map, from the built output. Nothing is built from source here.
if (!existsSync(join(root, 'dist', 'main', 'index.js'))) {
	console.error('the package is not built yet — run `npm run build` in the repository root first');
	process.exit(1);
}

await mkdir(join(here, 'out', 'main'), { recursive: true });
await mkdir(join(here, 'out', 'renderer'), { recursive: true });

await build({
	entryPoints: [join(here, 'main.js')],
	outfile: join(here, 'out', 'main', 'main.js'),
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	external: ['electron'],
});

await build({
	entryPoints: [join(here, 'renderer.js')],
	outfile: join(here, 'out', 'renderer', 'renderer.js'),
	bundle: true,
	platform: 'browser',
	target: 'chrome120',
	format: 'iife',
});

await copyFile(join(here, 'index.html'), join(here, 'out', 'renderer', 'index.html'));

console.log('demo built');
