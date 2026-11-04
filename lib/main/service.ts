/**
 * The main-process licensing service.
 *
 * This is the only object that talks to the Keygate server, and the only
 * one that touches the local cache. The renderer never sees any of it:
 * the renderer sees the six IPC channels and nothing else.
 *
 * The offline story, which is where Keygate differs from the Keygen
 * plugin this package is modelled on:
 *
 *   Keygen checked a **machine file** out of the server — a separate,
 *   encrypted blob whose TTL the server controlled. Offline validity
 *   came from that file's own lifetime.
 *
 *   Keygate issues a **signed token** instead. The token carries its own
 *   lifetime (`exp`, the check-in interval), the license term (`vun`),
 *   the grace days (`grc`) and the device binding (`fpr`). The client
 *   verifies that signature locally with the server's public key and
 *   needs no network to know whether the license still holds.
 *
 * So there is no checkout call, no machine file, and no second licence
 * format to keep in step with the server.
 */
import { KeygateError } from '../shared/errors.ts';
import type {
	ActivateOptions,
	DeactivateOptions,
	GetEntitlementsOptions,
	KeygateEntitlements,
	KeygateLicense,
	KeygateTokenPayload,
	VerifyOptions,
} from '../shared/types.ts';
import type { KeygateClient } from './client.ts';
import type { KeygateConfig } from './config.ts';
import type { Logger } from './logger.ts';
import { buildMachineIdentity } from './machine.ts';
import type { MachineIdentity } from './machine.ts';
import type { CachedToken, KeygateStorage } from './storage.ts';
import { evaluateTokenFreshness, expectedFingerprint, verifyToken } from './token.ts';

/** How the service was wired up. */
export interface ServiceInitArgs {
	config: KeygateConfig;
	client: KeygateClient;
	storage: KeygateStorage;
	log: Logger;
	/** Overrides the machine identity. Used by tests. */
	identity?: () => Promise<MachineIdentity>;
	/** The current time in unix seconds. Used by tests. */
	now?: () => number;
}

/** The result of a startup restore, for diagnostics. */
export type StartupDiagnostic =
	| { reason: 'restored'; license: KeygateLicense }
	| { reason: 'no-cache' }
	| { reason: 'no-public-key' }
	| { reason: 'bad-token'; detail: string }
	| { reason: 'expired'; detail: string }
	| { reason: 'storage-unavailable'; detail: string };

export class LicensingService {
	private readonly config: KeygateConfig;
	private readonly client: KeygateClient;
	private readonly storage: KeygateStorage;
	private readonly log: Logger;
	private readonly identityFactory: () => Promise<MachineIdentity>;
	private readonly now: () => number;

	/** The license in force, in memory. `null` when unlicensed. */
	private license: KeygateLicense | null = null;
	/** Why startup left the app in this state. */
	private startup: StartupDiagnostic = { reason: 'no-cache' };
	/** The public key in use — pinned, or fetched and cached. */
	private publicKey: string | null = null;

	constructor(args: ServiceInitArgs) {
		this.config = args.config;
		this.client = args.client;
		this.storage = args.storage;
		this.log = args.log;
		this.identityFactory = args.identity ?? (() => buildMachineIdentity());
		this.now = args.now ?? (() => Math.floor(Date.now() / 1000));
	}

	/**
	 * Whether licenses can be persisted at all.
	 *
	 * Check this in the main process: a valid license that cannot be
	 * stored is a license that does not survive a restart.
	 */
	get persistsLicenses(): boolean {
		return this.storage.isAvailable();
	}

	/**
	 * Why startup left the app licensed or unlicensed.
	 *
	 * Deliberately not an IPC channel — it is a main-process diagnostic,
	 * and adding a channel for it would put server detail in the
	 * renderer.
	 */
	get startupDiagnostic(): StartupDiagnostic {
		return this.startup;
	}

	/** The license in force, or `null`. Synchronous, no I/O. */
	getLicense(): KeygateLicense | null {
		return this.license;
	}

	/** The cached license key, decrypted. */
	async getLicenseKey(): Promise<string | null> {
		return this.storage.readLicenseKey();
	}

