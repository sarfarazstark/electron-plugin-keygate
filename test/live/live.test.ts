/**
 * A live Keygate integration test.
 *
 * This talks to a **real** Keygate server, so it is skipped unless the
 * environment says otherwise:
 *
 *   KEYGATE_LIVE_URL       the server's base URL
 *   KEYGATE_LIVE_KEY       a license key that has an activation slot free
 *   KEYGATE_LIVE_PUBLIC_KEY optional — the server's Ed25519 public key, hex
 *
 * With those set, the test activates a device, verifies it, checks the
 * entitlements, deactivates it, and confirms the token the server issued
 * verifies against the server's own public key.
 *
 * Run it with `npm run test:live`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeygateClient } from '../../lib/main/client.ts';
import { resolveConfig } from '../../lib/main/config.ts';
import { verifyToken } from '../../lib/main/token.ts';

const url = process.env.KEYGATE_LIVE_URL?.trim();
const key = process.env.KEYGATE_LIVE_KEY?.trim();
const pinnedPublicKey = process.env.KEYGATE_LIVE_PUBLIC_KEY?.trim();

const enabled = Boolean(url && key);
const suite = enabled ? describe : describe.skip;

suite('against a live Keygate server', () => {
	let client: KeygateClient;
	let serverPublicKey: string;
	let identifier: string;

	beforeAll(async () => {
		const config = resolveConfig({ apiUrl: url! });
		client = new KeygateClient({ config });

		const publicKey = await client.fetchPublicKey();
		serverPublicKey = pinnedPublicKey ?? publicKey.public_key;

		// A distinct identifier per run, so a repeated test does not
		// collide with the activation it left behind.
		identifier = `kg-live-${Date.now().toString(36)}-${Math.random()
			.toString(36)
			.slice(2, 10)}`;
	});

	afterAll(async () => {
		// Leave the server as it was found: the activation is released.
		try {
			await client.deactivate({ key: key!, identifier });
		} catch {
			// The test may already have deactivated it.
		}
	});

	it('serves a public key the client can use', () => {
		expect(serverPublicKey).toMatch(/^[0-9a-fA-F]{64}$/);
	});

	it('activates a device and returns a verifiable token', async () => {
		const data = await client.activate({ key: key!, identifier, label: 'Live Test' });

		expect(data.status).toBe('activated');
		expect(data.token).toBeTruthy();

		// The token the server signed verifies against the key the
		// server published — the whole offline story rests on this.
		const payload = verifyToken(data.token, serverPublicKey);
		expect(payload.did).toBe(identifier);
		expect(payload.lid).toBeTruthy();
		expect(payload.exp).toBeGreaterThan(payload.iat);
	});

	it('verifies the activation', async () => {
		const data = await client.verify({ key: key!, identifier });

		expect(data.status).toBeTruthy();
		expect(data.token).toBeTruthy();

		const payload = verifyToken(data.token, serverPublicKey);
		expect(payload.did).toBe(identifier);
	});

	it('is idempotent — activating again takes no second slot', async () => {
		const first = await client.activate({ key: key!, identifier });
		const second = await client.activate({ key: key!, identifier });

		expect(second.status).toBe('already_activated');
		expect(second.license_id).toBe(first.license_id);
	});

	it('reports the license’s entitlements', async () => {
		const entitlements = await client.entitlements({ key: key! });

		expect(entitlements.licensed).toBe(true);
		expect(typeof entitlements.features).toBe('object');
	});

	it('releases the device', async () => {
		await client.deactivate({ key: key!, identifier });

		// After the release, the device is no longer activated, and the
		// server answers the same way it does for an unknown key.
		await expect(client.verify({ key: key!, identifier })).rejects.toThrowError(
			/LICENSE_NOT_FOUND|license not found/,
		);
	});
});
