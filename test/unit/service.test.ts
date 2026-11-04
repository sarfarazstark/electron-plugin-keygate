import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeygateClient } from '../../lib/main/client.ts';
import { resolveConfig } from '../../lib/main/config.ts';
import { LicensingService } from '../../lib/main/service.ts';
import { buildSafeStorageCodec, KeygateStorage } from '../../lib/main/storage.ts';
import type { SafeStorageLike } from '../../lib/main/storage.ts';
import { createSilentLogger } from '../../lib/main/logger.ts';
import { KeygateError } from '../../lib/shared/errors.ts';
import { createFakeSafeStorage } from '../support/fake-storage.ts';
import { createMockServer } from '../support/mock-server.ts';
import type { MockServer } from '../support/mock-server.ts';

const IDENTIFIER = 'kg-testdevice';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'keygate-test-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/** Build a service wired to the mock server. */
function buildService(
	server: MockServer,
	safeStorage: SafeStorageLike = createFakeSafeStorage(),
): {
	service: LicensingService;
	storage: KeygateStorage;
} {
	const config = resolveConfig({ apiUrl: 'https://keygate.test' });
	const storage = new KeygateStorage({
		directory,
		codec: buildSafeStorageCodec(safeStorage),
	});
	const client = new KeygateClient({ config, fetchImpl: server.fetch });
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
	});
	return { service, storage };
}

describe('activation and verification', () => {
	it('activates a license and returns the verified state', async () => {
		const server = createMockServer();
		const { service } = buildService(server);

		const license = await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		expect(license.valid).toBe(true);
		expect(license.status).toBe('active');
		expect(license.identifier).toBe(IDENTIFIER);
		expect(license.offline).toBe(false);
		expect(license.entitlements).toContain('premium_support');
		expect(license.features.api_calls).toBe('50000');
		expect(license.productId).toBe('product-under-test');
		expect(license.planId).toBe('plan-under-test');
	});

	it('sends the identifier and the device label to the server', async () => {
		const server = createMockServer();
		const { service } = buildService(server);

		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		const request = server.requests.find((r) => r.path === '/license/activate');
		expect(request?.body).toMatchObject({
			license_key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY',
			identifier: IDENTIFIER,
			identifier_type: 'device',
			label: 'Test Device',
		});
	});

	it('verifies an activated license', async () => {
		const server = createMockServer();
		const { service } = buildService(server);
		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		const license = await service.verify({});

		expect(license.valid).toBe(true);
		expect(license.planName).toBe('Test Plan');
		expect(license.offline).toBe(false);
	});

	it('verifies using the cached key when none is given', async () => {
		const server = createMockServer();
		const { service } = buildService(server);
		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		await service.verify({});

		const request = server.requests.filter((r) => r.path === '/license/verify');
		expect(request).toHaveLength(1);
		expect(request[0]?.body).toMatchObject({
			license_key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY',
		});
	});

	it('passes the server’s error code through', async () => {
		const server = createMockServer();
		const { service } = buildService(server);

		await expect(
			service.verify({ key: 'KG-WRONGKEY-WRONGKEY-WRONGKEY-WRONG' }),
		).rejects.toThrowError(/LICENSE_NOT_FOUND|license not found/);
	});

	it('refuses to verify when there is no key at all', async () => {
		const server = createMockServer();
		const { service } = buildService(server);

		await expect(service.verify({})).rejects.toThrowError(KeygateError);
	});

	it('deactivates the device and clears the cached token', async () => {
		const server = createMockServer();
		const { service, storage } = buildService(server);
		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		await service.deactivate({});

		expect(service.getLicense()).toBeNull();
		expect(await storage.readToken()).toBeNull();
		const request = server.requests.find((r) => r.path === '/license/deactivate');
		expect(request?.body).toMatchObject({ identifier: IDENTIFIER });
	});

	it('reads entitlements from the server', async () => {
		const server = createMockServer();
		const { service } = buildService(server);
		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		const entitlements = await service.getEntitlements({});

		expect(entitlements.licensed).toBe(true);
		expect(entitlements.planName).toBe('Test Plan');
		expect(entitlements.features.premium_support?.enabled).toBe(true);
		expect(entitlements.features.api_calls?.value).toBe('50000');
	});

	it('refuses a token issued for another device', async () => {
		const server = createMockServer();
		const { service } = buildService(server);

		// The server answers with a token bound to a different device —
		// as a compromised or misconfigured server might.
		server.set({ tokenIdentifier: 'kg-someone-else' });

		await expect(
			service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' }),
		).rejects.toMatchObject({ code: 'BAD_TOKEN' });

		// Nothing was persisted: a refused token must not leave a
		// licence behind.
		expect(service.getLicense()).toBeNull();
	});
});

describe('storage policy', () => {
	it('never writes the license key in the clear', async () => {
		const key = 'KG-SECRETKEY-SECRETKEY-SECRETKEY-KEY';
		const server = createMockServer({ licenseKey: key });
		const { service } = buildService(server);

		await service.activate({ key });

		const onDisk = await readFile(join(directory, 'key'));
		expect(onDisk.toString('utf8')).not.toContain(key);
		expect(onDisk.toString('utf8')).not.toContain('SECRETKEY');
	});

	it('refuses to work when the vault is unavailable', async () => {
		const server = createMockServer();
		const { service } = buildService(server, createFakeSafeStorage(false));

		await expect(
			service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' }),
		).rejects.toThrowError(/encryption vault/);
		// The request never left the process.
		expect(server.requests).toHaveLength(0);
	});

	it('refuses to work with the basic_text Linux backend', async () => {
		const server = createMockServer();
		const { service } = buildService(server, {
			isEncryptionAvailable: () => true,
			encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
			decryptString: (buffer: Buffer) => buffer.toString('utf8'),
			getSelectedStorageBackend: () => 'basic_text',
		});

		expect(service.persistsLicenses).toBe(false);
		await expect(
			service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' }),
		).rejects.toThrowError(/encryption vault/);
	});

	it('resets the license but keeps the cached key', async () => {
		const server = createMockServer();
		const { service, storage } = buildService(server);
		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		await service.resetLicense();

		expect(service.getLicense()).toBeNull();
		expect(await storage.readToken()).toBeNull();
		expect(await storage.readLicenseKey()).toBe('KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY');
	});

	it('resets the cached key too', async () => {
		const server = createMockServer();
		const { service, storage } = buildService(server);
		await service.activate({ key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY' });

		await service.resetLicenseKey();

		expect(await storage.readLicenseKey()).toBeNull();
	});
});
