/**
 * The storage layer against both `safeStorage` generations.
 *
 * Electron 45 added the async trio and Electron 46 removed the sync
 * pair, so this package has to speak both. The shapes are not merely
 * sync-ified versions of each other: `decryptStringAsync` resolves with
 * `{ result, shouldReEncrypt }`, and reading that as a string would turn
 * every cached license into an unreadable one — a failure that shows up
 * as "the app forgot my license" rather than as an error.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSafeStorageCodec, KeygateStorage } from '../../lib/main/storage.ts';
import type { SecretCodec } from '../../lib/main/storage.ts';
import {
	createAsyncSafeStorage,
	createBasicTextSafeStorage,
	createFakeSafeStorage,
} from '../support/fake-storage.ts';

const KEY = 'KG-STORAGEKEY-STORAGEKEY-STORAGEKEY';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'keygate-storage-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function store(codec: SecretCodec): KeygateStorage {
	return new KeygateStorage({ directory, codec });
}

describe('the sync safeStorage, as in Electron 30–45', () => {
	it('round-trips a license key through the vault', async () => {
		const storage = store(buildSafeStorageCodec(createFakeSafeStorage()));

		await storage.writeLicenseKey(KEY);

		expect(await storage.readLicenseKey()).toBe(KEY);
		// The bytes on disk are ciphertext, not the key.
		expect((await readFile(join(directory, 'key'))).toString('utf8')).not.toContain(KEY);
	});

	it('reports the vault usable', async () => {
		expect(await store(buildSafeStorageCodec(createFakeSafeStorage())).encryptionAvailable()).toBe(true);
	});
});

describe('the async safeStorage, as in Electron 45+', () => {
	it('reads the object shape that decryptStringAsync resolves with', async () => {
		const storage = store(buildSafeStorageCodec(createAsyncSafeStorage()));

		await storage.writeLicenseKey(KEY);

		// A string-shaped read would throw on JSON.parse and answer null.
		expect(await storage.readLicenseKey()).toBe(KEY);
	});

	it('writes ciphertext, not the plaintext', async () => {
		const storage = store(buildSafeStorageCodec(createAsyncSafeStorage()));

		await storage.writeLicenseKey(KEY);

		expect((await readFile(join(directory, 'key'))).toString('utf8')).not.toContain(KEY);
	});

	it('accepts a plain string if a shim resolves with one', async () => {
		const codec = buildSafeStorageCodec({
			isAsyncEncryptionAvailable: async () => true,
			encryptStringAsync: async (plain: string) => Buffer.from(plain, 'utf8'),
			// Not what Electron does, but a wrapper might.
			decryptStringAsync: async (buffer: Buffer) => buffer.toString('utf8'),
		});

		const decrypted = await codec.decrypt(Buffer.from('hello', 'utf8'));

		expect(decrypted).toEqual({ plaintext: 'hello', reencrypt: false });
	});

	it('rewrites the file when the vault asks for a re-encrypt', async () => {
		const storage = store(buildSafeStorageCodec(createAsyncSafeStorage({ shouldReEncrypt: true })));

		await storage.writeLicenseKey(KEY);

		// The read decrypts, is told to re-encrypt, and writes the value
		// back — so the rotation costs one write and the value survives.
		expect(await storage.readLicenseKey()).toBe(KEY);
		expect((await readFile(join(directory, 'key'))).toString('utf8')).not.toContain(KEY);
		expect(await storage.readLicenseKey()).toBe(KEY);
	});

	it('reports the vault unusable when the probe says so', async () => {
		const storage = store(buildSafeStorageCodec(createAsyncSafeStorage({ available: false })));

		expect(await storage.encryptionAvailable()).toBe(false);
		await expect(storage.writeLicenseKey(KEY)).rejects.toThrowError(/vault is not available/);
	});

	it('prefers the async trio when both are present', async () => {
		let syncUsed = false;
		const codec = buildSafeStorageCodec({
			...createAsyncSafeStorage(),
			isEncryptionAvailable: () => {
				syncUsed = true;
				return true;
			},
		});

		await codec.decrypt(Buffer.from('x', 'utf8'));

		// The async path is the one Electron 46 keeps, so it wins.
		expect(syncUsed).toBe(false);
	});
});

describe('a vault that protects nothing', () => {
	it('refuses the basic_text Linux backend', async () => {
		const storage = store(buildSafeStorageCodec(createBasicTextSafeStorage()));

		// The backend reports itself available; it is still refused,
		// because its key is a fixed string in a readable file.
		expect(await storage.encryptionAvailable()).toBe(false);
		await expect(storage.writeLicenseKey(KEY)).rejects.toThrowError(/vault is not available/);
	});

	it('refuses a sync vault that reports itself unavailable', async () => {
		const storage = store(buildSafeStorageCodec(createFakeSafeStorage(false)));

		expect(await storage.encryptionAvailable()).toBe(false);
	});

	it('refuses an object with no encryption methods at all', async () => {
		const storage = store(buildSafeStorageCodec({}));

		expect(await storage.encryptionAvailable()).toBe(false);
	});
});

describe('a file that cannot be read', () => {
	it('answers null for a corrupt cache rather than throwing', async () => {
		const codec = buildSafeStorageCodec(createFakeSafeStorage());
		const storage = store(codec);

		await writeFile(join(directory, 'token'), Buffer.from('not-json-after-decrypt'), {
			mode: 0o600,
		});

		expect(await storage.readToken()).toBeNull();
	});

	it('answers null for a missing cache', async () => {
		const storage = store(buildSafeStorageCodec(createAsyncSafeStorage()));

		expect(await storage.readLicenseKey()).toBeNull();
		expect(await storage.readToken()).toBeNull();
		expect(await storage.readPublicKey()).toBeNull();
	});
});
