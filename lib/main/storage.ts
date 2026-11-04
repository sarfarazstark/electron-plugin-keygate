/**
 * Secure local persistence.
 *
 * Two things are stored under `userData/keygate/`:
 *
 *   key    the license key, encrypted
 *   token  the signed token and its metadata, encrypted
 *
 * Everything is encrypted with Electron's `safeStorage` — the OS vault
 * (DPAPI on Windows, Keychain on macOS, libsecret or kwallet on Linux).
 * There is **no plaintext fallback**: a vault that cannot encrypt is a
 * vault that cannot be used, and the package says so rather than writing
 * a license key to disk in the clear.
 *
 * Linux's `basic_text` backend counts as unusable. It is encryption in
 * name only — the "key" is a fixed string in a world-readable file — so
 * a license stored under it would be readable by every process on the
 * machine.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KeygateError } from '../shared/errors.ts';
import type { KeygateLicense, KeygateTokenPayload } from '../shared/types.ts';

/**
 * The subset of Electron's `safeStorage` this package uses.
 *
 * Declared structurally so the storage layer can be tested without
 * Electron, and so the async and sync variants are both usable.
 */
export interface SafeStorageLike {
	isEncryptionAvailable?(): boolean;
	encryptString?(plainText: string): Buffer;
	decryptString?(encrypted: Buffer): string;
	encryptStringAsync?(plainText: string): Promise<Buffer>;
	decryptStringAsync?(encrypted: Buffer): Promise<string>;
	getSelectedStorageBackend?(): string;
}

/** A codec that encrypts and decrypts strings. */
export interface SecretCodec {
	/** Whether the OS vault can be used at all. */
	isAvailable(): boolean;
	/** Encrypt a string. Throws `STORAGE_UNAVAILABLE` when it cannot. */
	encrypt(plainText: string): Promise<Buffer>;
	/** Decrypt a buffer. Throws `STORAGE_DECRYPT_FAILED` when it cannot. */
	decrypt(encrypted: Buffer): Promise<string>;
}

/**
 * Build a codec over Electron's `safeStorage`.
 *
 * The methods are bound to the object: `safeStorage` relies on `this`,
 * and a detached method throws.
 */
export function buildSafeStorageCodec(safeStorage: SafeStorageLike): SecretCodec {
	const encryptSync = safeStorage.encryptString?.bind(safeStorage);
	const decryptSync = safeStorage.decryptString?.bind(safeStorage);
	const encryptAsync = safeStorage.encryptStringAsync?.bind(safeStorage);
	const decryptAsync = safeStorage.decryptStringAsync?.bind(safeStorage);
	const isAvailable = safeStorage.isEncryptionAvailable?.bind(safeStorage);
	const backend = safeStorage.getSelectedStorageBackend?.bind(safeStorage);

	const usable = (): boolean => {
		if (typeof isAvailable === 'function' && !isAvailable()) {
			return false;
		}
		if (typeof encryptSync !== 'function' && typeof encryptAsync !== 'function') {
			return false;
		}
		if (typeof decryptSync !== 'function' && typeof decryptAsync !== 'function') {
			return false;
		}
		// `basic_text` is libsecret's fallback: the key is a fixed string
		// in a world-readable file, so it protects nothing.
		if (typeof backend === 'function' && backend() === 'basic_text') {
			return false;
		}
		return true;
	};

	return {
		isAvailable: usable,
		async encrypt(plainText) {
			if (!usable()) {
				throw new KeygateError({
					code: 'STORAGE_UNAVAILABLE',
					detail: 'the operating system encryption vault is not available',
				});
			}
			try {
				if (typeof encryptAsync === 'function') {
					return await encryptAsync(plainText);
				}
				return encryptSync!(plainText);
			} catch (err) {
				const detail = err instanceof Error ? err.message : 'the vault refused to encrypt';
				throw new KeygateError({
					code: 'STORAGE_UNAVAILABLE',
					detail: `the vault could not encrypt the value: ${detail}`,
				});
			}
		},
		async decrypt(encrypted) {
			if (!usable()) {
				throw new KeygateError({
					code: 'STORAGE_UNAVAILABLE',
					detail: 'the operating system encryption vault is not available',
				});
			}
			try {
				if (typeof decryptAsync === 'function') {
					return await decryptAsync(encrypted);
				}
				return decryptSync!(encrypted);
			} catch (err) {
				const detail = err instanceof Error ? err.message : 'the vault refused to decrypt';
				throw new KeygateError({
					code: 'STORAGE_DECRYPT_FAILED',
					detail: `the stored value could not be decrypted: ${detail}`,
				});
			}
		},
	};
}

