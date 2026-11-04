import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeygateClient } from '../../lib/main/client.ts';
import { resolveConfig } from '../../lib/main/config.ts';
import { LicensingService } from '../../lib/main/service.ts';
import { buildSafeStorageCodec, KeygateStorage } from '../../lib/main/storage.ts';
import { createSilentLogger } from '../../lib/main/logger.ts';
import { createFakeSafeStorage } from '../support/fake-storage.ts';
import { createMockServer } from '../support/mock-server.ts';
import type { MockServer } from '../support/mock-server.ts';

const IDENTIFIER = 'kg-testdevice';
const LICENSE_KEY = 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'keygate-offline-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/**
 * Build a service over a shared directory.
 *
 * The directory is what makes the offline case work: a second service
 * over the same directory is a second launch of the app.
 */
function buildService(
	server: MockServer | null,
	options: { now?: () => number } = {},
): { service: LicensingService; storage: KeygateStorage } {
	const config = resolveConfig({ apiUrl: 'https://keygate.test' });
	const storage = new KeygateStorage({
		directory,
		codec: buildSafeStorageCodec(createFakeSafeStorage()),
	});
	const client = new KeygateClient({
		config,
		fetchImpl: server?.fetch ?? failingFetch(),
	});
	const service = new LicensingService({
		config,
		client,
		storage,
		log: createSilentLogger(),
		identity: async () => ({
			identifier: IDENTIFIER,
			raw: 'raw-machine-id',
			deviceName: 'Test Device',
			source: 'test',
		}),
		...(options.now ? { now: options.now } : {}),
	});
	return { service, storage };
}

/** A fetch that always fails — the machine is offline. */
function failingFetch(): never {
	return (() => Promise.reject(new Error('the network is unreachable'))) as never;
}

describe('offline restoration', () => {
	it('restores the license on the next launch without the network', async () => {
		const server = createMockServer();
		const first = buildService(server);
		await first.service.activate({ key: LICENSE_KEY });
		expect(first.service.getLicense()?.valid).toBe(true);

		// A second launch: the network is gone.
		const second = buildService(null);
		await second.service.init();

		const license = second.service.getLicense();
		expect(license).not.toBeNull();
		expect(license?.valid).toBe(true);
		expect(license?.offline).toBe(true);
		expect(license?.licenseId).toBe('license-under-test');
		expect(license?.identifier).toBe(IDENTIFIER);
	});

	it('records why startup left the app licensed', async () => {
		const server = createMockServer();
		const first = buildService(server);
		await first.service.activate({ key: LICENSE_KEY });

		const second = buildService(null);
		await second.service.init();

		expect(second.service.startupDiagnostic.reason).toBe('restored');
	});

	it('starts unlicensed when there is nothing cached', async () => {
		const { service } = buildService(null);
		await service.init();

		expect(service.getLicense()).toBeNull();
		expect(service.startupDiagnostic.reason).toBe('no-cache');
	});

	it('refuses a token whose signature does not verify', async () => {
		const server = createMockServer();
		const first = buildService(server);
		await first.service.activate({ key: LICENSE_KEY });

		// Corrupt the cached token, keeping the file readable.
		const { storage } = first;
		const cached = await storage.readToken();
		expect(cached).not.toBeNull();
		await storage.writeToken({
			token: `${cached!.token.split('.')[0]}.${'A'.repeat(86)}`,
			payload: cached!.payload,
			license: cached!.license,
			storedAt: Date.now(),
		});

		const second = buildService(null);
		await second.service.init();

		expect(second.service.getLicense()).toBeNull();
		expect(second.service.startupDiagnostic.reason).toBe('bad-token');
	});

	it('refuses a token that has expired', async () => {
		const server = createMockServer({ tokenTtlSeconds: 60 });
		let clock = Math.floor(Date.now() / 1000);
		const first = buildService(server, { now: () => clock });
		await first.service.activate({ key: LICENSE_KEY });

		// Two days later: the check-in interval has passed.
		clock += 2 * 86_400;
		const second = buildService(null, { now: () => clock });
		await second.service.init();

		expect(second.service.getLicense()).toBeNull();
		expect(second.service.startupDiagnostic.reason).toBe('expired');
	});

	it('keeps a license that is inside its grace period', async () => {
		const now = Math.floor(Date.now() / 1000);
		const server = createMockServer({
			validUntil: now + 60,
			graceDays: 7,
			tokenTtlSeconds: 30 * 86_400,
		});
		const first = buildService(server);
		await first.service.activate({ key: LICENSE_KEY });

		// Three days past the license term: inside the grace window.
		const second = buildService(null, { now: () => now + 60 + 3 * 86_400 });
		await second.service.init();

		expect(second.service.getLicense()?.valid).toBe(true);
		expect(second.service.getLicense()?.graceDays).toBe(7);
	});

	it('drops a license that is past its grace period', async () => {
		const now = Math.floor(Date.now() / 1000);
		const server = createMockServer({
			validUntil: now + 60,
			graceDays: 1,
			tokenTtlSeconds: 30 * 86_400,
		});
		const first = buildService(server);
		await first.service.activate({ key: LICENSE_KEY });

		// Five days past the license term: the grace day is used up.
		const second = buildService(null, { now: () => now + 60 + 5 * 86_400 });
		await second.service.init();

		expect(second.service.getLicense()).toBeNull();
		expect(second.service.startupDiagnostic.reason).toBe('expired');
	});

	it('serves entitlements from the cached token when the network is gone', async () => {
		const server = createMockServer();
		const first = buildService(server);
		await first.service.activate({ key: LICENSE_KEY });

		const second = buildService(null);
		await second.service.init();

		const entitlements = await second.service.getEntitlements({});
		expect(entitlements.licensed).toBe(true);
		expect(entitlements.features.premium_support?.enabled).toBe(true);
	});
});

describe('offline restoration and the public key', () => {
	it('fetches the public key when none is pinned', async () => {
		const server = createMockServer();
		const { service } = buildService(server);
		await service.activate({ key: LICENSE_KEY });

		const request = server.requests.find((r) => r.path === '/license/pubkey');
		expect(request).toBeDefined();
		expect(service.getPublicKey()).toBe(server.publicKey);
	});

	it('uses a pinned public key and never asks the server for one', async () => {
		const server = createMockServer();
		const config = resolveConfig({
			apiUrl: 'https://keygate.test',
			publicKey: server.publicKey,
		});
		const storage = new KeygateStorage({
			directory,
			codec: buildSafeStorageCodec(createFakeSafeStorage()),
		});
		const service = new LicensingService({
			config,
			client: new KeygateClient({ config, fetchImpl: server.fetch }),
			storage,
			log: createSilentLogger(),
			identity: async () => ({
				identifier: IDENTIFIER,
				raw: 'raw',
				deviceName: 'Test Device',
				source: 'test',
			}),
		});

		await service.activate({ key: LICENSE_KEY });

		expect(server.requests.find((r) => r.path === '/license/pubkey')).toBeUndefined();
	});
});
