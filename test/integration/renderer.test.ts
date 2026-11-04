import { describe, expect, it } from 'vitest';
import { createKeygateLicensingApi } from '../../lib/renderer/index.ts';
import { createKeygateBridge } from '../../lib/preload/api.ts';
import type { KeygateBridge } from '../../lib/preload/api.ts';
import { KeygateError, isKeygateError } from '../../lib/shared/errors.ts';
import { KEYGATE_CHANNELS } from '../../lib/shared/types.ts';

describe('the preload bridge', () => {
	it('calls the channel the service expects', async () => {
		const calls: Array<{ channel: string; args: unknown[] }> = [];
		const bridge = createKeygateBridge(async (channel, ...args) => {
			calls.push({ channel, args });
			return { ok: true, data: null };
		});

		await bridge.getLicense();
		await bridge.getLicenseKey();
		await bridge.activate({ key: 'KG-ABC' });
		await bridge.verify({ key: 'KG-ABC' });
		await bridge.deactivate({});
		await bridge.getEntitlements({ feature: 'x' });
		await bridge.resetLicense();
		await bridge.resetLicenseKey();

		expect(calls.map((c) => c.channel)).toEqual([
			KEYGATE_CHANNELS.getLicense,
			KEYGATE_CHANNELS.getLicenseKey,
			KEYGATE_CHANNELS.activate,
			KEYGATE_CHANNELS.verify,
			KEYGATE_CHANNELS.deactivate,
			KEYGATE_CHANNELS.getEntitlements,
			KEYGATE_CHANNELS.resetLicense,
			KEYGATE_CHANNELS.resetLicenseKey,
		]);
	});

	it('sends an empty object for the optional channels', async () => {
		const calls: unknown[][] = [];
		const bridge = createKeygateBridge(async (_channel, ...args) => {
			calls.push(args);
			return { ok: true, data: null };
		});

		await bridge.verify();
		await bridge.deactivate();
		await bridge.getEntitlements();

		expect(calls).toEqual([[{}], [{}], [{}]]);
	});

	it('passes the envelope through untouched', async () => {
		const bridge = createKeygateBridge(async () => ({
			ok: false,
			error: { code: 'LICENSE_EXPIRED', detail: 'the license has expired' },
		}));

		const result = await bridge.getLicense();
		expect(result).toEqual({
			ok: false,
			error: { code: 'LICENSE_EXPIRED', detail: 'the license has expired' },
		});
	});
});

describe('the renderer API', () => {
	/** A bridge that answers with whatever the test wants. */
	function bridgeReturning(result: unknown): KeygateBridge {
		return createKeygateBridge(async () => result);
	}

	it('unwraps a successful envelope', async () => {
		const api = createKeygateLicensingApi(
			bridgeReturning({ ok: true, data: { valid: true, licenseId: 'lic-1' } }),
		);

		const license = await api.getLicense();
		expect(license).toEqual({ valid: true, licenseId: 'lic-1' });
	});

	it('throws a KeygateError for a failure envelope', async () => {
		const api = createKeygateLicensingApi(
			bridgeReturning({
				ok: false,
				error: { code: 'LICENSE_EXPIRED', detail: 'the license has expired' },
			}),
		);

		await expect(api.getLicense()).rejects.toThrowError(KeygateError);
		await expect(api.getLicense()).rejects.toMatchObject({
			code: 'LICENSE_EXPIRED',
			detail: 'the license has expired',
		});
	});

	it('reports IPC_UNREACHABLE when there is no handler', async () => {
		const api = createKeygateLicensingApi({
			getLicense: () => Promise.reject(new Error('No handler registered')),
		} as unknown as KeygateBridge);

		await expect(api.getLicense()).rejects.toMatchObject({ code: 'IPC_UNREACHABLE' });
	});

	it('reports NO_KEYGATE_BRIDGE when there is no preload', async () => {
		const api = createKeygateLicensingApi(null);

		await expect(api.getLicense()).rejects.toMatchObject({ code: 'NO_KEYGATE_BRIDGE' });
		await expect(api.activate({ key: 'KG-ABC' })).rejects.toMatchObject({
			code: 'NO_KEYGATE_BRIDGE',
		});
	});

	it('looks the bridge up per call when given a resolver', async () => {
		// The preload normally installs the bridge before this module is
		// evaluated, but a bundler that hoists the evaluation would
		// otherwise see no bridge at all.
		let installed: KeygateBridge | null = null;
		const api = createKeygateLicensingApi(() => installed);

		await expect(api.getLicense()).rejects.toMatchObject({ code: 'NO_KEYGATE_BRIDGE' });

		installed = bridgeReturning({ ok: true, data: { valid: true } });
		await expect(api.getLicense()).resolves.toEqual({ valid: true });
	});

	it('reports an unknown envelope shape', async () => {
		const api = createKeygateLicensingApi(bridgeReturning({ nothing: 'useful' }));

		await expect(api.getLicense()).rejects.toMatchObject({ code: 'unknown' });
	});

	it('reports a failure it cannot describe', async () => {
		const api = createKeygateLicensingApi(bridgeReturning({ ok: false, error: 'oops' }));

		await expect(api.getLicense()).rejects.toMatchObject({ code: 'unknown' });
	});

	it('resolves void for the reset channels', async () => {
		const api = createKeygateLicensingApi(bridgeReturning({ ok: true, data: null }));

		await expect(api.resetLicense()).resolves.toBeUndefined();
		await expect(api.resetLicenseKey()).resolves.toBeUndefined();
		await expect(api.deactivate()).resolves.toBeUndefined();
	});

	it('recognises its own errors', async () => {
		const api = createKeygateLicensingApi(
			bridgeReturning({ ok: false, error: { code: 'NOT_ACTIVATED', detail: 'x' } }),
		);

		try {
			await api.getLicense();
			expect.unreachable();
		} catch (err) {
			if (!isKeygateError(err)) {
				expect.unreachable('the error should have carried the envelope');
			}
			expect(err.code).toBe('NOT_ACTIVATED');
		}
	});
});