/** The cached signed token and the state derived from it. */
export interface CachedToken {
	/** The signed token, exactly as the server sent it. */
	token: string;
	/** The decoded payload. */
	payload: KeygateTokenPayload;
	/** The license state built from the payload. */
	license: KeygateLicense;
	/** When this entry was written, unix milliseconds. */
	storedAt: number;
}

/**
 * The on-disk store.
 *
 * Every write probes the vault first: a successful validation must not
 * turn into a storage error afterwards, and a file the next launch
 * cannot read is worse than no file at all.
 */
export class KeygateStorage {
	private readonly directory: string;
	private readonly codec: SecretCodec;

	constructor(options: { directory: string; codec: SecretCodec }) {
		this.directory = options.directory;
		this.codec = options.codec;
	}

	/** The directory this store writes to. */
	get dir(): string {
		return this.directory;
	}

	private pathFor(name: string): string {
		return join(this.directory, name);
	}

	/** Whether the OS vault can be used. */
	isAvailable(): boolean {
		return this.codec.isAvailable();
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
	}

	/** Write an encrypted file. */
	private async writeEncrypted(name: string, plainText: string): Promise<void> {
		if (!this.codec.isAvailable()) {
			throw new KeygateError({
				code: 'STORAGE_UNAVAILABLE',
				detail: 'the operating system encryption vault is not available',
			});
		}
		const ciphertext = await this.codec.encrypt(plainText);
		await this.ensureDirectory();
		await writeFile(this.pathFor(name), ciphertext, { mode: 0o600 });
	}

	/** Read an encrypted file. Returns `null` when it is not there. */
	private async readEncrypted(name: string): Promise<string | null> {
		let ciphertext: Buffer;
		try {
			ciphertext = await readFile(this.pathFor(name));
		} catch {
			return null;
		}
		if (ciphertext.length === 0) {
			return null;
		}
		return this.codec.decrypt(ciphertext);
	}

	/** Remove a file. A file that is not there is not an error. */
	private async remove(name: string): Promise<void> {
		try {
			await rm(this.pathFor(name), { force: true });
		} catch {
			// Nothing to remove.
		}
	}

	/** The cached license key, or `null`. */
	async readLicenseKey(): Promise<string | null> {
		const value = await this.readEncrypted('key');
		if (value === null) {
			return null;
		}
		try {
			const parsed = JSON.parse(value) as { key?: unknown };
			return typeof parsed.key === 'string' && parsed.key.length > 0 ? parsed.key : null;
		} catch {
			return null;
		}
	}

	/** Cache the license key. */
	async writeLicenseKey(key: string): Promise<void> {
		await this.writeEncrypted('key', JSON.stringify({ key }));
	}

	/** Forget the license key. */
	async clearLicenseKey(): Promise<void> {
		await this.remove('key');
	}

	/** The cached token, or `null`. */
	async readToken(): Promise<CachedToken | null> {
		const value = await this.readEncrypted('token');
		if (value === null) {
			return null;
		}
		try {
			const parsed = JSON.parse(value) as Partial<CachedToken>;
			if (
				typeof parsed.token !== 'string' ||
				typeof parsed.payload !== 'object' ||
				parsed.payload === null ||
				typeof parsed.license !== 'object' ||
				parsed.license === null
			) {
				return null;
			}
			return {
				token: parsed.token,
				payload: parsed.payload,
				license: parsed.license,
				storedAt: typeof parsed.storedAt === 'number' ? parsed.storedAt : 0,
			};
		} catch {
			return null;
		}
	}

	/** Cache the token and its derived state. */
	async writeToken(entry: CachedToken): Promise<void> {
		await this.writeEncrypted('token', JSON.stringify(entry));
	}

	/** Forget the cached token. */
	async clearToken(): Promise<void> {
		await this.remove('token');
	}

	/**
	 * The cached verification public key, or `null`.
	 *
	 * This is what makes an offline restore possible. The key is public
	 * information — it is cached so a machine that cannot reach the
	 * server can still verify the token it already holds.
	 */
	async readPublicKey(): Promise<string | null> {
		const value = await this.readEncrypted('pubkey');
		if (value === null) {
			return null;
		}
		try {
			const parsed = JSON.parse(value) as { publicKey?: unknown };
			return typeof parsed.publicKey === 'string' && parsed.publicKey.length > 0
				? parsed.publicKey
				: null;
		} catch {
			return null;
		}
	}

	/** Cache the verification public key. */
	async writePublicKey(publicKey: string): Promise<void> {
		await this.writeEncrypted('pubkey', JSON.stringify({ publicKey }));
	}

	/** Forget the cached public key. */
	async clearPublicKey(): Promise<void> {
		await this.remove('pubkey');
	}

	/** Forget everything. */
	async clearAll(): Promise<void> {
		await this.clearToken();
		await this.clearLicenseKey();
		await this.clearPublicKey();
	}
}
