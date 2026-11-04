/**
 * The client's contract with the Keygate server.
 *
 * These are the parts of the protocol that are easy to get subtly
 * wrong, and hard to notice when they are:
 *
 *   - the server puts the actionable numbers in `error.details`, and a
 *     client that drops them cannot tell the user how much room is left
 *   - a 429 carries `Retry-After`, and a client that ignores it retries
 *     straight into the lockout
 *   - `activate` is idempotent only when the client sends a key, and the
 *     key may only be reused while the outcome is unknown
 */
import { describe, expect, it } from 'vitest';
import { KeygateClient } from '../../lib/main/client.ts';
import type { FetchLike } from '../../lib/main/client.ts';
import { resolveConfig } from '../../lib/main/config.ts';
import { KeygateError } from '../../lib/shared/errors.ts';

const KEY = 'KG-CLIENTKEY-CLIENTKEY-CLIENTKEY';
const IDENTIFIER = 'kg-client-test-device';

/** One recorded request. */
interface Recorded {
	path: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

interface Reply {
	status?: number;
	body: unknown;
	headers?: Record<string, string>;
}

/**
 * A `fetch` double that answers from a script and records what it was
 * asked for.
 */
function scriptedFetch(replies: Reply[]): { fetch: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let index = 0;

	const fetch: FetchLike = async (input, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			path: input,
			method: init?.method ?? 'GET',
			headers,
			body: init?.body,
		});

		const reply = replies[Math.min(index, replies.length - 1)];
		index += 1;
		if (reply === undefined) {
			throw new Error('the scripted fetch ran out of replies');
		}

		return {
			ok: (reply.status ?? 200) < 400,
			status: reply.status ?? 200,
			json: async () => reply.body,
			headers: {
				get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null,
			},
		};
	};

	return { fetch, calls };
}

/** A `fetch` that never answers, as a dropped connection would. */
function deadFetch(): FetchLike {
	return async () => {
		throw new Error('the socket was closed');
	};
}

function client(fetchImpl: FetchLike): KeygateClient {
	return new KeygateClient({
		config: resolveConfig({ apiUrl: 'https://keygate.test' }),
		fetchImpl,
	});
}

/** A successful activate answer. */
function activateOk(): Reply {
	return {
		body: {
			success: true,
			data: { status: 'activated', license_id: 'lic-1', token: 'a.b' },
		},
	};
}

/** The idempotency key of a recorded request, which must exist. */
function keyOf(headers: Record<string, string> | undefined): string {
	const value = headers?.['Idempotency-Key'];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error('the request carried no Idempotency-Key');
	}
	return value;
}

/** A recorded value at an index, which must exist. */
function nth(values: string[], index: number): string {
	const value = values[index];
	if (typeof value !== 'string') {
		throw new Error(`no value at index ${index}`);
	}
	return value;
}

/** The error a call failed with. */
async function failure(promise: Promise<unknown>): Promise<KeygateError> {
	try {
		await promise;
	} catch (err) {
		return err as KeygateError;
	}
	throw new Error('the call was expected to fail');
}

describe('the details the server sends with a failure', () => {
	it('keeps the numbers that make the failure explainable', async () => {
		const { fetch } = scriptedFetch([
			{
				status: 409,
				body: {
					success: false,
					error: {
						code: 'ACTIVATION_LIMIT',
						message: 'maximum activations reached',
						details: { max: 3, current: 3 },
					},
				},
			},
		]);

		const error = await failure(client(fetch).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error).toBeInstanceOf(KeygateError);
		expect(error.code).toBe('ACTIVATION_LIMIT');
		expect(error.details).toEqual({ max: 3, current: 3 });
	});

	it('reads the Retry-After header a lockout sends', async () => {
		const { fetch } = scriptedFetch([
			{
				status: 429,
				headers: { 'retry-after': '120' },
				body: {
					success: false,
					error: {
						code: 'LOCKED_OUT',
						message: 'too many failed attempts',
						details: { retry_after: 120 },
					},
				},
			},
		]);

		const error = await failure(client(fetch).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error.retryAfterSeconds).toBe(120);
	});

	it('falls back to the details when the header is missing', async () => {
		const { fetch } = scriptedFetch([
			{
				status: 429,
				body: {
					success: false,
					error: {
						code: 'LOCKED_OUT',
						message: 'too many failed attempts',
						details: { retry_after: 45 },
					},
				},
			},
		]);

		const error = await failure(client(fetch).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error.retryAfterSeconds).toBe(45);
	});

	it('ignores details that are not an object', async () => {
		const { fetch } = scriptedFetch([
			{
				status: 400,
				body: {
					success: false,
					error: { code: 'BAD_REQUEST', message: 'nope', details: 'just a string' },
				},
			},
		]);

		const error = await failure(client(fetch).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error.details).toBeUndefined();
		expect(error.retryAfterSeconds).toBeUndefined();
	});

	it('leaves the details out when the server sends none', async () => {
		const { fetch } = scriptedFetch([
			{
				status: 404,
				body: {
					success: false,
					error: { code: 'LICENSE_NOT_FOUND', message: 'license not found' },
				},
			},
		]);

		const error = await failure(client(fetch).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error.code).toBe('LICENSE_NOT_FOUND');
		expect(error.details).toBeUndefined();
	});
});

