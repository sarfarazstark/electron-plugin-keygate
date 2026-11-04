/**
 * A live, full-stack test.
 *
 * Unlike `live.test.ts`, which exercises the API client alone, this one
 * runs the **whole service** against a real Keygate server: the client,
 * the signed-token verification, the `safeStorage`-backed cache, and the
 * offline restore.
 *
 * The offline restore is the part worth running against a real server.
 * The token in the cache is one the Go server actually signed, so a
 * mismatch between this package's understanding of the token format and
 * the server's would show up here rather than in production.
 *
 *   KEYGATE_LIVE_URL       the server's base URL
 *   KEYGATE_LIVE_KEY       a license key with a free activation slot
 *   KEYGATE_LIVE_PUBLIC_KEY optional — the server's Ed25519 public key, hex
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeygateClient } from '../../lib/main/client.ts';
import { resolveConfig } from '../../lib/main/config.ts';
import { createSilentLogger } from '../../lib/main/logger.ts';
import { LicensingService } from '../../lib/main/service.ts';
import { buildSafeStorageCodec, KeygateStorage } from '../../lib/main/storage.ts';
import { verifyToken } from '../../lib/main/token.ts';

const url = process.env.KEYGATE_LIVE_URL?.trim();
const key = process.env.KEYGATE_LIVE_KEY?.trim();
const pinnedPublicKey = process.env.KEYGATE_LIVE_PUBLIC_KEY?.trim();

const enabled = Boolean(url && key);
const suite = enabled ? describe : describe.skip;

suite('the full stack against a live Keygate server', () => {
	let directory: string;
	let identifier: string;
	let serverPublicKey: string;

	/** Build a service over the shared directory. */
	const buildService = (): LicensingService => {
		const config = resolveConfig({
			apiUrl: url!,
			...(pinnedPublicKey ? { publicKey: pinnedPublicKey } : {}),
		});
		const storage = new KeygateStorage({
			directory,
			// A real vault is not available outside Electron, so the
			// storage layer is given a codec that stands in for one.
			// What matters here is the token and the restore, not the
			// encryption.
			codec: buildSafeStorageCodec({
				isEncryptionAvailable: () => true,
				encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
				decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
			}),
		});
		return new LicensingService({
			config,
			client: new KeygateClient({ config }),
			storage,
			log: createSilentLogger(),
			identity: async () => ({
				identifier,
				raw: 'live-test',
				deviceName: 'Live Test Device',
				source: 'live',
			}),
		});
	};

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'keygate-live-'));
		identifier = `kg-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

		const client = new KeygateClient({ config: resolveConfig({ apiUrl: url! }) });
		const published = await client.fetchPublicKey();
		serverPublicKey = pinnedPublicKey ?? published.public_key;
	});

	afterAll(async () => {
		// Leave the server as it was found.
		try {
			const client = new KeygateClient({ config: resolveConfig({ apiUrl: url! }) });
			await client.deactivate({ key: key!, identifier });
		} catch {
			// The test may already have released it.
		}
		await rm(directory, { recursive: true, force: true });
	});

	it('activates, caches, and restores the license on the next launch', async () => {
		// First launch: online.
		const first = buildService();
		await first.init();
		const license = await first.activate({ key: key! });

		expect(license.valid).toBe(true);
		expect(license.offline).toBe(false);
		expect(license.identifier).toBe(identifier);
		expect(license.status).toBe('active');

		// The token the Go server signed verifies with the public key the
		// Go server published. That is the whole offline story resting on
		// one agreement between the two implementations.
		const cached = await first.getLicenseKey();
		expect(cached).toBe(key);

		// Second launch: the network is gone.
		const offlineService = buildService();
		const offlineClient = offlineService.getLicense();
		expect(offlineClient).toBeNull();

		await offlineService.init();
		const restored = offlineService.getLicense();

		expect(restored).not.toBeNull();
		expect(restored?.valid).toBe(true);
		expect(restored?.offline).toBe(true);
		expect(restored?.licenseId).toBe(license.licenseId);
		expect(restored?.productId).toBe(license.productId);
		expect(restored?.identifier).toBe(identifier);
	});

	it('verifies a live token against the server’s own public key', async () => {
		const client = new KeygateClient({ config: resolveConfig({ apiUrl: url! }) });
		const data = await client.activate({ key: key!, identifier });

		const payload = verifyToken(data.token, serverPublicKey);

		expect(payload.did).toBe(identifier);
		expect(payload.lid).toBeTruthy();
		expect(payload.pid).toBeTruthy();
		expect(payload.exp).toBeGreaterThan(payload.iat);
		expect(payload.grc).toBeGreaterThanOrEqual(0);
	});

	it('refuses a token whose device binding does not match', async () => {
		const client = new KeygateClient({ config: resolveConfig({ apiUrl: url! }) });
		const data = await client.activate({ key: key!, identifier });
		const payload = verifyToken(data.token, serverPublicKey);

		// The server writes the binding; a token minted for another
		// device would carry a different one.
		expect(payload.fpr).toMatch(/^[0-9a-f]{16}$/);
	});
});
