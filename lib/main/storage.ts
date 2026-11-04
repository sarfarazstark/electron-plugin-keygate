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
 *
 * The async trio arrived in Electron 45 and the sync pair was removed
 * in Electron 46, so a package that claims to support `electron >= 30`
 * has to speak both.
 */
export interface SafeStorageLike {
	/** Electron 30–45. */
	isEncryptionAvailable?(): boolean;
	encryptString?(plainText: string): Buffer;
	decryptString?(encrypted: Buffer): string;
	/** Electron 45+. */
	isAsyncEncryptionAvailable?(): Promise<boolean>;
	encryptStringAsync?(plainText: string): Promise<Buffer>;
	/**
	 * Electron 45+ resolves with an **object**, not a string:
	 * `{ result, shouldReEncrypt }`.
	 *
	 * The plain string is accepted as well, because a shim or an older
	 * Electron may return that, and reading the wrong shape would
	 * silently turn every cached license into a parse failure.
	 */
	decryptStringAsync?(
		encrypted: Buffer,
	): Promise<{ result: string; shouldReEncrypt?: boolean } | string>;
	/** Linux only: the selected secret store, or `basic_text` for none. */
	getSelectedStorageBackend?(): string;
}

/** The result of a decrypt. */
export interface DecryptedSecret {
	/** The plaintext. */
	plaintext: string;
	/**
	 * Whether the OS vault says the value should be re-encrypted —
	 * the key has rotated, or a better one is now available.
	 */
	reencrypt: boolean;
}

/** A codec that encrypts and decrypts strings. */
export interface SecretCodec {
	/** Whether the OS vault can be used at all. */
	isAvailable(): Promise<boolean>;
	/** Encrypt a string. Throws `STORAGE_UNAVAILABLE` when it cannot. */
	encrypt(plainText: string): Promise<Buffer>;
	/** Decrypt a buffer. Throws `STORAGE_DECRYPT_FAILED` when it cannot. */
	decrypt(encrypted: Buffer): Promise<DecryptedSecret>;
}

/**
 * Build a codec over Electron's `safeStorage`.
 *
 * The methods are bound to the object: `safeStorage` relies on `this`,
 * and a detached method throws "Illegal invocation". That failure looks
 * identical to "no vault here" from the outside, because the
 * availability probe swallows it — so the trio is bound once here and
 * never destructured into free functions.
 */
export function buildSafeStorageCodec(safeStorage: SafeStorageLike): SecretCodec {
	const isAsyncAvailable = safeStorage.isAsyncEncryptionAvailable?.bind(safeStorage);
	const encryptAsync = safeStorage.encryptStringAsync?.bind(safeStorage);
	const decryptAsync = safeStorage.decryptStringAsync?.bind(safeStorage);

	const isSyncAvailable = safeStorage.isEncryptionAvailable?.bind(safeStorage);
	const encryptSync = safeStorage.encryptString?.bind(safeStorage);
	const decryptSync = safeStorage.decryptString?.bind(safeStorage);

	const backend = safeStorage.getSelectedStorageBackend?.bind(safeStorage);

	// The async trio is preferred: it is the one Electron 46 keeps.
	const useAsync =
		typeof isAsyncAvailable === 'function' &&
		typeof encryptAsync === 'function' &&
		typeof decryptAsync === 'function';

	const usable = async (): Promise<boolean> => {
		// `basic_text` is libsecret's fallback: the key is a fixed string
		// in a world-readable file, so it protects nothing.
		if (typeof backend === 'function' && backend() === 'basic_text') {
			return false;
		}
		if (useAsync) {
			try {
				return await isAsyncAvailable!();
			} catch {
				return false;
			}
		}
		if (typeof isSyncAvailable === 'function' && typeof encryptSync === 'function') {
			try {
				return isSyncAvailable();
			} catch {
				return false;
			}
		}
		return false;
	};

	return {
		isAvailable: usable,
		async encrypt(plainText) {
			if (!(await usable())) {
				throw new KeygateError({
					code: 'STORAGE_UNAVAILABLE',
					detail: 'the operating system encryption vault is not available',
				});
			}
			try {
				return useAsync ? await encryptAsync!(plainText) : encryptSync!(plainText);
			} catch (err) {
				const detail = err instanceof Error ? err.message : 'the vault refused to encrypt';
				throw new KeygateError({
					code: 'STORAGE_UNAVAILABLE',
					detail: `the vault could not encrypt the value: ${detail}`,
				});
			}
		},
		async decrypt(encrypted) {
			if (!(await usable())) {
				throw new KeygateError({
					code: 'STORAGE_UNAVAILABLE',
					detail: 'the operating system encryption vault is not available',
				});
			}
			try {
				if (!useAsync) {
					return { plaintext: decryptSync!(encrypted), reencrypt: false };
				}
				const result = await decryptAsync!(encrypted);
				// Electron 45+ resolves with an object. A shim may resolve
				// with the string itself, so both shapes are read.
				if (typeof result === 'string') {
					return { plaintext: result, reencrypt: false };
				}
				return {
					plaintext: result.result,
					reencrypt: result.shouldReEncrypt === true,
				};
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

/** A decrypted file, and whether the vault wants it written again. */
interface ReadSecret {
	value: string;
	reencrypt: boolean;
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
	async encryptionAvailable(): Promise<boolean> {
		return this.codec.isAvailable();
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
	}

	/** Write an encrypted file. */
	private async writeEncrypted(name: string, plainText: string): Promise<void> {
		if (!(await this.codec.isAvailable())) {
			throw new KeygateError({
				code: 'STORAGE_UNAVAILABLE',
				detail: 'the operating system encryption vault is not available',
			});
		}
		const ciphertext = await this.codec.encrypt(plainText);
		await this.ensureDirectory();
		await writeFile(this.pathFor(name), ciphertext, { mode: 0o600 });
	}

	/**
	 * Read an encrypted file. Returns `null` when it is not there.
	 *
	 * When the vault reports that the key has rotated, the file is
	 * rewritten with the new key: the value stays readable, and the
	 * next read does not have to rotate again.
	 */
	private async readEncrypted(name: string): Promise<ReadSecret | null> {
		let ciphertext: Buffer;
		try {
			ciphertext = await readFile(this.pathFor(name));
		} catch {
			return null;
		}
		if (ciphertext.length === 0) {
			return null;
		}
		const decrypted = await this.codec.decrypt(ciphertext);
		if (decrypted.reencrypt) {
			try {
				await this.writeEncrypted(name, decrypted.plaintext);
			} catch {
				// The rotation is an optimisation; failing it must not
				// lose the value that was just read.
			}
		}
		return { value: decrypted.plaintext, reencrypt: decrypted.reencrypt };
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
		const secret = await this.readEncrypted('key');
		if (secret === null) {
			return null;
		}
		try {
			const parsed = JSON.parse(secret.value) as { key?: unknown };
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
		const secret = await this.readEncrypted('token');
		if (secret === null) {
			return null;
		}
		try {
			const parsed = JSON.parse(secret.value) as Partial<CachedToken>;
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
		const secret = await this.readEncrypted('pubkey');
		if (secret === null) {
			return null;
		}
		try {
			const parsed = JSON.parse(secret.value) as { publicKey?: unknown };
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
