#!/usr/bin/env node
/**
 * Checks the README's table of contents against its headings.
 *
 * GitHub derives a heading's anchor by dropping everything that is not a
 * letter, a number, a mark or a hyphen, then turning spaces into hyphens.
 * The trap is the **variation selector**: emoji that carry U+FE0F keep it,
 * because it is a combining mark, and it stays in the anchor — invisible,
 * but part of the URL. `## ⬇️ Install` is `#%EF%B8%8F-install`, not
 * `#-install`.
 *
 * Getting that wrong is easy and invisible: the page still renders, and only
 * the link is dead. So the table is checked here instead of by hand.
 *
 *   node scripts/check-readme.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readmePath = resolve(here, '..', 'README.md');
const readme = readFileSync(readmePath, 'utf8');

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

const lines = readme.split('\n');

/** The headings, skipping anything inside a fenced code block. */
const headings = [];
let inFence = false;
for (const line of lines) {
	if (line.startsWith('```')) {
		inFence = !inFence;
		continue;
	}
	if (inFence) continue;
	const match = /^(#{2,3})\s+(.*)$/.exec(line);
	if (!match) continue;
	headings.push({ level: match[1].length, text: match[2].trim(), anchor: anchorFor(match[2].trim()) });
}

const anchors = new Set(headings.map((h) => h.anchor));

/** The links in the table of contents. */
const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]));

let failed = false;

console.log(`headings: ${headings.length}`);
for (const heading of headings) {
	console.log(`  ${'#'.repeat(heading.level)} ${heading.text}  ->  #${encodeURI(heading.anchor)}`);
}

console.log(`\ntable-of-contents links: ${links.length}`);
const broken = links.filter((href) => !anchors.has(href));
for (const href of broken) {
	console.error(`  BROKEN  #${href}`);
	failed = true;
}
if (broken.length === 0) {
	console.log('  every link resolves');
}

// A relative image path does not render on the npm package page.
const images = [
	...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g),
	...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"/g),
].map((m) => m[1]);
for (const src of images) {
	if (!/^https?:\/\//.test(src)) {
		console.error(`  relative image path: ${src}`);
		failed = true;
	}
}
console.log(`images: ${images.length} (all absolute: ${images.every((s) => /^https?:\/\//.test(s))})`);

if (failed) {
	console.error('the README is not consistent');
	process.exit(1);
}
console.log('readme: ok');
