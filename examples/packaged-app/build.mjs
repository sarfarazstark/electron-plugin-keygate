/**
 * A minimal Electron app that consumes `electron-plugin-keygate`.
 *
 * It exists to test the **packaged** layout: the preload has to load
 * from inside the asar, and the package's `exports` map has to resolve
 * to a path Electron can read.
 *
 * The window is hidden and the result is written to a file, because a
 * packaged app has no console to print to.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDirectory = join(here, 'out');

await mkdir(join(outDirectory, 'main'), { recursive: true });

await build({
	entryPoints: { main: join(here, 'main.js') },
	outfile: join(outDirectory, 'main', 'main.js'),
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	external: ['electron'],
});

await writeFile(
	join(outDirectory, 'index.html'),
	`<!doctype html>
<html><head><meta charset="utf-8" /><title>keygate packaged check</title></head>
<body><pre id="out">running…</pre>
<script>
(async () => {
  const results = {};
  try {
    results.hasBridge = typeof window.keygate === 'object' && window.keygate !== null;
    results.channels = Object.keys(window.keygate || {}).sort();
    results.getLicense = await window.keygate.getLicense();
  } catch (err) {
    results.unexpected = String(err && err.message ? err.message : err);
  }
  document.getElementById('out').textContent = JSON.stringify(results, null, 2);
  window.__KEYGATE_RESULT__ = results;
})();
</script>
</body></html>
`,
	'utf8',
);

console.log('packaged-example built');
