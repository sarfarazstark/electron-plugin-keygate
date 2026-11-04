#!/usr/bin/env node
/**
 * Activates a licence on **this machine** and leaves it activated.
 *
 * The other live checks activate a device and then release it, so the
 * server is left as it was found. That is the right behaviour for a
 * test, and the wrong behaviour when you want to see an activation in
 * the portal — this is the script for that.
 *
 *   KEYGATE_LIVE_URL=http://localhost:9000 \
 *   KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
 *   node scripts/activate-live.mjs
 *
 * It uses the same device identifier the package derives on a real
 * install — the hashed machine id — so the activation looks like a real
 * one in the portal, and the token is bound to it exactly as it would
 * be in production.
 *
 * The licence key is read from the environment and never written to
 * disk.
 */
import { KeygateClient } from '../lib/main/client.ts';
import { resolveConfig } from '../lib/main/config.ts';
import { buildMachineIdentity } from '../lib/main/machine.ts';
import { verifyToken } from '../lib/main/token.ts';

const url = process.env.KEYGATE_LIVE_URL?.trim();
const key = process.env.KEYGATE_LIVE_KEY?.trim();

if (!url || !key) {
	console.error('set KEYGATE_LIVE_URL and KEYGATE_LIVE_KEY first');
	process.exit(1);
}

const config = resolveConfig({ apiUrl: url });
const client = new KeygateClient({ config });
const identity = await buildMachineIdentity();

// `--release <identifier>` releases a slot instead of taking one.
const releaseIndex = process.argv.indexOf('--release');
if (releaseIndex !== -1) {
	const target = process.argv[releaseIndex + 1];
	if (!target) {
		console.error('--release needs the device identifier');
		process.exit(1);
	}
	let released = true;
	try {
		await client.deactivate({ key, identifier: target });
		console.log(`released the slot for ${target}`);
	} catch (err) {
		// The server answers 404 for a licence that does not have this
		// activation, so a slot that was already released arrives here
		// as a failure. It is not one.
		released = false;
		const detail = err && err.detail ? err.detail : String(err);
		console.log(`could not release ${target}: ${detail}`);
	}

	const gone = await client.verify({ key, identifier: target }).then(
		() => false,
		() => true,
	);
	console.log(gone ? 'the server no longer knows that activation' : 'the activation is still there');
	// The exit code is set rather than `process.exit()` called: the
	// latter tears the process down while a socket handle is still
	// closing, which trips a libuv assertion on Windows.
	process.exitCode = gone ? 0 : 1;
} else {
	await activate();
}

/** Activate this machine and report what the server said. */
async function activate() {
	if (!identity.identifier) {
		console.error('this machine has no usable device identifier');
		process.exitCode = 1;
		return;
	}

	console.log(`machine identifier: ${identity.identifier}`);
	console.log(`device name:        ${identity.deviceName}`);
	console.log(`machine id source:  ${identity.source}\n`);

	const published = await client.fetchPublicKey();
	const activation = await client.activate({
		key,
		identifier: identity.identifier,
		label: identity.deviceName,
	});

	console.log(`server status:  ${activation.status}`);
	console.log(`licence id:     ${activation.license_id}\n`);

	// The token the server just signed, verified with the key the server
	// publishes. This is the agreement the whole offline path rests on.
	const payload = verifyToken(activation.token, published.public_key);
	console.log(`the token verifies against the server's published key ${published.public_key}`);
	console.log(`  did  device binding  ${payload.did} / ${payload.fpr}`);
	console.log(`  pid  product          ${payload.pid}`);
	console.log(`  pln  plan             ${payload.pln}`);
	console.log(`  sts  status           ${payload.sts}`);
	console.log(`  exp  check-in by      ${payload.exp ? new Date(payload.exp * 1000).toISOString() : 'none'}`);
	console.log(`  vun  licence term     ${payload.vun ? new Date(payload.vun * 1000).toISOString() : 'perpetual'}`);
	console.log(`  grc  grace days       ${payload.grc ?? 0}\n`);

	const verification = await client.verify({ key, identifier: identity.identifier });
	console.log(`verify: ${verification.status}, plan ${verification.plan_name ?? verification.plan_id}\n`);

	console.log('LEFT ACTIVE. To release the slot:');
	console.log(`  node scripts/activate-live.mjs --release ${identity.identifier}`);
}
