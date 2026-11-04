/**
 * Configuration.
 *
 * Everything licensing-critical is explicit. Nothing here has a default
 * that quietly points at a live server: `configFromEnv()` returns `null`
 * when `KEYGATE_API_URL` is unset, and that is what turns licensing off.
 */
import { KeygateError } from '../shared/errors.ts';

export interface KeygateConfigInput {
	/**
	 * Base URL of the Keygate server, e.g. `https://keygate.app`.
	 * The `/api/v1` prefix is added by the client.
	 */
	apiUrl?: string;
	/**
	 * The Ed25519 public key, hex-encoded (64 characters), that signs the
	 * server's tokens.
	 *
	 * Leave it unset and the client fetches it once from
	 * `GET /api/v1/license/pubkey` and caches it. Pin it instead and the
	 * package never trusts a key the server hands out.
	 */
	publicKey?: string;
	/**
	 * Override the device identifier. By default it is derived from the
	 * machine's own id, so it survives a reinstall and is the same on
	 * every launch.
	 */
	identifier?: string;
	/** Per-request timeout in milliseconds. */
	requestTimeoutMs?: number;
	/**
	 * How far the local clock may disagree with the server's before a
	 * token is rejected. Guards against a rolled-back clock keeping a
	 * revoked license alive forever.
	 */
	maxClockDriftSeconds?: number;
}

export interface KeygateConfig {
	/** Normalised base URL, no trailing slash. */
	apiUrl: string;
	/** Pinned public key, or `null` to fetch and cache one. */
	publicKey: string | null;
	/** Pinned device identifier, or `null` to derive one per machine. */
	identifier: string | null;
	requestTimeoutMs: number;
	maxClockDriftSeconds: number;
}

export const DEFAULT_API_URL = 'https://keygate.app';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CLOCK_DRIFT_SECONDS = 300;
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

const HEX_PUBLIC_KEY = /^[0-9a-fA-F]{64}$/;

/** Whether a string is a 32-byte hex Ed25519 public key. */
export function isHexPublicKey(value: string): boolean {
	return HEX_PUBLIC_KEY.test(value);
}

function clampTimeout(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_REQUEST_TIMEOUT_MS;
	}
	const truncated = Math.trunc(value);
	if (truncated < MIN_REQUEST_TIMEOUT_MS) {
		return MIN_REQUEST_TIMEOUT_MS;
	}
	if (truncated > MAX_REQUEST_TIMEOUT_MS) {
		return MAX_REQUEST_TIMEOUT_MS;
	}
	return truncated;
}

function clampClockDrift(value: number): number {
	if (!Number.isFinite(value) || value < 0) {
		return DEFAULT_MAX_CLOCK_DRIFT_SECONDS;
	}
	return Math.trunc(value);
}

/** Normalise a base URL: absolute, https or http, no trailing slash. */
export function normalizeApiUrl(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new KeygateError({ code: 'CONFIG', detail: 'the API URL must not be empty' });
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new KeygateError({ code: 'CONFIG', detail: `the API URL "${trimmed}" is not a valid URL` });
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new KeygateError({
			code: 'CONFIG',
			detail: `the API URL must use http or https, got "${parsed.protocol}"`,
		});
	}
	const path = parsed.pathname.replace(/\/+$/, '');
	return `${parsed.origin}${path}`;
}

/**
 * Turn a user-supplied config into the resolved one.
 *
 * Throws `CONFIG` rather than guessing: a bad public key or a nonsense
 * URL is a build mistake, and failing loudly at startup beats a license
 * check that mysteriously never works.
 */
