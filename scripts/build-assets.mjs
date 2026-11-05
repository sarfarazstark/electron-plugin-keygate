#!/usr/bin/env node
/**
 * Renders the README images.
 *
 * The banner is drawn as HTML and screenshotted with Electron, so the type is
 * exact and the colours come from Keygate's own logo. The architecture
 * diagram is **Mermaid**: `assets/architecture.mmd` is the source, and this
 * script renders it to `assets/architecture.png` — the npm package page does
 * not render Mermaid, so the README needs the PNG.
 *
 *   npm run assets
 *
 * Both outputs are committed. The Keygate logo and the portal screenshot are
 * copied from the Keygate repository by hand, not by this script.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const assets = join(root, 'assets');
const require = createRequire(import.meta.url);

const electronBinary = require('electron');
if (typeof electronBinary !== 'string') {
	console.error('electron is not installed; run `npm install` first');
	process.exit(1);
}

const logoUrl = pathToFileURL(join(assets, 'keygate-logo.svg')).href;
const mermaidUrl = pathToFileURL(join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')).href;

const bannerHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		width: 1200px; height: 360px; overflow: hidden; position: relative;
		display: flex; align-items: center;
		font-family: 'Segoe UI', 'Inter', -apple-system, system-ui, sans-serif;
		color: #fff;
		background:
			radial-gradient(880px 420px at 82% 6%, rgba(167, 139, 250, .50), transparent 62%),
			radial-gradient(760px 400px at 6% 98%, rgba(109, 40, 217, .75), transparent 64%),
			linear-gradient(135deg, #1b1035 0%, #2b1550 46%, #100920 100%);
	}
	.grid {
		position: absolute; inset: 0;
		background-image:
			linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px),
			linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px);
		background-size: 48px 48px;
		mask-image: radial-gradient(760px 340px at 30% 50%, #000 20%, transparent 78%);
	}
	.atom {
		position: absolute; right: -60px; top: -70px; width: 470px; height: 470px;
		opacity: .30;
	}
	.atom span {
		position: absolute; inset: 0; border: 2px solid rgba(167,139,250,.55);
		border-radius: 50%;
	}
	.atom span:nth-child(1) { transform: rotate(28deg) scaleY(.42); }
	.atom span:nth-child(2) { transform: rotate(-28deg) scaleY(.42); }
	.atom span:nth-child(3) { transform: rotate(90deg) scaleY(.42); }
	.atom i {
		position: absolute; left: 50%; top: 50%; width: 54px; height: 54px;
		margin: -27px 0 0 -27px; border-radius: 50%;
		background: radial-gradient(circle at 32% 28%, #c4b5fd, #7c3aed 68%);
		box-shadow: 0 0 60px rgba(167,139,250,.75);
	}
	.wrap { position: relative; padding: 0 64px; display: flex; align-items: center; gap: 30px; }
	.shield { width: 104px; height: 104px; flex: none; filter: drop-shadow(0 12px 26px rgba(109,40,217,.55)); }
	.eyebrow {
		font-size: 13px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase;
		color: #a78bfa; margin-bottom: 14px;
	}
	h1 { font-size: 50px; font-weight: 700; letter-spacing: -.022em; line-height: 1.04; }
	h1 em { font-style: normal; color: #a78bfa; }
	.sub { margin-top: 14px; font-size: 19px; color: #d7cef0; font-weight: 400; }
	.chips { display: flex; gap: 9px; margin-top: 24px; }
	.chip {
		font-size: 12.5px; font-weight: 600; letter-spacing: .01em;
		padding: 7px 13px; border-radius: 999px;
		color: #e9e2ff; background: rgba(167,139,250,.14);
		border: 1px solid rgba(167,139,250,.34);
	}
	.rule {
		position: absolute; left: 0; right: 0; bottom: 0; height: 4px;
		background: linear-gradient(90deg, #8b5cf6, #6d28d9 42%, rgba(109,40,217,0));
	}
</style>
</head>
<body>
	<div class="grid"></div>
	<div class="atom"><span></span><span></span><span></span><i></i></div>
	<div class="wrap">
		<img class="shield" src="${logoUrl}" alt="" />
		<div>
			<div class="eyebrow">Keygate licensing for Electron</div>
			<h1>electron-plugin-<em>keygate</em></h1>
			<div class="sub">Activation, device-bound signed tokens and entitlements — kept in the main process, never in the page.</div>
			<div class="chips">
				<span class="chip">offline activation</span>
				<span class="chip">safeStorage cache</span>
				<span class="chip">sandboxed preload</span>
				<span class="chip">zero dependencies</span>
			</div>
		</div>
	</div>
	<div class="rule"></div>
</body>
</html>
`;

const workDirectory = await mkdtemp(join(tmpdir(), 'keygate-assets-'));

/** Run a page in Electron and screenshot it at a fixed size. */
async function screenshot(html, width, height, output, afterLoad) {
	const htmlPath = join(workDirectory, 'page.html');
	await writeFile(htmlPath, html, 'utf8');

	const script = `
		const { app, BrowserWindow } = require('electron');
		const fs = require('node:fs');
		app.whenReady().then(async () => {
			const win = new BrowserWindow({
				width: ${width},
				height: ${height},
				show: false,
				frame: false,
				backgroundColor: '#ffffff',
				webPreferences: { backgroundThrottling: false },
			});
			win.webContents.on('console-message', (...args) => {
				const message = args[0] && args[0].details ? args[0].details.message : args[2];
				console.log('[page]', message);
			});
			await win.loadFile(${JSON.stringify(htmlPath)});
			const outcome = await (async () => { ${afterLoad} })();
			if (outcome && outcome.error) {
				console.error(outcome.error);
				app.exit(1);
				return;
			}
			await new Promise((r) => setTimeout(r, 500));
			const image = await win.webContents.capturePage();
			fs.writeFileSync(${JSON.stringify(output)}, image.toPNG());
			app.exit(0);
		});
	`;
	const scriptPath = join(workDirectory, 'capture.js');
	await writeFile(scriptPath, script, 'utf8');

	await new Promise((done, fail) => {
		const child = require('node:child_process').spawn(electronBinary, [scriptPath], {
			stdio: ['ignore', 'inherit', 'inherit'],
		});
		child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`electron exited with ${code}`))));
		child.on('error', fail);
	});
}

