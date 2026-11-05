/**
 * Builds the demo.
 *
 * Two bundles, the way a real app would do it:
 *
 *   - the renderer, with Vite and Tailwind (React + the shadcn components
 *     copied from the Watermelon registry)
 *   - the main process, with esbuild, and `electron` left external
 *
 * The package itself is **not** bundled from source: it is resolved from
 * `node_modules`, so the demo exercises the same import an application
 * would write.
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

// The demo consumes the package the way an app does: through its
// `exports` map, from the built output. Nothing is built from source here.
if (!existsSync(join(root, 'dist', 'main', 'index.js'))) {
	console.error('the package is not built yet — run `npm run build` in the repository root first');
	process.exit(1);
}

await viteBuild({ configFile: join(here, 'vite.config.ts') });

await build({
	entryPoints: [join(here, 'main.js')],
	outfile: join(here, 'out', 'main', 'main.js'),
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	external: ['electron'],
});

console.log('demo built');