	/**
	 * Restore the cached license at startup.
	 *
	 * Runs without the network: the cached token is verified against the
	 * server's public key and its own lifetime decides whether it still
	 * holds. The server is not contacted, so a machine that is offline
	 * on launch still starts licensed.
	 */
	async init(): Promise<void> {
		if (!this.storage.isAvailable()) {
			this.startup = {
				reason: 'storage-unavailable',
				detail: 'the operating system encryption vault is unusable',
			};
			this.log.warn('the OS encryption vault is unusable; licenses will not be persisted');
			return;
		}

		const cached = await this.storage.readToken();
		if (!cached) {
			this.startup = { reason: 'no-cache' };
			return;
		}

		// The cached key, or a pinned one. The server is deliberately
		// not consulted here: startup must not need the network.
		const publicKey = await this.resolvePublicKey({ allowFetch: false });
		if (!publicKey) {
			this.startup = { reason: 'no-public-key' };
			this.log.warn(
				'no public key is available; the cached license cannot be verified until the server has been reached once',
			);
			return;
		}

		let payload: KeygateTokenPayload;
		try {
			payload = verifyToken(cached.token, publicKey);
		} catch (err) {
			const detail = err instanceof KeygateError ? err.detail : 'the token could not be verified';
			this.startup = { reason: 'bad-token', detail };
			this.log.warn('the cached license token did not verify; starting unlicensed');
			return;
		}

		const freshness = evaluateTokenFreshness(payload, {
			now: this.now(),
			maxClockDriftSeconds: this.config.maxClockDriftSeconds,
		});
		if (!freshness.valid) {
			this.startup = { reason: 'expired', detail: freshness.reason ?? 'expired' };
			this.log.warn('the cached license token has expired; starting unlicensed');
			return;
		}

		// The token was verified, so the state it describes is the state
		// the server last confirmed. It is restored offline — the server
		// was not asked — and the caller can tell the difference.
		this.license = { ...cached.license, offline: true };
		this.startup = { reason: 'restored', license: this.license };
		this.log.info('restored the cached license offline');
	}

	/**
	 * The public key to verify tokens with.
	 *
	 * A pinned key always wins. Without one, the key is cached on disk
	 * the first time it is fetched, so an offline machine can still
	 * verify the token it already holds — which is the whole point of
	 * the offline path.
	 *
	 * The order is: pinned, then the cached copy, then the server. The
	 * server is asked last so a machine that is offline never waits on
	 * a request that cannot succeed.
	 */
	private async resolvePublicKey(options: { allowFetch?: boolean } = {}): Promise<string | null> {
		if (this.config.publicKey) {
			return this.config.publicKey;
		}
		if (this.publicKey) {
			return this.publicKey;
		}

		// The cached copy first: it is what an offline launch uses.
		const cached = await this.storage.readPublicKey();
		if (cached && /^[0-9a-f]{64}$/.test(cached)) {
			this.publicKey = cached;
			return cached;
		}

		if (options.allowFetch === false) {
			return null;
		}

		try {
			const data = await this.client.fetchPublicKey();
			const key = data.public_key.trim().toLowerCase();
			if (!/^[0-9a-f]{64}$/.test(key)) {
				throw new KeygateError({
					code: 'BAD_RESPONSE',
					detail: 'the server answered with a public key that is not 64 hex characters',
				});
			}
			this.publicKey = key;
			// Cache it, so the next launch works offline. A failure to
			// cache must not fail the operation that succeeded.
			try {
				await this.storage.writePublicKey(key);
			} catch (err) {
				const detail = err instanceof KeygateError ? err.detail : 'the key could not be cached';
				this.log.warn(`the public key could not be cached: ${detail}`);
			}
			return key;
		} catch (err) {
			const detail = err instanceof KeygateError ? err.detail : 'the public key could not be fetched';
			this.log.warn(`the public key could not be fetched: ${detail}`);
			return null;
		}
	}

	/** The identifier this machine activates under. */
	private async resolveIdentifier(override?: string): Promise<string> {
		if (override && override.trim().length > 0) {
			return override.trim();
		}
		if (this.config.identifier) {
			return this.config.identifier;
		}
		const identity = await this.identityFactory();
		if (!identity.identifier || identity.identifier.length === 0) {
			throw new KeygateError({
				code: 'NO_IDENTIFIER',
				detail: 'this machine has no usable device identifier',
			});
		}
		return identity.identifier;
	}

	/** The device name shown in the customer portal. */
	private async resolveDeviceName(): Promise<string> {
		const identity = await this.identityFactory();
		return identity.deviceName;
	}

