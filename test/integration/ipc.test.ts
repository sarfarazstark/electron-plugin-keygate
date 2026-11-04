import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeygateClient } from '../../lib/main/client.ts';
import { resolveConfig } from '../../lib/main/config.ts';
import { makeWindowTrustChecker, registerKeygateIpc } from '../../lib/main/ipc.ts';
import type { IpcMainLike } from '../../lib/main/ipc.ts';
import { createSilentLogger } from '../../lib/main/logger.ts';
import { LicensingService } from '../../lib/main/service.ts';
import { buildSafeStorageCodec, KeygateStorage } from '../../lib/main/storage.ts';
import { KEYGATE_CHANNELS } from '../../lib/shared/types.ts';
import type { IpcResult } from '../../lib/shared/types.ts';
import { createFakeSafeStorage } from '../support/fake-storage.ts';
import { createMockServer } from '../support/mock-server.ts';
import type { MockServer } from '../support/mock-server.ts';

const IDENTIFIER = 'kg-testdevice';
const LICENSE_KEY = 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY';
const TRUSTED_ID = 42;
const UNTRUSTED_ID = 99;

/** A stand-in for Electron's `ipcMain`. */
class FakeIpcMain implements IpcMainLike {
	readonly handlers = new Map<
		string,
		(event: unknown, ...args: unknown[]) => unknown
	>();

	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
		this.handlers.set(channel, listener);
	}

	/** Call a channel as Electron would. */
	async call<T>(channel: string, event: unknown, ...args: unknown[]): Promise<IpcResult<T>> {
		const handler = this.handlers.get(channel);
		if (!handler) {
			throw new Error(`no handler for ${channel}`);
		}
		return (await handler(event, ...args)) as IpcResult<T>;
	}
}

/** Build an IPC event for a window. */
function makeEvent(id: number, mainFrame = true): unknown {
	const frame = { url: 'https://app.test/index.html' };
	return {
		sender: {
			id,
			mainFrame: mainFrame ? frame : { url: 'https://embed.test/frame.html' },
		},
		senderFrame: mainFrame ? frame : { url: 'https://embed.test/frame.html' },
	};
}

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'keygate-ipc-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/** Wire the whole stack together. */
function buildIpc(server: MockServer | null): {
	ipc: FakeIpcMain;
	service: LicensingService | null;
} {
	const config = resolveConfig({ apiUrl: 'https://keygate.test' });
	const storage = new KeygateStorage({
		directory,
		codec: buildSafeStorageCodec(createFakeSafeStorage()),
	});
	const service = new LicensingService({
		config,
		client: new KeygateClient({
			config,
			fetchImpl: server?.fetch ?? (() => Promise.reject(new Error('offline')) as never),
		}),
		storage,
		log: createSilentLogger(),
		identity: async () => ({
			identifier: IDENTIFIER,
			raw: 'raw',
			deviceName: 'Test Device',
			source: 'test',
		}),
	});

	const ipc = new FakeIpcMain();
	registerKeygateIpc(ipc, () => service, makeWindowTrustChecker(() => [TRUSTED_ID]));
	return { ipc, service };
}

describe('the IPC contract', () => {
	it('registers all eight channels', () => {
		const { ipc } = buildIpc(createMockServer());
		expect([...ipc.handlers.keys()].sort()).toEqual(
			[
				KEYGATE_CHANNELS.activate,
				KEYGATE_CHANNELS.deactivate,
				KEYGATE_CHANNELS.getEntitlements,
				KEYGATE_CHANNELS.getLicense,
				KEYGATE_CHANNELS.getLicenseKey,
				KEYGATE_CHANNELS.resetLicense,
				KEYGATE_CHANNELS.resetLicenseKey,
				KEYGATE_CHANNELS.verify,
			].sort(),
		);
	});

	it('activates over IPC and returns the license in an envelope', async () => {
		const { ipc } = buildIpc(createMockServer());

		const result = await ipc.call<{ valid: boolean }>(
			KEYGATE_CHANNELS.activate,
			makeEvent(TRUSTED_ID),
			{ key: LICENSE_KEY },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.valid).toBe(true);
		}
	});

	it('never throws across the boundary', async () => {
		const { ipc } = buildIpc(createMockServer());

		const result = await ipc.call(
			KEYGATE_CHANNELS.verify,
			makeEvent(TRUSTED_ID),
			{ key: 'KG-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG' },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(typeof result.error.code).toBe('string');
			expect(typeof result.error.detail).toBe('string');
		}
	});
});

