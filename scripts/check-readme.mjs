#!/usr/bin/env node
/**
 * Checks the documentation's links.
 *
 * Two things go wrong with Markdown links, and both are invisible in a
 * rendered page:
 *
 *  1. A **table-of-contents link** that points at a heading that does not
 *     exist. GitHub renders the page perfectly and the link is dead.
 *  2. A **relative link** to a file that was renamed or moved.
 *
 * And one thing goes wrong with heading anchors, which is the reason this
 * script exists at all: GitHub derives a heading's anchor by dropping
 * everything that is not a letter, a number, a mark or a hyphen, then
 * turning spaces into hyphens. The trap is the **variation selector**:
 * emoji that carry U+FE0F keep it, because it is a combining mark, and it
 * stays in the anchor — invisible, but part of the URL. `## ⬇️ Install` is
 * `#%EF%B8%8F-install`, not `#-install`.
 *
 * So the anchors are computed here rather than written by hand.
 *
 *   node scripts/check-readme.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/**
 * GitHub's anchor for a heading.
 *
 * Letters, numbers, combining marks and connectors survive; everything
 * else — punctuation, and the base code point of an emoji — does not.
 * Spaces become hyphens, and nothing is trimmed, so a heading that starts
 * with an emoji keeps a leading hyphen.
 */
function anchorFor(text) {
	return text
		.replace(/`/g, '')
		.replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
		.toLowerCase()
		.replace(/ /g, '-');
}

/** The headings in a document, skipping anything inside a fenced code block. */
function headingsOf(markdown) {
	const headings = [];
	let inFence = false;
	for (const line of markdown.split('\n')) {
		if (line.startsWith('```')) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const match = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!match) continue;
		headings.push({ text: match[2].trim(), anchor: anchorFor(match[2].trim()) });
	}
	return headings;
}

/** Every markdown file that is part of the documentation. */
const files = [join(root, 'README.md')];
const docsDirectory = join(root, 'docs');
if (existsSync(docsDirectory)) {
	for (const name of readdirSync(docsDirectory).sort()) {
		if (name.endsWith('.md')) files.push(join(docsDirectory, name));
	}
}

let failed = false;

for (const file of files) {
	const markdown = readFileSync(file, 'utf8');
	const name = relative(root, file).replace(/\\/g, '/');
	const anchors = new Set(headingsOf(markdown).map((h) => h.anchor));

	const links = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
	const broken = [];
	const missingFiles = [];

	for (const link of links) {
		if (/^https?:\/\//.test(link)) continue;

		const [target, anchor] = link.split('#');
		if (target === '') {
			// An in-page link.
			if (anchor && !anchors.has(decodeURIComponent(anchor))) {
				broken.push(link);
			}
			continue;
		}

		// A relative link to another document.
		const resolved = resolve(dirname(file), decodeURIComponent(target));
		if (!existsSync(resolved)) {
			missingFiles.push(link);
			continue;
		}
		if (anchor && resolved.endsWith('.md')) {
			const targetAnchors = new Set(headingsOf(readFileSync(resolved, 'utf8')).map((h) => h.anchor));
			if (!targetAnchors.has(decodeURIComponent(anchor))) {
				broken.push(link);
			}
		}
	}

	// A relative image path does not render on the npm package page.
	const images = [
		...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g),
		...markdown.matchAll(/<img[^>]*\ssrc="([^"]+)"/g),
	].map((m) => m[1]);
	const relativeImages = images.filter((src) => !/^https?:\/\//.test(src));

	console.log(`${name}: ${anchors.size} headings, ${links.length} links`);
	for (const link of broken) console.error(`  BROKEN ANCHOR  ${link}`);
	for (const link of missingFiles) console.error(`  MISSING FILE   ${link}`);
	for (const src of relativeImages) console.error(`  RELATIVE IMAGE ${src}`);
	if (broken.length || missingFiles.length || relativeImages.length) failed = true;
}

if (failed) {
	console.error('the documentation is not consistent');
	process.exit(1);
}
console.log('docs: ok');