	/**
	 * Activate a license on this device.
	 *
	 * The server registers the identifier and returns a signed token.
	 * Re-activating an identifier that is already active answers
	 * `already_activated` without taking another slot, so this is safe
	 * to call again.
	 */
	async activate(options: ActivateOptions): Promise<KeygateLicense> {
		const identifier = await this.resolveIdentifier(options.identifier);
		const label = options.label ?? (await this.resolveDeviceName());

		// Probe the vault before the network call: a successful
		// activation that cannot be stored would look like a license the
		// app has and cannot keep.
		this.assertStorageUsable();

		const data = await this.client.activate({
			key: options.key,
			identifier,
			label,
		});

		const publicKey = await this.requirePublicKey();
		const payload = verifyToken(data.token, publicKey);
		this.assertTokenBinding(payload, identifier);
		const license = this.buildLicense(options.key, payload, false);

		await this.persist(options.key, data.token, payload, license);
		this.license = license;
		this.log.info(`license ${license.licenseId} activated on this device`);
		return license;
	}

	/**
	 * Verify a license against the server.
	 *
	 * The server answers 404 for a license that does not exist, one that
	 * is suspended or revoked, and one where this device has no
	 * activation — deliberately the same answer for all three, so the
	 * endpoint cannot be used to probe which keys are real. The error
	 * code is passed through as the server sent it.
	 */
	async verify(options: VerifyOptions): Promise<KeygateLicense> {
		const key = options.key ?? (await this.storage.readLicenseKey());
		if (!key) {
			throw new KeygateError({
				code: 'NO_LICENSE',
				detail: 'there is no license key to verify',
			});
		}
		const identifier = await this.resolveIdentifier(options.identifier);

		this.assertStorageUsable();

		const data = await this.client.verify({ key, identifier });

		const publicKey = await this.requirePublicKey();
		const payload = verifyToken(data.token, publicKey);
		this.assertTokenBinding(payload, identifier);
		const license = this.buildLicense(key, payload, false, {
			planName: data.plan_name,
			meta: {
				...(data.meta ?? {}),
				...(data.external_customer_id ? { external_customer_id: data.external_customer_id } : {}),
				...(data.external_workspace_id ? { external_workspace_id: data.external_workspace_id } : {}),
			},
		});

		await this.persist(key, data.token, payload, license);
		this.license = license;
		this.log.info(`license ${license.licenseId} verified`);
		return license;
	}

	/**
	 * Release this device's activation slot.
	 *
	 * The server does not check the license's status here: a suspended
	 * or expired license can still free its slots, which is what makes
	 * this useful for a customer moving machines.
	 */
	async deactivate(options: DeactivateOptions): Promise<void> {
		const key = options.key ?? (await this.storage.readLicenseKey());
		if (!key) {
			throw new KeygateError({
				code: 'NO_LICENSE',
				detail: 'there is no license key to deactivate',
			});
		}
		const identifier = await this.resolveIdentifier(options.identifier);

		await this.client.deactivate({ key, identifier });

		// The device is no longer activated, so the cached token must
		// not keep the app licensed.
		await this.storage.clearToken();
		this.license = null;
		this.log.info('the license was deactivated on this device');
	}

	/**
	 * The license's feature entitlements.
	 *
	 * The signed token already carries the feature map, so the offline
	 * answer is available without a network call. The server's
	 * entitlements endpoint adds quota usage and reset dates, so it is
	 * consulted when the network is available.
	 */
	async getEntitlements(options: GetEntitlementsOptions): Promise<KeygateEntitlements> {
		const key = options.key ?? (await this.storage.readLicenseKey());
		if (!key) {
			throw new KeygateError({
				code: 'NO_LICENSE',
				detail: 'there is no license key to check',
			});
		}

		try {
			return await this.client.entitlements({
				key,
				...(options.feature !== undefined ? { feature: options.feature } : {}),
			});
		} catch (err) {
			// Fall back to the signed token's feature map. It is less
			// detailed — no quota usage — but it is verified and offline.
			const cached = await this.storage.readToken();
			if (!cached) {
				throw err instanceof KeygateError
					? err
					: new KeygateError({ code: 'ERR', detail: 'the entitlements could not be read' });
			}
			const features = cached.payload.ftr ?? {};
			const normalized: Record<string, { enabled: boolean; valueType: string; value: string }> = {};
			for (const [name, value] of Object.entries(features)) {
				normalized[name] = {
					enabled: value === true || value === 'true',
					valueType: typeof value === 'boolean' ? 'bool' : 'string',
					value: typeof value === 'boolean' ? String(value) : String(value ?? ''),
				};
			}
			return {
				licensed: cached.license.valid,
				status: cached.payload.sts,
				planId: cached.payload.pln,
				planName: cached.license.planName ?? '',
				features: normalized,
			};
		}
	}

