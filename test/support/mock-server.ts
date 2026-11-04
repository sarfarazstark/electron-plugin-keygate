/**
 * A stand-in for the Keygate server.
 *
 * It speaks the real protocol: the same envelope, the same endpoint
 * paths, and — crucially — the **same token signing**, so a token this
 * server issues verifies against the real verification code.
 *
 * The signing key pair is generated per test run. Nothing here talks to
 * a network: the client is handed a `fetch` that routes straight here.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeygateTokenPayload } from '../../lib/shared/types.ts';
import type { FetchLike } from '../../lib/main/client.ts';

export interface MockServerOptions {
	/** The license key the server accepts. */
	licenseKey?: string;
	/** The product id the token is issued for. */
	productId?: string;
	/** The plan id the token is issued for. */
	planId?: string;
	/** The identifier the server has an activation for. */
	activatedIdentifier?: string;
	/** How long a token stays usable offline, in seconds. */
	tokenTtlSeconds?: number;
	/** When the license itself lapses, unix seconds. Zero means perpetual. */
	validUntil?: number;
	/** Grace days after `validUntil`. */
	graceDays?: number;
	/** Feature entitlements carried by the token. */
	features?: Record<string, unknown>;
	/** The status recorded in the token. */
	status?: string;
}

export interface MockServer {
	/** The `fetch` to hand to the client. */
	fetch: FetchLike;
	/** The server's public key, hex-encoded. */
	publicKey: string;
	/**
	 * Sign a payload with this server's key.
	 *
	 * Lets a test mint a token that verifies against the server's
	 * published public key without going through an endpoint.
	 */
	sign(payload: KeygateTokenPayload): string;
	/** Every request the server saw. */
	requests: Array<{ path: string; method: string; body: unknown }>;
	/** Change what the server answers next. */
	set(options: Partial<MockServerOptions>): void;
}

const DEFAULT_LICENSE_KEY = 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY';

/**
 * Sign a payload the way the server's `license.Sign` does.
 *
 * The signed bytes are the **base64url payload string**, not the JSON.
 * Getting this wrong produces a token that looks right and fails every
 * verification, which is exactly the bug this mock exists to catch.
 */
export function signToken(payload: KeygateTokenPayload, privateKeyPem: string): string {
	const json = JSON.stringify(payload);
	const encoded = Buffer.from(json, 'utf8').toString('base64url');
	const signature = cryptoSign(null, Buffer.from(encoded, 'utf8'), privateKeyPem);
	return `${encoded}.${signature.toString('base64url')}`;
}