describe('sender verification', () => {
	it('refuses an untrusted window', async () => {
		const { ipc } = buildIpc(createMockServer());

		const result = await ipc.call(
			KEYGATE_CHANNELS.getLicense,
			makeEvent(UNTRUSTED_ID),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('UNTRUSTED_SENDER');
		}
	});

	it('refuses a frame that is not the main frame', async () => {
		const { ipc } = buildIpc(createMockServer());

		const result = await ipc.call(
			KEYGATE_CHANNELS.getLicense,
			makeEvent(TRUSTED_ID, false),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('UNTRUSTED_SENDER');
		}
	});

	it('re-reads the trust list per request', async () => {
		const server = createMockServer();
		const config = resolveConfig({ apiUrl: 'https://keygate.test' });
		const storage = new KeygateStorage({
			directory,
			codec: buildSafeStorageCodec(createFakeSafeStorage()),
		});
		const service = new LicensingService({
			config,
			client: new KeygateClient({ config, fetchImpl: server.fetch }),
			storage,
			log: createSilentLogger(),
		});

		let trusted = [TRUSTED_ID];
		const ipc = new FakeIpcMain();
		registerKeygateIpc(ipc, () => service, makeWindowTrustChecker(() => trusted));

		const allowed = await ipc.call(KEYGATE_CHANNELS.getLicense, makeEvent(TRUSTED_ID));
		expect(allowed.ok).toBe(true);

		// The window closes; the list shrinks. No unregistering needed.
		trusted = [];
		const refused = await ipc.call(KEYGATE_CHANNELS.getLicense, makeEvent(TRUSTED_ID));
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.error.code).toBe('UNTRUSTED_SENDER');
		}
	});

	it('refuses an event with no sender', () => {
		const checker = makeWindowTrustChecker(() => [TRUSTED_ID]);
		expect(checker(null)).toBe(false);
		expect(checker(undefined)).toBe(false);
		expect(checker({})).toBe(false);
		expect(checker({ sender: {} })).toBe(false);
	});
});

describe('argument validation over IPC', () => {
	it('rejects a malformed activate payload without touching the server', async () => {
		const server = createMockServer();
		const { ipc } = buildIpc(server);

		const result = await ipc.call(KEYGATE_CHANNELS.activate, makeEvent(TRUSTED_ID), {
			key: 12345,
		});

		expect(result.ok).toBe(false);
		expect(server.requests).toHaveLength(0);
	});

	it('rejects extra arguments on a channel that takes none', async () => {
		const { ipc } = buildIpc(createMockServer());

		const result = await ipc.call(
			KEYGATE_CHANNELS.resetLicense,
			makeEvent(TRUSTED_ID),
			'surprise',
		);

		expect(result.ok).toBe(false);
	});

	it('reports LICENSING_DISABLED when there is no service', async () => {
		const ipc = new FakeIpcMain();
		registerKeygateIpc(ipc, () => null, makeWindowTrustChecker(() => [TRUSTED_ID]));

		const result = await ipc.call(KEYGATE_CHANNELS.getLicense, makeEvent(TRUSTED_ID));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('LICENSING_DISABLED');
		}
	});

	it('carries the details and the retry delay across the boundary', async () => {
		const server = createMockServer();
		const { ipc } = buildIpc(server);

		// The server's own numbers, on a failure the app has to explain.
		server.failWith({
			status: 409,
			code: 'ACTIVATION_LIMIT',
			message: 'maximum activations reached',
			details: { max: 3, current: 3 },
			retryAfterSeconds: 60,
		});

		const result = await ipc.call(KEYGATE_CHANNELS.activate, makeEvent(TRUSTED_ID), {
			key: 'KG-TESTKEY-TESTKEY-TESTKEY-TESTKEY',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('ACTIVATION_LIMIT');
			expect(result.error.details).toEqual({ max: 3, current: 3 });
			expect(result.error.retryAfterSeconds).toBe(60);
		}
	});
});
