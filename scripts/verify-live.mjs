#!/usr/bin/env node
/**
 * Verifies the package against a real Keygate server.
 *
 * Unlike the automated suite, this reports what the server actually
 * said at each step, which is what you want when a licensing problem is
 * the question.
 *
 *   KEYGATE_LIVE_URL=http://localhost:9000 \
 *   KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
 *   node scripts/verify-live.mjs
 *
 * It activates a device, verifies it, checks the entitlements, releases
 * the slot, and confirms the token the server issued verifies against
 * the server's own published public key.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.KEYGATE_LIVE_URL?.trim();
const key = process.env.KEYGATE_LIVE_KEY?.trim();

if (!url || !key) {
	console.error('set KEYGATE_LIVE_URL and KEYGATE_LIVE_KEY first');
	process.exit(1);
}

// The package is TypeScript; run it through the same toolchain the
// tests use rather than requiring a build first.
const { KeygateClient } = await import('../lib/main/client.ts');
const { resolveConfig } = await import('../lib/main/config.ts');
const { verifyToken, expectedFingerprint } = await import('../lib/main/token.ts');

const config = resolveConfig({ apiUrl: url });
const client = new KeygateClient({ config });

const identifier = `kg-verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const directory = await mkdtemp(join(tmpdir(), 'keygate-live-'));

console.log(`server:   ${url}`);
console.log(`device:   ${identifier}\n`);

let failed = false;
const check = (label, ok, detail = '') => {
	if (ok) {
		console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
	} else {
		console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
		failed = true;
	}
};

try {
	// 1. The public key the server publishes.
	const published = await client.fetchPublicKey();
	check(
		'the server publishes an Ed25519 public key',
		/^[0-9a-fA-F]{64}$/.test(published.public_key),
		published.public_key.slice(0, 16) + '…',
	);

	// 2. Activation.
	const activation = await client.activate({ key, identifier, label: 'verify-live' });
	check('the device activates', true, `status ${activation.status}`);

	// 3. The token verifies against the published key. This is the
	//    agreement between the two implementations that the whole
	//    offline path rests on.
	let payload = null;
	try {
		payload = verifyToken(activation.token, published.public_key);
		check('the signed token verifies against the published key', true, `licence ${payload.lid}`);
	} catch (err) {
		check('the signed token verifies against the published key', false, String(err));
	}

	// 4. The device binding.
	if (payload) {
		check(
			'the device binding matches the server’s definition',
			payload.fpr === expectedFingerprint(payload.did, payload.pid),
			payload.fpr ?? '(none)',
		);
		check('the token is issued for this device', payload.did === identifier, payload.did);
	}

	// 5. Verification.
	const verification = await client.verify({ key, identifier });
	check('the license verifies', true, `status ${verification.status}, plan ${verification.plan_name ?? verification.plan_id}`);
	check(
		'the verified token carries an expiry in the future',
		payload ? payload.exp > Math.floor(Date.now() / 1000) : false,
	);

	// 6. Re-activation is idempotent.
	const again = await client.activate({ key, identifier });
	check(
		'activating again takes no second slot',
		again.status === 'already_activated',
		`status ${again.status}`,
	);

	// 7. Entitlements.
	const entitlements = await client.entitlements({ key });
	check(
		'the entitlements answer',
		entitlements.licensed === true,
		`${Object.keys(entitlements.features).length} feature(s)`,
	);

	// 8. The slot is released.
	await client.deactivate({ key, identifier });
	let released = false;
	try {
		await client.verify({ key, identifier });
	} catch (err) {
		released = String(err).includes('LICENSE_NOT_FOUND') || String(err).includes('license not found');
	}
	check('the device slot is released', released);
} catch (err) {
	console.error(`\nthe run failed: ${err}`);
	failed = true;
} finally {
	await rm(directory, { recursive: true, force: true });
}

if (failed) {
	console.error('\nverify:live failed');
	process.exit(1);
}
console.log('\nverify:live ok');