	/**
	 * Forget the license: the cached token and the in-memory state.
	 *
	 * The cached key is kept — it is the credential, not the state — so
	 * the app can verify again without asking the customer to retype
	 * it.
	 */
	async resetLicense(): Promise<void> {
		await this.storage.clearToken();
		this.license = null;
		this.log.info('the local license state was cleared');
	}

	/** Forget the cached license key as well. */
	async resetLicenseKey(): Promise<void> {
		await this.storage.clearLicenseKey();
		this.log.info('the cached license key was cleared');
	}

	/** The public key in use, for diagnostics. */
	getPublicKey(): string | null {
		return this.config.publicKey ?? this.publicKey;
	}

	/** Fail when the vault cannot be used. */
	private assertStorageUsable(): void {
		if (!this.storage.isAvailable()) {
			throw new KeygateError({
				code: 'STORAGE_UNAVAILABLE',
				detail: 'the operating system encryption vault is not available',
			});
		}
	}

	/** The public key, fetching it when it is not pinned. */
	private async requirePublicKey(): Promise<string> {
		const key = await this.resolvePublicKey();
		if (!key) {
			throw new KeygateError({
				code: 'CONFIG',
				detail: 'no public key is available to verify the server token',
			});
		}
		return key;
	}

	/**
	 * Refuse a token that was not issued for this device.
	 *
	 * The signature proves the server issued the token. The binding
	 * proves it issued it *for this device*: the server writes the
	 * identifier it was asked about into the token and hashes it with
	 * the product id.
	 *
	 * Without this check, a token copied from another machine — or
	 * replayed from another product — would verify perfectly well and
	 * would leave this machine looking licensed.
	 */
	private assertTokenBinding(payload: KeygateTokenPayload, identifier: string): void {
		if (!tokenBindingMatches(payload, identifier)) {
			throw new KeygateError({
				code: 'BAD_TOKEN',
				detail: 'the token was issued for a different device or product',
			});
		}
	}

	/** Write the license key and the token to the cache. */
	private async persist(
		key: string,
		token: string,
		payload: KeygateTokenPayload,
		license: KeygateLicense,
	): Promise<void> {
		const entry: CachedToken = {
			token,
			payload,
			license,
			storedAt: Date.now(),
		};
		await this.storage.writeToken(entry);
		await this.storage.writeLicenseKey(key);
	}

	/**
	 * Turn a verified token into the license state the renderer sees.
	 *
	 * `valid` is set only here, and only from a token whose signature
	 * verified. `status` is a report of what the server said, never a
	 * verdict.
	 */
	private buildLicense(
		key: string,
		payload: KeygateTokenPayload,
		offline: boolean,
		extra: { planName?: string; meta?: Record<string, unknown> } = {},
	): KeygateLicense {
		const features = payload.ftr ?? {};
		const entitlements = Object.entries(features)
			.filter(([, value]) => value === true || value === 'true')
			.map(([name]) => name);

		const meta: Record<string, unknown> = { ...(extra.meta ?? {}) };

		return {
			key,
			status: payload.sts,
			valid: true,
			licenseId: payload.lid,
			productId: payload.pid,
			planId: payload.pln,
			planName: extra.planName ?? null,
			features,
			entitlements,
			validUntil: payload.vun && payload.vun > 0 ? new Date(payload.vun * 1000).toISOString() : null,
			updatesUntil:
				payload.upd && payload.upd > 0 ? new Date(payload.upd * 1000).toISOString() : null,
			graceDays: payload.grc ?? 0,
			identifier: payload.did,
			issuedAt: new Date(payload.iat * 1000).toISOString(),
			expiresAt: new Date(payload.exp * 1000).toISOString(),
			offline,
			metadata: meta,
		};
	}
}

/**
 * Check that a token was issued for this device and product.
 *
 * The server binds the token to the pair with `fpr`. A token whose
 * binding does not match was issued for a different device, or a
 * different product, and must not be used here.
 */
export function tokenBindingMatches(
	payload: KeygateTokenPayload,
	identifier: string,
): boolean {
	if (!payload.fpr) {
		// A token without a binding is not bound to anything. Refusing it
		// would break against a server that does not write one; accepting
		// it silently would drop the check. The identifier comparison
		// below still applies.
		return payload.did === identifier;
	}
	if (payload.did !== identifier) {
		return false;
	}
	return payload.fpr === expectedFingerprint(identifier, payload.pid);
}
