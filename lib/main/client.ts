/**
 * The Keygate License API client.
 *
 * Endpoints, from the server's route table:
 *
 *   POST {base}/api/v1/license/activate       register a device, get a token
 *   POST {base}/api/v1/license/verify         check the license and the device
 *   POST {base}/api/v1/license/deactivate     release a device slot
 *   POST {base}/api/v1/license/entitlements   feature entitlements
 *   GET  {base}/api/v1/license/pubkey         the Ed25519 public key
 *
 * The response envelope is the server's standard one:
 *
 *   { "success": true,  "data": { ... } }
 *   { "success": false, "error": { "code": "...", "message": "...", "details": {...} } }
 *
 * There is no request signature and no API key. The license key in the
 * body *is* the credential — the server dropped the API-key gate
 * because a key embedded in a shipped binary is not a secret.
 */
import { randomUUID } from 'node:crypto';
import { KeygateError } from '../shared/errors.ts';
import type { KeygateEntitlements, KeygateFeatureStatus } from '../shared/types.ts';
import type { KeygateConfig } from './config.ts';

/** The server's success envelope. */
interface KeygateEnvelope<T> {
	success: boolean;
	data?: T;
	error?: { code?: string; message?: string; details?: unknown };
}

/**
 * The server's `error.details`, when it is a structured object.
 *
 * It carries the numbers that make a failure explainable: how many
 * devices are in use, how long the lockout lasts. Anything that is not
 * a plain object is dropped rather than passed on as `unknown`.
 */
function readDetails(details: unknown): Record<string, unknown> | undefined {
	if (typeof details !== 'object' || details === null || Array.isArray(details)) {
		return undefined;
	}
	return details as Record<string, unknown>;
}

/** The `Retry-After` header, in seconds. */
function readRetryAfter(response: { headers?: { get(name: string): string | null } }): number | undefined {
	const raw = response.headers?.get('retry-after');
	if (typeof raw !== 'string') {
		return undefined;
	}
	const seconds = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** `details.retry_after`, which the server sends alongside the header. */
function readRetryAfterFromDetails(details: Record<string, unknown> | undefined): number | undefined {
	const value = details?.retry_after;
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.ceil(value);
	}
	if (typeof value === 'string') {
		const seconds = Number.parseInt(value, 10);
		return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
	}
	return undefined;
}

/**
 * The sentence the app shows.
 *
 * The server's own message is kept, because it is the authority on what
 * went wrong. The one exception is a floating licence: the server points
 * at `/license/floating/checkout`, which this package deliberately does
 * not implement, so the message says so rather than sending the app off
 * to an endpoint it cannot call.
 */
function describeFailure(
	code: unknown,
	message: unknown,
	path: string,
	status: number,
): string {
	const text =
		typeof message === 'string' && message.length > 0 ? message : `${path} answered ${status}`;
	if (code === 'FLOATING_LICENSE') {
		return `${text} This package does not implement floating licences: it activates a device and keeps a signed token for it, which is a different licensing model.`;
	}
	return text;
}

export interface KeygateActivateData {
	status: string;
	license_id: string;
	token: string;
	meta?: Record<string, unknown>;
}

export interface KeygateVerifyData {
	status: string;
	plan_id: string;
	plan_name?: string;
	valid_until?: string;
	updates_until?: string;
	features?: Record<string, unknown>;
	token: string;
	grace_days?: number;
	external_customer_id?: string;
	external_workspace_id?: string;
	meta?: Record<string, unknown>;
}

export interface KeygatePublicKeyData {
	algorithm: string;
	public_key: string;
	format: string;
}

/** A `fetch`-shaped function, so tests can substitute one. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	/** Only the `Retry-After` header is read, and only if it is there. */
	headers?: { get(name: string): string | null };
}>;

export interface KeygateClientOptions {
	config: KeygateConfig;
	/** Injected for tests. Defaults to the global `fetch`. */
	fetchImpl?: FetchLike;
	/** Extra headers on every request. */
	defaultHeaders?: Record<string, string>;
}

export class KeygateClient {
	private readonly config: KeygateConfig;
	private readonly fetchImpl: FetchLike;
	private readonly defaultHeaders: Record<string, string>;
	/**
	 * The idempotency key of an activation whose outcome is unknown.
	 *
	 * Keyed by the exact request body, so the key and the body always
	 * agree: the server rejects a reused key that arrives with a
	 * different body, and a key this package generated could never be
	 * paired with a body it did not send.
	 */
	private readonly pendingActivations = new Map<string, string>();