describe('a floating licence', () => {
	it('says that this package cannot activate one', async () => {
		const { fetch } = scriptedFetch([
			{
				status: 409,
				body: {
					success: false,
					error: {
						code: 'FLOATING_LICENSE',
						message:
							'this license is floating: check out a seat with /license/floating/checkout instead',
					},
				},
			},
		]);

		const error = await failure(client(fetch).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error.code).toBe('FLOATING_LICENSE');
		// The server's own wording is kept...
		expect(error.detail).toContain('/license/floating/checkout');
		// ...but the app is not left looking for an endpoint it cannot call.
		expect(error.detail).toContain('does not implement floating licences');
	});
});

describe('the idempotency key on activate', () => {
	it('sends one', async () => {
		const { fetch, calls } = scriptedFetch([activateOk()]);

		await client(fetch).activate({ key: KEY, identifier: IDENTIFIER });

		expect(calls).toHaveLength(1);
		expect(keyOf(calls[0]?.headers)).toBeTruthy();
	});

	it('reuses the key when the previous attempt never got an answer', async () => {
		// The first attempt is lost; the second carries the same key, so
		// the server replays the first activation instead of doing it
		// again.
		const seen: string[] = [];
		let attempt = 0;

		const fetch: FetchLike = async (_input, init) => {
			attempt += 1;
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push(keyOf(headers));
			if (attempt === 1) {
				throw new Error('the socket was closed');
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					success: true,
					data: { status: 'activated', license_id: 'lic-1', token: 'a.b' },
				}),
				headers: { get: () => null },
			};
		};

		const instance = client(fetch);
		await expect(instance.activate({ key: KEY, identifier: IDENTIFIER })).rejects.toThrowError();
		await instance.activate({ key: KEY, identifier: IDENTIFIER });

		expect(seen).toHaveLength(2);
		expect(nth(seen, 1)).toBe(nth(seen, 0));
	});

	it('drops the key once the server has answered', async () => {
		const seen: string[] = [];

		const fetch: FetchLike = async (_input, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push(keyOf(headers));
			return {
				ok: true,
				status: 200,
				json: async () => ({
					success: true,
					data: { status: 'activated', license_id: 'lic-1', token: 'a.b' },
				}),
				headers: { get: () => null },
			};
		};

		const instance = client(fetch);
		await instance.activate({ key: KEY, identifier: IDENTIFIER });
		await instance.activate({ key: KEY, identifier: IDENTIFIER });

		// Two answered calls are two requests, not one replay. The server
		// caches 4xx as well as 2xx, so a key that outlived an answer
		// would keep replaying that answer.
		expect(nth(seen, 1)).not.toBe(nth(seen, 0));
	});

	it('drops the key when the server refuses', async () => {
		const seen: string[] = [];

		const fetch: FetchLike = async (_input, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push(keyOf(headers));
			return {
				ok: false,
				status: 409,
				json: async () => ({
					success: false,
					error: {
						code: 'ACTIVATION_LIMIT',
						message: 'maximum activations reached',
						details: { max: 3, current: 3 },
					},
				}),
				headers: { get: () => null },
			};
		};

		const instance = client(fetch);
		await expect(instance.activate({ key: KEY, identifier: IDENTIFIER })).rejects.toThrowError();
		await expect(instance.activate({ key: KEY, identifier: IDENTIFIER })).rejects.toThrowError();

		// A refusal is an answer, so the next attempt must not be
		// answered from the cache.
		expect(nth(seen, 1)).not.toBe(nth(seen, 0));
	});

	it('uses a different key for a different device', async () => {
		const { fetch, calls } = scriptedFetch([activateOk()]);
		const instance = client(fetch);

		await instance.activate({ key: KEY, identifier: IDENTIFIER });
		await instance.activate({ key: KEY, identifier: 'kg-another-device' });

		expect(keyOf(calls[0]?.headers)).not.toBe(keyOf(calls[1]?.headers));
	});

	it('never sends the license key in the key itself', async () => {
		const { fetch, calls } = scriptedFetch([activateOk()]);

		await client(fetch).activate({ key: KEY, identifier: IDENTIFIER });

		expect(keyOf(calls[0]?.headers)).not.toContain(KEY);
		expect(keyOf(calls[0]?.headers).length).toBeLessThanOrEqual(256);
	});
});

describe('a request that never reached the server', () => {
	it('is reported as a request error, not as a licence problem', async () => {
		const error = await failure(client(deadFetch()).activate({ key: KEY, identifier: IDENTIFIER }));

		expect(error.code).toBe('REQUEST_ERROR');
	});
});
