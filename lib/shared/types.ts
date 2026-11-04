/**
 * The contract shared by all three processes.
 *
 * Nothing in this file may import `electron` — the renderer and both
 * preloads load it, and the preload bundle has to stay free of it.
 */

/** Fixed channel names. There is no arbitrary-invoke channel. */
export const KEYGATE_CHANNELS = {
	getLicense: 'keygate:get-license',
	getLicenseKey: 'keygate:get-license-key',
	activate: 'keygate:activate',
	verify: 'keygate:verify',
	deactivate: 'keygate:deactivate',
	getEntitlements: 'keygate:get-entitlements',
	resetLicense: 'keygate:reset-license',
	resetLicenseKey: 'keygate:reset-license-key',
} as const;

export type KeygateChannel = (typeof KEYGATE_CHANNELS)[keyof typeof KEYGATE_CHANNELS];

/**
 * The envelope every IPC handler answers with. Nothing throws across the
 * boundary: `contextBridge` strips custom fields off thrown objects, so a
 * failure has to travel as data.
 */
export type IpcResult<T> =
	| { ok: true; data: T }
	| {
			ok: false;
			error: {
				code: string;
				detail: string;
				/** The server's structured error details, verbatim. */
				details?: Record<string, unknown>;
				/** Seconds to wait before retrying, when the server said so. */
				retryAfterSeconds?: number;
			};
	  };

/** A single entitlement as the Keygate server reports it. */
export interface KeygateFeatureStatus {
	enabled: boolean;
	valueType: string;
	value: string;
	used?: number;
	limit?: number;
	remaining?: number;
	period?: string;
	resetsAt?: string;
}

/** The answer to `POST /license/entitlements`. */
export interface KeygateEntitlements {
	licensed: boolean;
	status: string;
	planId: string;
	planName: string;
	features: Record<string, KeygateFeatureStatus>;
}

/**
 * The license state the renderer sees.
 *
 * `status` is a report, never a verdict: it carries the status string the
 * server put in the signed token (`active`, `trialing`, `past_due`, …).
 * `valid` is the verdict, and it is only ever set after the signed token
 * verified against the server's public key.
 */
export interface KeygateLicense {
	/** The license key this state belongs to. */
	key: string;
	/** License status at issue time, as recorded in the signed token. */
	status: string;
	/** Whether the license is currently in force. */
	valid: boolean;
	licenseId: string;
	productId: string;
	planId: string;
	planName: string | null;
	/** Feature entitlements, exactly as the signed token carries them. */
	features: Record<string, unknown>;
	/** The names of the enabled features, for cheap `includes()` checks. */
	entitlements: string[];
	/** When the license itself lapses. `null` means perpetual. */
	validUntil: string | null;
	/** End of the maintenance period of a perpetual license. */
	updatesUntil: string | null;
	/** Grace days the server granted after `validUntil`. */
	graceDays: number;
	/** The device identifier the token was issued for. */
	identifier: string;
	/** When the token was issued. */
	issuedAt: string | null;
	/**
	 * When the token stops being usable offline. This is the server's
	 * check-in interval, not the license term.
	 */
	expiresAt: string | null;
	/**
	 * True when this state was restored from the local cache rather than
	 * confirmed against the server on this launch.
	 */
	offline: boolean;
	/** Server-supplied metadata (`meta`, external ids). */
	metadata: Record<string, unknown>;
}

/** Options for `keygate:activate`. */
export interface ActivateOptions {
	/** The license key to activate. */
	key: string;
	/** Human-readable name for the activation, shown in the customer portal. */
	label?: string;
	/** Override the device identifier. Defaults to this machine's. */
	identifier?: string;
	/**
	 * What the identifier names.
	 *
	 * `device` is the default and is what this machine's identifier is.
	 * `user` is for licensing a person rather than a machine — the
	 * identifier is then that person's, usually their email address,
	 * and the `identifier` option must be given: this package will not
	 * invent one, because the machine id is not a person.
	 *
	 * The server stores this with the activation and shows it in the
	 * customer portal. It does not change how a license is counted.
	 */
	identifierType?: 'device' | 'user';
}

/** Options for `keygate:verify`. */
export interface VerifyOptions {
	/** The key to verify. Falls back to the cached key when omitted. */
	key?: string;
	/** Override the device identifier. Defaults to this machine's. */
	identifier?: string;
}

/** Options for `keygate:deactivate`. */
export interface DeactivateOptions {
	/** The key to deactivate. Falls back to the cached key when omitted. */
	key?: string;
	/** Override the device identifier. Defaults to this machine's. */
	identifier?: string;
}

/** Options for `keygate:get-entitlements`. */
export interface GetEntitlementsOptions {
	/** The key to check. Falls back to the cached key when omitted. */
	key?: string;
	/** Check a single feature rather than all of them. */
	feature?: string;
}

/**
 * The signed-token payload, as Keygate puts it on the wire.
 *
 * Field names are the server's, not ours — they are the JSON keys of
 * `license.VerifyToken` and the short names are load-bearing. `vun` and
 * `upd` are omitted when zero, and `ftr` when empty.
 */
export interface KeygateTokenPayload {
	/** License id. */
	lid: string;
	/** Product id. */
	pid: string;
	/** Plan id. */
	pln: string;
	/** License status at issue time. */
	sts: string;
	/** The identifier the token was issued for. */
	did: string;
	/** Feature entitlements. */
	ftr?: Record<string, unknown>;
	/** Issued at, unix seconds. */
	iat: number;
	/** Token lifetime, unix seconds. This is a check-in interval. */
	exp: number;
	/** When the license itself lapses, unix seconds. Zero means perpetual. */
	vun?: number;
	/** End of the maintenance period, unix seconds. Zero means no limit. */
	upd?: number;
	/** Grace days after `vun`. */
	grc: number;
	/** Per-issuance nonce. */
	nce: string;
	/** Device binding fingerprint: sha256(did + ":" + pid), first 8 bytes. */
	fpr?: string;
}
