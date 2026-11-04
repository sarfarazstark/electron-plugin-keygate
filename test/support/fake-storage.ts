/**
 * A fake `safeStorage`.
 *
 * A real one is encrypted by the OS; this one is a reversible XOR so a
 * test can assert that the bytes on disk are not the plaintext without
 * needing a keychain.
 */
import type { SafeStorageLike } from '../../lib/main/storage.ts';

export interface FakeSafeStorage extends SafeStorageLike {
	/** The bytes written to disk, by file name. */
	written: Map<string, Buffer>;
}

export function createFakeSafeStorage(available = true): FakeSafeStorage {	const written = new Map<string, Buffer>();
	const mask = Buffer.from('keygate-test-mask');

	return {
		written,
		isEncryptionAvailable() {
			return available;
		},
		encryptString(plainText: string) {
			const plain = Buffer.from(plainText, 'utf8');
			const out = Buffer.alloc(plain.length);
			for (let i = 0; i < plain.length; i += 1) {
				out[i] = plain[i]! ^ mask[i % mask.length]!;
			}
			return out;
		},
		decryptString(encrypted: Buffer) {
			const out = Buffer.alloc(encrypted.length);
			for (let i = 0; i < encrypted.length; i += 1) {
				out[i] = encrypted[i]! ^ mask[i % mask.length]!;
			}
			return out.toString('utf8');
		},
	};
}

/**
 * A `safeStorage` that reports itself unavailable.
 *
 * This is what a Linux box with the `basic_text` backend looks like.
 */
export function createUnavailableSafeStorage(): FakeSafeStorage {
	const fake = createFakeSafeStorage(false);
	return fake;
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