export function resolveConfig(input: KeygateConfigInput): KeygateConfig {
	const apiUrl = normalizeApiUrl(input.apiUrl ?? DEFAULT_API_URL);

	let publicKey: string | null = null;
	if (input.publicKey !== undefined && input.publicKey !== null && input.publicKey.trim() !== '') {
		const candidate = input.publicKey.trim();
		if (!isHexPublicKey(candidate)) {
			throw new KeygateError({
				code: 'CONFIG',
				detail: 'the public key must be 64 hex characters (a 32-byte Ed25519 key)',
			});
		}
		publicKey = candidate.toLowerCase();
	}

	let identifier: string | null = null;
	if (input.identifier !== undefined && input.identifier !== null && input.identifier.trim() !== '') {
		const candidate = input.identifier.trim();
		if (candidate.length > 256) {
			throw new KeygateError({
				code: 'CONFIG',
				detail: 'the identifier must be at most 256 characters',
			});
		}
		identifier = candidate;
	}

	return {
		apiUrl,
		publicKey,
		identifier,
		requestTimeoutMs: clampTimeout(input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
		maxClockDriftSeconds: clampClockDrift(
			input.maxClockDriftSeconds ?? DEFAULT_MAX_CLOCK_DRIFT_SECONDS,
		),
	};
}

/**
 * Read the config from the environment.
 *
 * Returns `null` when `KEYGATE_API_URL` is unset — that is the switch
 * that turns licensing off in a build that does not use it.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): KeygateConfigInput | null {
	const apiUrl = env.KEYGATE_API_URL?.trim();
	if (!apiUrl) {
		return null;
	}
	const input: KeygateConfigInput = { apiUrl };
	const publicKey = env.KEYGATE_PUBLIC_KEY?.trim();
	if (publicKey) {
		input.publicKey = publicKey;
	}
	const identifier = env.KEYGATE_IDENTIFIER?.trim();
	if (identifier) {
		input.identifier = identifier;
	}
	const timeout = Number(env.KEYGATE_REQUEST_TIMEOUT_MS);
	if (Number.isFinite(timeout)) {
		input.requestTimeoutMs = timeout;
	}
	const drift = Number(env.KEYGATE_MAX_CLOCK_DRIFT_SECONDS);
	if (Number.isFinite(drift)) {
		input.maxClockDriftSeconds = drift;
	}
	return input;
}

/**
 * Fluent config, the shape the Rust builder had.
 *
 * `new(apiUrl)` starts from a hosted Keygate server; `withPublicKey`
 * starts from a pinned key. Both return a builder.
 */
export class KeygateBuilder {
	private readonly input: KeygateConfigInput;

	private constructor(input: KeygateConfigInput) {
		this.input = input;
	}

	/** Start from a Keygate server URL. */
	static new(apiUrl: string = DEFAULT_API_URL): KeygateBuilder {
		return new KeygateBuilder({ apiUrl });
	}

	/** Start from a pinned Ed25519 public key, hex-encoded. */
	static withPublicKey(publicKey: string): KeygateBuilder {
		return new KeygateBuilder({ publicKey });
	}

	/** Set the base URL of the Keygate server. */
	apiUrl(url: string): KeygateBuilder {
		this.input.apiUrl = url;
		return this;
	}

	/** Pin the Ed25519 public key, hex-encoded. */
	publicKey(key: string): KeygateBuilder {
		this.input.publicKey = key;
		return this;
	}

	/** Pin the device identifier instead of deriving one. */
	identifier(identifier: string): KeygateBuilder {
		this.input.identifier = identifier;
		return this;
	}

	/** Per-request timeout in milliseconds. */
	requestTimeoutMs(ms: number): KeygateBuilder {
		this.input.requestTimeoutMs = ms;
		return this;
	}

	/** Tolerated clock disagreement, in seconds. */
	maxClockDriftSeconds(seconds: number): KeygateBuilder {
		this.input.maxClockDriftSeconds = seconds;
		return this;
	}

	/** The resolved input. Throws `CONFIG` when it cannot be used. */
	build(): KeygateConfigInput {
		// Validate now so the mistake surfaces at build time, not on the
		// first licensing call three weeks later.
		resolveConfig(this.input);
		return { ...this.input };
	}
}