/** Build a mock Keygate server. */
export function createMockServer(options: MockServerOptions = {}): MockServer {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const publicKeyHex = Buffer.from(
		publicKey.export({ type: 'spki', format: 'der' }).subarray(12),
	).toString('hex');

	let state: Required<
		Pick<
			MockServerOptions,
			| 'licenseKey'
			| 'productId'
			| 'planId'
			| 'activatedIdentifier'
			| 'tokenTtlSeconds'
			| 'validUntil'
			| 'graceDays'
			| 'status'
		>
	> & { features: Record<string, unknown> };

	const reset = (): void => {
		state = {
			licenseKey: options.licenseKey ?? DEFAULT_LICENSE_KEY,
			productId: options.productId ?? 'product-under-test',
			planId: options.planId ?? 'plan-under-test',
			activatedIdentifier: options.activatedIdentifier ?? 'kg-testdevice',
			tokenTtlSeconds: options.tokenTtlSeconds ?? 7 * 24 * 60 * 60,
			validUntil: options.validUntil ?? 0,
			graceDays: options.graceDays ?? 0,
			status: options.status ?? 'active',
			features: options.features ?? { premium_support: true, api_calls: '50000' },
		};
	};
	reset();

	const requests: MockServer['requests'] = [];

	/** Build a token for an identifier. */
	const issueToken = (identifier: string, nowSeconds: number): string => {
		const payload: KeygateTokenPayload = {
			lid: 'license-under-test',
			pid: state.productId,
			pln: state.planId,
			sts: state.status,
			did: identifier,
			ftr: state.features,
			iat: nowSeconds,
			exp: nowSeconds + state.tokenTtlSeconds,
			grc: state.graceDays,
			nce: createHash('sha256').update(`${identifier}:${nowSeconds}`).digest('hex').slice(0, 32),
			fpr: createHash('sha256')
				.update(`${identifier}:${state.productId}`)
				.digest()
				.subarray(0, 8)
				.toString('hex'),
		};
		if (state.validUntil > 0) {
			payload.vun = state.validUntil;
		}
		return signToken(payload, privateKeyPem);
	};

	const ok = (data: unknown) => ({ success: true, data });
	const fail = (status: number, code: string, message: string, details?: unknown) => ({
		status,
		body: { success: false, error: { code, message, ...(details ? { details } : {}) } },
	});

	const handle = (
		path: string,
		method: string,
		body: Record<string, unknown> | undefined,
	): { status: number; body: unknown } => {
		const now = Math.floor(Date.now() / 1000);
		const key = typeof body?.license_key === 'string' ? body.license_key : '';
		const identifier = typeof body?.identifier === 'string' ? body.identifier : '';

		if (path === '/license/pubkey' && method === 'GET') {
			return {
				status: 200,
				body: ok({ algorithm: 'ed25519', public_key: publicKeyHex, format: 'hex' }),
			};
		}

		if (key !== state.licenseKey) {
			return fail(404, 'LICENSE_NOT_FOUND', 'license not found');
		}

		if (path === '/license/activate') {
			state.activatedIdentifier = identifier;
			return {
				status: 200,
				body: ok({
					status: 'activated',
					license_id: 'license-under-test',
					token: issueToken(identifier, now),
					meta: { server: 'Keygate', url: 'https://keygate.app' },
				}),
			};
		}

		if (path === '/license/verify') {
			if (identifier !== state.activatedIdentifier) {
				// Oracle hardening: the same answer as an unknown key.
				return fail(404, 'LICENSE_NOT_FOUND', 'license not found');
			}
			return {
				status: 200,
				body: ok({
					status: state.status,
					plan_id: state.planId,
					plan_name: 'Test Plan',
					...(state.validUntil > 0
						? { valid_until: new Date(state.validUntil * 1000).toISOString() }
						: {}),
					features: state.features,
					token: issueToken(identifier, now),
					grace_days: state.graceDays,
					meta: { server: 'Keygate', url: 'https://keygate.app' },
				}),
			};
		}

		if (path === '/license/deactivate') {
			state.activatedIdentifier = '';
			return { status: 200, body: ok({ status: 'deactivated' }) };
		}

		if (path === '/license/entitlements') {
			const features: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(state.features)) {
				features[name] = {
					enabled: value === true || value === 'true',
					value_type: typeof value === 'boolean' ? 'bool' : 'string',
					value: typeof value === 'boolean' ? String(value) : String(value),
				};
			}
			return {
				status: 200,
				body: ok({
					licensed: true,
					status: state.status,
					plan_id: state.planId,
					plan_name: 'Test Plan',
					features,
				}),
			};
		}

		return fail(404, 'NOT_FOUND', 'no such endpoint');
	};

	const fetchImpl: FetchLike = async (input, init) => {
		const url = new URL(input);
		const path = url.pathname.replace(/^\/api\/v1/, '');
		const method = init?.method ?? 'GET';
		let body: Record<string, unknown> | undefined;
		if (typeof init?.body === 'string') {
			try {
				body = JSON.parse(init.body) as Record<string, unknown>;
			} catch {
				body = undefined;
			}
		}
		requests.push({ path, method, body: body ?? null });

		const result = handle(path, method, body);
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			async json() {
				return result.body;
			},
		};
	};

	return {
		fetch: fetchImpl,
		publicKey: publicKeyHex,
		requests,
		sign: (payload) => signToken(payload, privateKeyPem),
		set(next) {
			if (next.licenseKey !== undefined) state.licenseKey = next.licenseKey;
			if (next.productId !== undefined) state.productId = next.productId;
			if (next.planId !== undefined) state.planId = next.planId;
			if (next.activatedIdentifier !== undefined) {
				state.activatedIdentifier = next.activatedIdentifier;
			}
			if (next.tokenTtlSeconds !== undefined) state.tokenTtlSeconds = next.tokenTtlSeconds;
			if (next.validUntil !== undefined) state.validUntil = next.validUntil;
			if (next.graceDays !== undefined) state.graceDays = next.graceDays;
			if (next.status !== undefined) state.status = next.status;
			if (next.features !== undefined) state.features = next.features;
		},
	};
}
