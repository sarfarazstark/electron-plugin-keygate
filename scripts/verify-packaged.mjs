#!/usr/bin/env node
/**
 * Packages a real Electron app that consumes the package, and runs it.
 *
 * The unit tests and `verify:electron` both run against the source
 * tree. This one tests the thing an app actually ships: the package
 * installed from a **tarball**, inside an **asar**, with the preload
 * loaded from there.
 *
 * The preload path comes from the package's own `exports` map, so this
 * checks that the map resolves to something Electron can read from
 * inside the archive — the packaging question that actually bites.
 *
 *   node scripts/verify-packaged.mjs
 *
 * It needs a writable place to work, so it builds in a temporary
 * directory rather than in the repository.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Run a command and fail loudly if it does. */
function run(command, args, cwd, label) {
	console.log(`  ${label}…`);
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		env: {
			...process.env,
			ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? `${process.env.LOCALAPPDATA}\\electron\\Cache`,
		},
	});
	if (result.status !== 0) {
		throw new Error(`${label} failed with exit code ${result.status}`);
	}
}

const workDirectory = await mkdtemp(join(tmpdir(), 'keygate-packaged-'));
const appDirectory = join(workDirectory, 'app');

try {
	await mkdir(appDirectory, { recursive: true });

	// 1. Pack the package. This is what a consumer installs.
	console.log('packing the plugin…');
	const pack = spawnSync('npm', ['pack', '--pack-destination', workDirectory], {
		cwd: root,
		stdio: 'pipe',
		shell: process.platform === 'win32',
	});
	if (pack.status !== 0) {
		throw new Error(`npm pack failed: ${pack.stderr?.toString()}`);
	}
	const tarball = join(workDirectory, pack.stdout.toString().trim().split('\n').pop().trim());
	console.log(`  ${tarball}`);

	// 2. The example app, with the tarball as its dependency.
	await cp(join(root, 'examples', 'packaged-app'), appDirectory, {
		recursive: true,
		filter: (source) => !source.includes('node_modules') && !source.includes(join('out')),
	});
	await writeFile(
		join(appDirectory, 'package.json'),
		JSON.stringify(
			{
				name: 'keygate-packaged-example',
				version: '1.0.0',
				private: true,
				main: './out/main/main.js',
				scripts: { build: 'node build.mjs' },
				dependencies: { 'electron-plugin-keygate': `file:${tarball}` },
				devDependencies: {
					electron: '^40.0.0',
					'electron-builder': '^26.0.0',
					esbuild: '^0.25.0',
				},
				// npm refuses to run install scripts unless they are
				// approved. These three download a binary or a platform
				// package; they are the normal Electron toolchain.
				allowScripts: {
					electron: true,
					esbuild: true,
					'electron-winstaller': true,
				},
			},
			null,
			2,
		),
		'utf8',
	);

	// 3. Install and build.
	run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], appDirectory, 'installing');
	run('node', ['build.mjs'], appDirectory, 'building the app');

	// The dependency must be the packed tarball's contents, not the
	// source tree: the `files` field decides what ships.
	const installed = join(appDirectory, 'node_modules', 'electron-plugin-keygate');
	if (!existsSync(join(installed, 'dist', 'preload', 'sandboxed.cjs'))) {
		throw new Error('the installed package has no sandboxed preload');
	}
	if (existsSync(join(installed, 'lib'))) {
		throw new Error('the installed package carries the source tree; the files field is wrong');
	}
	console.log('  the installed package holds only the built output');

	// 4. Package it.
	run(
		process.platform === 'win32' ? 'npx.cmd' : 'npx',
		['electron-builder', '--dir', '--win'],
		appDirectory,
		'packaging',
	);

	// 5. Run the packaged app.
	const packagedDirectory = join(appDirectory, 'dist', 'win-unpacked');
	const executable = join(packagedDirectory, 'Keygate Packaged Example.exe');
	const resultPath = join(workDirectory, 'result.json');

	if (!existsSync(executable)) {
		throw new Error(`the packaged executable is missing at ${executable}`);
	}
	console.log('  running the packaged app…');
	const child = spawn(executable, ['--no-sandbox'], {
		env: { ...process.env, KEYGATE_RESULT_PATH: resultPath },
		stdio: 'ignore',
	});
	const exitCode = await new Promise((resolvePromise) => {
		child.on('exit', (code) => resolvePromise(code ?? 1));
		setTimeout(() => {
			child.kill();
			resolvePromise(124);
		}, 120_000);
	});

	if (exitCode !== 0 || !existsSync(resultPath)) {
		throw new Error(`the packaged app did not report a result (exit code ${exitCode})`);
	}

	const report = JSON.parse(await readFile(resultPath, 'utf8'));
	console.log('\n  preload path:', report.preloadPath);
	console.log('  isPackaged:', report.isPackaged);
	console.log('  result:', JSON.stringify(report.result, null, 2).split('\n').join('\n  '));

	const checks = [
		['the app reports itself as packaged', report.isPackaged === true],
		[
			'the preload resolves inside the package',
			typeof report.preloadPath === 'string' &&
				report.preloadPath.includes('electron-plugin-keygate') &&
				report.preloadPath.includes('sandboxed.cjs'),
		],
		['the sandboxed preload installed the bridge', report.result?.hasBridge === true],
		[
			'all eight channels are present',
			Array.isArray(report.result?.channels) && report.result.channels.length === 8,
		],
		['the get-license channel answered', report.result?.getLicense?.ok === true],
	];

	let failed = false;
	console.log('');
	for (const [label, ok] of checks) {
		if (ok) {
			console.log(`  ok    ${label}`);
		} else {
			console.error(`  FAIL  ${label}`);
			failed = true;
		}
	}

	if (failed) {
		console.error('\nverify:packaged failed');
		process.exitCode = 1;
	} else {
		console.log('\nverify:packaged ok');
	}
} finally {
	await rm(workDirectory, { recursive: true, force: true });
}
