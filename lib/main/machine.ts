/**
 * The device identifier.
 *
 * Keygate identifies a device by a caller-supplied `identifier` string,
 * and binds the signed token to it with
 * `sha256(identifier + ":" + product_id)`. The identifier therefore has
 * two jobs: it must be **stable** across launches (so an activation
 * survives a restart) and **unique** per machine (so two machines do
 * not collide on one activation slot).
 *
 * It is derived from the operating system's own machine id:
 *
 *   Windows — `MachineGuid` from the registry
 *   macOS   — `IOPlatformUUID` from `ioreg`
 *   Linux   — `/etc/machine-id`, then `/var/lib/dbus/machine-id`
 *
 * The raw value is hashed rather than sent: the machine id is a stable
 * secret-ish handle on the host, and the server has no reason to have
 * it in the clear.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The prefix on every identifier this package produces. */
export const IDENTIFIER_PREFIX = 'kg-';

export interface MachineIdentity {
	/** The hashed identifier to send to Keygate. */
	identifier: string;
	/** The raw machine id it came from. Never sent to the server. */
	raw: string;
	/** A human-readable name for the activation, shown in the portal. */
	deviceName: string;
	/** Where the machine id came from, for diagnostics. */
	source: string;
}

/**
 * Read the platform's machine id.
 *
 * Returns an empty string when there is none — an empty identifier must
 * fail loudly at the call site rather than silently becoming `""`.
 */
export async function readRawMachineId(
	platform: NodeJS.Platform = process.platform,
): Promise<{ raw: string; source: string }> {
	if (platform === 'win32') {
		const raw = await readWindowsMachineGuid();
		return { raw, source: 'registry:MachineGuid' };
	}
	if (platform === 'darwin') {
		const raw = await readDarwinPlatformUuid();
		return { raw, source: 'ioreg:IOPlatformUUID' };
	}
	const raw = await readLinuxMachineId();
	return { raw, source: raw.length > 0 ? 'machine-id' : 'none' };
}

/** `reg query` for `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. */
async function readWindowsMachineGuid(): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			'reg',
			['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
			{ windowsHide: true, timeout: 5_000 },
		);
		const match = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
		return match?.[1]?.trim() ?? '';
	} catch {
		return '';
	}
}

/** `IOPlatformUUID` out of `ioreg`. */
async function readDarwinPlatformUuid(): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			'ioreg',
			['-rd1', '-c', 'IOPlatformExpertDevice'],
			{ timeout: 5_000 },
		);
		const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
		return match?.[1]?.trim() ?? '';
	} catch {
		return '';
	}
}

/** `/etc/machine-id`, then the dbus one. */
async function readLinuxMachineId(): Promise<string> {
	for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
		try {
			const contents = await readFile(path, 'utf8');
			const trimmed = contents.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		} catch {
			// Try the next one.
		}
	}
	return '';
}

/**
 * The full identity for this machine.
 *
 * `hostname` is injectable so tests do not depend on the host's name.
 */
export async function buildMachineIdentity(
	options: {
		platform?: NodeJS.Platform;
		hostname?: () => Promise<string>;
		rawMachineId?: () => Promise<{ raw: string; source: string }>;
	} = {},
): Promise<MachineIdentity> {
	const platform = options.platform ?? process.platform;
	const readRaw = options.rawMachineId ?? (() => readRawMachineId(platform));
	const { raw, source } = await readRaw();

	const readHostname = options.hostname ?? (async () => osHostname());
	const hostname = await readHostname();

	if (raw.length === 0) {
		return {
			identifier: '',
			raw: '',
			deviceName: hostname,
			source,
		};
	}

	const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
	return {
		identifier: `${IDENTIFIER_PREFIX}${digest}`,
		raw,
		deviceName: hostname,
		source,
	};
}

/** The host name, or a stand-in when it cannot be read. */
function osHostname(): string {
	try {
		const value = hostname();
		return value.length > 0 ? value : 'unknown-device';
	} catch {
		return 'unknown-device';
	}
}
