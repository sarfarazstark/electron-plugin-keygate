#!/usr/bin/env node
/**
 * Renders the README images.
 *
 * The banner and the architecture diagram are drawn as HTML and screenshotted
 * with Electron, so the type is exact and the colours come from Keygate's own
 * logo. Run it after changing either template:
 *
 *   npm run assets
 *
 * The outputs are committed: `assets/banner.png` and `assets/architecture.png`.
 * The Keygate logo and the portal screenshot are copied from the Keygate
 * repository by hand, not by this script.
 */
import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
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

/** The shared page furniture: the violet the Keygate shield is painted in. */
const palette = `
	--violet-400: #a78bfa;
	--violet-500: #8b5cf6;
	--violet-600: #7c3aed;
	--violet-700: #6d28d9;
	--ink-900: #14101f;
	--ink-700: #2f2745;
	--ink-500: #6b6285;
	--ink-300: #a9a2bd;
	--line: #e6e1f2;
	--paper: #ffffff;
`;

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
		color: var(--violet-400); margin-bottom: 14px;
	}
	h1 { font-size: 50px; font-weight: 700; letter-spacing: -.022em; line-height: 1.04; }
	h1 em { font-style: normal; color: var(--violet-400); }
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

const architectureHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	:root { ${palette} }
	body {
		width: 1200px; height: 610px; overflow: hidden;
		font-family: 'Segoe UI', 'Inter', -apple-system, system-ui, sans-serif;
		background: #fbfaff; color: var(--ink-900);
		padding: 34px 40px 30px;
	}
	.head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 22px; }
	.head img { width: 34px; height: 34px; }
	.head h2 { font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
	.head p { font-size: 14px; color: var(--ink-500); }
	.row { display: flex; align-items: stretch; gap: 0; }
	.card {
		background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
		padding: 16px 17px; box-shadow: 0 1px 2px rgba(20,16,31,.04), 0 10px 26px rgba(20,16,31,.05);
		display: flex; flex-direction: column; gap: 11px;
	}
	.card h3 {
		font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
		color: var(--ink-500);
	}
	.card h4 { font-size: 16px; font-weight: 700; letter-spacing: -.01em; margin-bottom: -4px; }
	.card p { font-size: 12.5px; line-height: 1.55; color: var(--ink-500); }
	.tag {
		align-self: flex-start; font-size: 11px; font-weight: 700; letter-spacing: .06em;
		text-transform: uppercase; padding: 4px 9px; border-radius: 6px;
		background: #f1ecfe; color: var(--violet-700);
	}
	.tag.green { background: #e7f6ee; color: #11724a; }
	.tag.amber { background: #fdf1e0; color: #96591a; }
	pre {
		background: #f7f5fd; border: 1px solid var(--line); border-radius: 9px;
		padding: 9px 11px; font-family: 'Cascadia Mono', 'Consolas', monospace;
		font-size: 11.5px; line-height: 1.5; color: var(--ink-700); overflow: hidden;
	}
	pre .k { color: var(--violet-700); font-weight: 600; }
	pre .s { color: #11724a; }
	ul { font-size: 12.5px; line-height: 1.6; color: var(--ink-500); padding-left: 16px; }
	li { margin-bottom: 3px; }
	li b { color: var(--ink-700); font-weight: 600; }
	.arrow { flex: none; width: 74px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; }
	.arrow .line { position: relative; width: 100%; height: 2px; background: var(--line); }
	.arrow .line::after {
		content: ''; position: absolute; right: -1px; top: 50%; width: 8px; height: 8px;
		border-top: 2px solid #cdc4e8; border-right: 2px solid #cdc4e8;
		transform: translateY(-50%) rotate(45deg);
	}
	.arrow .label { font-size: 11px; font-weight: 600; color: var(--ink-500); text-align: center; line-height: 1.35; }
	.arrow.stack { justify-content: space-evenly; gap: 26px; }
	.arrow.stack .unit { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; }
	.renderer { width: 296px; }
	.preload { width: 268px; }
	.main { width: 300px; }
	.right { display: flex; flex-direction: column; gap: 14px; width: 234px; margin-left: 22px; }
	.server { border-color: #d9cffa; background: linear-gradient(180deg, #fbf9ff, #f6f2ff); }
	.vault { border-color: #cfe9dd; background: linear-gradient(180deg, #f8fdfa, #f2faf6); }
	.foot {
		margin-top: 20px; display: flex; gap: 10px; align-items: center;
		font-size: 12.5px; color: var(--ink-500);
	}
	.foot b { color: var(--ink-700); }
	.pill {
		background: #f1ecfe; color: var(--violet-700); font-weight: 600;
		border-radius: 999px; padding: 5px 11px; font-size: 12px;
	}
</style>
</head>
<body>
	<div class="head">
		<img src="${logoUrl}" alt="" />
		<h2>electron-plugin-keygate</h2>
		<p>— where the credential lives, and what the renderer can see</p>
	</div>

	<div class="row">
		<div class="card renderer">
			<span class="tag">renderer</span>
			<h4>Your page</h4>
			<p>Sandboxed, context-isolated, no Node. It never holds the license key.</p>
			<pre><span class="k">await</span> window.keygate
  .activate({ key })</pre>
			<ul>
				<li>Eight channels, nothing else</li>
				<li>No <b>fs</b>, no <b>ipcRenderer</b>, no arbitrary invoke</li>
				<li>An iframe gets no licensing access</li>
			</ul>
		</div>

		<div class="arrow">
			<div class="line"></div>
			<div class="label">call</div>
		</div>

		<div class="card preload">
			<span class="tag">preload</span>
			<h4>The bridge</h4>
			<p>One self-contained CommonJS file, so it loads under <b>sandbox: true</b>. The only external is <b>electron</b>.</p>
			<pre>window.keygate = {
  activate, verify,
  deactivate,
  getEntitlements,
  getLicense,
  getLicenseKey,
  resetLicense,
  resetLicenseKey
}</pre>
			<ul>
				<li>Resolves the bridge <b>per call</b></li>
				<li>Answers an envelope, never throws across</li>
			</ul>
		</div>

		<div class="arrow">
			<div class="line"></div>
			<div class="label">IPC<br />keygate:*</div>
		</div>

		<div class="card main">
			<span class="tag green">main process</span>
			<h4>Your app</h4>
			<p>Every handler checks the sender, validates its arguments, then does the work in Node.</p>
			<pre><span class="k">await</span> registerKeygate({
  app, ipc: ipcMain,
  getTrustedWebContentsIds
})</pre>
			<ul>
				<li><b>KeygateClient</b> — HTTPS to the server</li>
				<li><b>KeygateStorage</b> — safeStorage</li>
				<li><b>LicensingService</b> — the rules</li>
			</ul>
		</div>

		<div class="arrow stack">
			<div class="unit">
				<div class="line"></div>
				<div class="label">HTTPS</div>
			</div>
			<div class="unit">
				<div class="line"></div>
				<div class="label">safeStorage</div>
			</div>
		</div>

		<div class="right">
			<div class="card server">
				<span class="tag">Keygate server</span>
				<h4>keygate.app</h4>
				<ul>
					<li><b>/license/activate</b></li>
					<li><b>/license/verify</b></li>
					<li><b>/license/deactivate</b></li>
					<li><b>/license/entitlements</b></li>
					<li><b>/license/pubkey</b></li>
				</ul>
			</div>
			<div class="card vault">
				<span class="tag green">OS vault</span>
				<h4>safeStorage</h4>
				<p>DPAPI, Keychain, libsecret or kwallet. No plaintext fallback, ever.</p>
			</div>
		</div>
	</div>

	<div class="foot">
		<span class="pill">No plaintext</span>
		<span>the key and the token live in the main process, encrypted by the OS —</span>
		<b>the renderer only ever sees the license.</b>
	</div>
</body>
</html>
`;

const workDirectory = await mkdtemp(join(tmpdir(), 'keygate-assets-'));

async function render(html, width, height, output) {
	const htmlPath = join(workDirectory, 'page.html');
	await writeFile(htmlPath, html, 'utf8');

	const script = `
		const { app, BrowserWindow } = require('electron');
		app.whenReady().then(async () => {
			const win = new BrowserWindow({
				width: ${width},
				height: ${height},
				show: false,
				frame: false,
				backgroundColor: '#ffffff',
				webPreferences: { offscreen: false, backgroundThrottling: false },
			});
			await win.loadFile(${JSON.stringify(htmlPath)});
			// Let the fonts settle and the first paint land.
			await new Promise((r) => setTimeout(r, 700));
			const image = await win.webContents.capturePage();
			require('node:fs').writeFileSync(${JSON.stringify(output)}, image.toPNG());
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
await render(bannerHtml, 1200, 360, join(assets, 'banner.png'));
console.log('rendering the architecture diagram…');
await render(architectureHtml, 1200, 610, join(assets, 'architecture.png'));

await rm(workDirectory, { recursive: true, force: true });
console.log('assets: ok');