	constructor(options: KeygateClientOptions) {
		this.config = options.config;
		this.fetchImpl =
			options.fetchImpl ?? ((globalThis.fetch as unknown as FetchLike) as FetchLike);
		this.defaultHeaders = options.defaultHeaders ?? {};
		if (typeof this.fetchImpl !== 'function') {
			throw new KeygateError({
				code: 'CONFIG',
				detail: 'no fetch implementation is available in this runtime',
			});
		}
	}

	/** The full URL for an API path. */
	url(path: string): string {
		return `${this.config.apiUrl}/api/v1${path}`;
	}

	/**
	 * Perform one request and unwrap the envelope.
	 *
	 * A failure never throws an opaque error: the server's own code is
	 * carried through verbatim, so the renderer can branch on it.
	 */
	private async request<T>(
		path: string,
		body: unknown,
		method = 'POST',
		extraHeaders: Record<string, string> = {},
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await this.fetchImpl(this.url(path), {
				method,
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					...this.defaultHeaders,
					...extraHeaders,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err) {
			const aborted = controller.signal.aborted;
			if (aborted) {
				throw new KeygateError({
					code: 'REQUEST_ERROR',
					detail: `the request to ${path} timed out after ${this.config.requestTimeoutMs} ms`,
				});
			}
			const detail = err instanceof Error ? err.message : 'the request failed';
			throw new KeygateError({ code: 'REQUEST_ERROR', detail: `the request to ${path} failed: ${detail}` });
		} finally {
			clearTimeout(timer);
		}

		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			throw new KeygateError({
				code: 'BAD_RESPONSE',
				detail: `${path} answered with a body that is not JSON`,
			});
		}

		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new KeygateError({
				code: 'BAD_RESPONSE',
				detail: `${path} answered with a body that is not an object`,
			});
		}

		const envelope = parsed as KeygateEnvelope<T>;
		if (envelope.success === true && envelope.data !== undefined) {
			return envelope.data;
		}

		if (envelope.success === false || envelope.error !== undefined) {
			const code = envelope.error?.code;
			const message = envelope.error?.message;
			const details = readDetails(envelope.error?.details);
			const retryAfterSeconds =
				readRetryAfter(response) ?? readRetryAfterFromDetails(details);

			throw new KeygateError({
				// The server's code is the useful part; it says whether the
				// license is unknown, expired, suspended, or the device
				// already holds a different key.
				code: typeof code === 'string' && code.length > 0 ? code : 'HTTP_ERROR',
				detail: describeFailure(code, message, path, response.status),
				...(details !== undefined ? { details } : {}),
				...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
			});
		}

