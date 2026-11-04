/**
 * Doubles for Electron's `safeStorage`.
 *
 * A real one is encrypted by the OS; these are reversible so a test can
 * assert that the bytes on disk are not the plaintext without needing a
 * keychain.
 *
 * Two shapes are covered, because Electron 45 introduced the async API
 * and Electron 46 removed the sync one:
 *
 *   - the sync trio, as in Electron 30–45
 *   - the async trio, as in Electron 45+, whose `decryptStringAsync`
 *     resolves with an **object** rather than a string
 */
import type { SafeStorageLike } from '../../lib/main/storage.ts';

export interface FakeSafeStorage extends SafeStorageLike {
	/** The bytes written to disk, by file name. */
	written: Map<string, Buffer>;
	/** How many decrypts have run. Used to assert a re-encrypt happened. */
	decrypts: number;
}

const MASK = Buffer.from('keygate-test-mask');

function xor(plain: Buffer): Buffer {
	const out = Buffer.alloc(plain.length);
	for (let i = 0; i < plain.length; i += 1) {
		out[i] = plain[i]! ^ MASK[i % MASK.length]!;
	}
	return out;
}

/** The sync shape, as in Electron 30–45. */
export function createFakeSafeStorage(available = true): FakeSafeStorage {
	const written = new Map<string, Buffer>();
	let decrypts = 0;

	return {
		written,
		get decrypts() {
			return decrypts;
		},
		isEncryptionAvailable() {
			return available;
		},
		encryptString(plainText: string) {
			return xor(Buffer.from(plainText, 'utf8'));
		},
		decryptString(encrypted: Buffer) {
			decrypts += 1;
			return xor(encrypted).toString('utf8');
		},
	};
}

/**
 * The async shape, as in Electron 45 and later.
 *
 * `decryptStringAsync` resolves with `{ result, shouldReEncrypt }` —
 * an object, not a string. The reference package caught this: reading
 * it as a string turns every cached licence into a parse failure, and
 * the offline restore silently stops working.
 */
export function createAsyncSafeStorage(
	options: { available?: boolean; shouldReEncrypt?: boolean } = {},
): FakeSafeStorage {
	const available = options.available ?? true;
	const shouldReEncrypt = options.shouldReEncrypt ?? false;
	const written = new Map<string, Buffer>();
	let decrypts = 0;

	return {
		written,
		get decrypts() {
			return decrypts;
		},
		async isAsyncEncryptionAvailable() {
			return available;
		},
		async encryptStringAsync(plainText: string) {
			return xor(Buffer.from(plainText, 'utf8'));
		},
		async decryptStringAsync(encrypted: Buffer) {
			decrypts += 1;
			return { result: xor(encrypted).toString('utf8'), shouldReEncrypt };
		},
	};
}

/**
 * A `safeStorage` that reports itself unavailable.
 *
 * This is what a Linux box with the `basic_text` backend looks like.
 */
export function createUnavailableSafeStorage(): FakeSafeStorage {
	return createFakeSafeStorage(false);
}

/**
 * A `safeStorage` whose backend is `basic_text`.
 *
 * `isEncryptionAvailable()` says yes, and the data is readable by
 * anyone — the exact case the storage layer must refuse.
 */
export function createBasicTextSafeStorage(): SafeStorageLike {
	return {
		isEncryptionAvailable: () => true,
		encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
		decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
		getSelectedStorageBackend: () => 'basic_text',
	};
}