console.log('rendering the banner…');
await screenshot(bannerHtml, 1200, 360, join(assets, 'banner.png'), 'return null;');

console.log('rendering the architecture diagram…');
// The diagram lives in the documentation, as a Mermaid block GitHub renders
// live. That block is the source; this renders it to a PNG for the npm
// package page, which does not render Mermaid.
const architectureDoc = await readFile(join(root, 'docs', 'architecture.md'), 'utf8');
const diagramBlock = architectureDoc.match(/```mermaid\n([\s\S]*?)```/);
if (!diagramBlock) {
	console.error('docs/architecture.md has no mermaid block to render');
	process.exit(1);
}
const diagram = diagramBlock[1];

const mermaidHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
	html, body { margin: 0; padding: 0; background: #ffffff; overflow: hidden; }
	#stage { display: inline-block; padding: 28px; }
	#stage svg { display: block; }
</style>
<script src="${mermaidUrl}"></script>
</head>
<body>
<div id="stage"></div>
<script>
	const source = ${JSON.stringify(diagram)};
	// Mermaid 12's initialize() is synchronous and returns nothing; render()
	// is the promise.
	mermaid.initialize({
		startOnLoad: false,
		theme: 'base',
		themeVariables: {
			fontFamily: "'Segoe UI', 'Inter', -apple-system, system-ui, sans-serif",
			fontSize: '15px',
			lineColor: '#6b6285',
			primaryTextColor: '#2f2745',
		},
		flowchart: {
			htmlLabels: true,
			useMaxWidth: false,
			curve: 'basis',
			nodeSpacing: 52,
			rankSpacing: 56,
			padding: 16,
			// The default is 200px, which wraps every label onto four lines.
			wrappingWidth: 440,
		},
	});
	window.__rendered = mermaid
		.render('keygate-architecture', source)
		.then((result) => {
			document.getElementById('stage').innerHTML = result.svg;
			const rect = document.querySelector('#stage svg').getBoundingClientRect();
			window.__size = { width: Math.ceil(rect.width) + 56, height: Math.ceil(rect.height) + 56 };
			return true;
		})
		.catch((err) => {
			window.__error = err && (err.stack || err.message) ? (err.stack || err.message) : JSON.stringify(err);
			return false;
		});
</script>
</body>
</html>
`;

await screenshot(
	mermaidHtml,
	1200,
	800,
	join(assets, 'architecture.png'),
	`
	const rendered = await win.webContents.executeJavaScript('window.__rendered');
	if (!rendered) {
		const message = await win.webContents.executeJavaScript('window.__error');
		return { error: 'mermaid failed: ' + message };
	}
	const size = await win.webContents.executeJavaScript('window.__size');
	win.setContentSize(size.width, size.height);
	return null;
	`,
);

await rm(workDirectory, { recursive: true, force: true });
console.log('assets: ok');