		throw new KeygateError({
			code: 'BAD_RESPONSE',
			detail: `${path} answered with an envelope this package does not understand`,
		});
	}

	/** Fetch the Ed25519 public key the server signs tokens with. */
	async fetchPublicKey(): Promise<KeygatePublicKeyData> {
		const data = await this.request<KeygatePublicKeyData>('/license/pubkey', undefined, 'GET');
		if (typeof data?.public_key !== 'string' || data.public_key.length === 0) {
			throw new KeygateError({
				code: 'BAD_RESPONSE',
				detail: 'the public key endpoint answered without a key',
			});
		}
		return data;
	}

	/**
	 * Register this device against a license and get a signed token.
	 *
	 * The request carries an `Idempotency-Key`, so a retry of the same
	 * activation is answered from the server's cache instead of running
	 * the handler again.
	 *
	 * The key is reused only while the outcome is *unknown* — a timeout
	 * or a dropped connection, where the server may have activated the
	 * device before the answer was lost. As soon as the server answers,
	 * the key is dropped: the server caches 4xx as well as 2xx, so a key
	 * that outlived a refusal would keep replaying that refusal, and a
	 * later genuine attempt would never reach the handler.
	 */
	async activate(input: {
		key: string;
		identifier: string;
		label?: string;
		identifierType?: 'device' | 'user';
	}): Promise<KeygateActivateData> {
		const body: Record<string, unknown> = {
			license_key: input.key,
			identifier: input.identifier,
			identifier_type: input.identifierType ?? 'device',
		};
		if (input.label !== undefined && input.label.length > 0) {
			body.label = input.label;
		}

		// The body is the scope of the key: the server hashes the body it
		// receives, so a key and a body that always agree can never be
		// reported as a conflict.
		const bodyText = JSON.stringify(body);
		const idempotencyKey = this.pendingActivations.get(bodyText) ?? randomUUID();

		try {
			const data = await this.request<KeygateActivateData>('/license/activate', body, 'POST', {
				'Idempotency-Key': idempotencyKey,
			});
			this.pendingActivations.delete(bodyText);
			if (typeof data?.token !== 'string' || data.token.length === 0) {
				throw new KeygateError({
					code: 'BAD_RESPONSE',
					detail: 'the activate endpoint answered without a token',
				});
			}
			return data;
		} catch (err) {
			// A request that never got an answer leaves the outcome open.
			// Keep the key, so the next attempt is answered from the
			// cache rather than activating a second time.
			if (err instanceof KeygateError && err.code === 'REQUEST_ERROR') {
				this.pendingActivations.set(bodyText, idempotencyKey);
			} else {
				this.pendingActivations.delete(bodyText);
			}
			throw err;
		}
	}

	/** Check the license and this device's activation. */
	async verify(input: { key: string; identifier: string }): Promise<KeygateVerifyData> {
		const data = await this.request<KeygateVerifyData>('/license/verify', {
			license_key: input.key,
			identifier: input.identifier,
		});
		if (typeof data?.token !== 'string' || data.token.length === 0) {
			throw new KeygateError({
				code: 'BAD_RESPONSE',
				detail: 'the verify endpoint answered without a token',
			});
		}
		return data;
	}

	/** Release this device's activation slot. */
	async deactivate(input: { key: string; identifier: string }): Promise<void> {
		await this.request<{ status?: string }>('/license/deactivate', {
			license_key: input.key,
			identifier: input.identifier,
		});
	}

	/** The license's feature entitlements, with quota usage. */
	async entitlements(input: { key: string; feature?: string }): Promise<KeygateEntitlements> {
		const body: Record<string, unknown> = { license_key: input.key };
		if (input.feature !== undefined && input.feature.length > 0) {
			body.feature = input.feature;
		}
		const data = await this.request<{
			licensed?: boolean;
			status?: string;
			plan_id?: string;
			plan_name?: string;
			features?: Record<string, KeygateFeatureStatus>;
		}>('/license/entitlements', body);

		const features: Record<string, KeygateFeatureStatus> = {};
		const rawFeatures = data?.features;
		if (rawFeatures && typeof rawFeatures === 'object') {
			for (const [name, value] of Object.entries(rawFeatures)) {
				features[name] = normalizeFeatureStatus(value);
			}
		}

		return {
			licensed: data?.licensed === true,
			status: data?.status ?? '',
			planId: data?.plan_id ?? '',
			planName: data?.plan_name ?? '',
			features,
		};
	}
}

/**
 * Normalise one entitlement.
 *
 * The server sends `enabled`, `value_type`, `value` and, for quotas,
 * `used`/`limit`/`remaining`/`period`/`resets_at`. A malformed entry
 * becomes a disabled feature rather than an exception — one bad row
 * should not cost the caller every other entitlement.
 */
function normalizeFeatureStatus(value: unknown): KeygateFeatureStatus {
	if (typeof value !== 'object' || value === null) {
		return { enabled: false, valueType: '', value: '' };
	}
	const raw = value as Record<string, unknown>;
	const status: KeygateFeatureStatus = {
		enabled: raw.enabled === true,
		valueType: typeof raw.value_type === 'string' ? raw.value_type : '',
		value: typeof raw.value === 'string' ? raw.value : '',
	};
	if (typeof raw.used === 'number') {
		status.used = raw.used;
	}
	if (typeof raw.limit === 'number') {
		status.limit = raw.limit;
	}
	if (typeof raw.remaining === 'number') {
		status.remaining = raw.remaining;
	}
	if (typeof raw.period === 'string') {
		status.period = raw.period;
	}
	if (typeof raw.resets_at === 'string') {
		status.resetsAt = raw.resets_at;
	}
	return status;
}
