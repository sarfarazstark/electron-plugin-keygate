/**
 * The demo's renderer.
 *
 * It imports the renderer entry the way application code does — the same
 * import the README shows — and never touches the license key storage,
 * the token, or the IPC channel names.
 */
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';

const $ = (id) => document.getElementById(id);
const server = new URLSearchParams(location.search).get('server') ?? 'not configured';

$('server').textContent = server;

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function setPill(kind, text) {
	const pill = $('pill');
	pill.dataset.kind = kind;
	pill.textContent = text;
}

function setBusy(busy) {
	for (const button of document.querySelectorAll('button[data-action]')) {
		button.disabled = busy;
	}
}

/* ------------------------------------------------------------------ */
/* The log                                                             */
/* ------------------------------------------------------------------ */

function logEvent(label, ok, detail) {
	const line = document.createElement('div');
	line.className = ok ? 'line ok' : 'line bad';

	const name = document.createElement('span');
	name.className = 'name';
	name.textContent = label;

	const text = document.createElement('span');
	text.className = 'detail';
	text.textContent = detail;

	line.append(name, text);
	$('log').prepend(line);

	while ($('log').childElementCount > 12) {
		$('log').lastElementChild.remove();
	}
}

/* ------------------------------------------------------------------ */
/* Rendering the license                                               */
/* ------------------------------------------------------------------ */

function row(label, value, mono = false) {
	const row = document.createElement('div');
	row.className = 'row';

	const name = document.createElement('span');
	name.className = 'row-label';
	name.textContent = label;

	const text = document.createElement('span');
	text.className = mono ? 'row-value mono' : 'row-value';
	text.textContent = value;

	row.append(name, text);
	return row;
}

function formatTime(value) {
	if (!value) {
		return '—';
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function maskKey(key) {
	if (!key) {
		return '—';
	}
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** The plan name only the server knows; the token carries the plan id. */
let planName = null;

function renderLicense(license, cachedKey) {
	const body = $('license');
	body.replaceChildren();

	if (!license) {
		setPill('idle', 'Unlicensed');
		$('offline').hidden = true;
		body.append(row('License', 'none cached'));
		body.append(row('Cached key', maskKey(cachedKey), true));
		return;
	}

	setPill(license.valid ? 'ok' : 'bad', license.valid ? 'Licensed' : 'Not valid');
	$('offline').hidden = !license.offline;

	body.append(row('Status', license.status));
	body.append(row('Plan', planName ?? license.planName ?? license.planId));
	body.append(row('License id', license.licenseId, true));
	body.append(row('Product id', license.productId, true));
	body.append(row('Device', license.identifier, true));
	body.append(row('Issued', formatTime(license.issuedAt)));
	body.append(row('Valid until', formatTime(license.validUntil)));
	body.append(row('Token expires', formatTime(license.expiresAt)));
	body.append(row('Grace days', String(license.graceDays)));
	// The key as the **vault** holds it — the licence record keeps a copy
	// of its own, which "Forget key" does not touch.
	body.append(row('Cached key', maskKey(cachedKey), true));

	const chips = $('entitlements');
	chips.replaceChildren();
	const names = license.entitlements ?? [];
	if (names.length === 0) {
		const empty = document.createElement('span');
		empty.className = 'chip muted';
		empty.textContent = 'no entitlements';
		chips.append(empty);
	}
	for (const name of names) {
		const chip = document.createElement('span');
		chip.className = 'chip';
		chip.textContent = name;
		chips.append(chip);
	}
}

function renderEntitlements(entitlements) {
	const body = $('features');
	body.replaceChildren();

	if (!entitlements) {
		body.append(row('Entitlements', 'none'));
		return;
	}

	planName = entitlements.planName || null;

	body.append(row('Licensed', String(entitlements.licensed)));
	body.append(row('Status', entitlements.status));
	body.append(row('Plan', entitlements.planName || entitlements.planId));

	const features = entitlements.features ?? {};
	const names = Object.keys(features);
	if (names.length === 0) {
		body.append(row('Features', 'none'));
		return;
	}

	for (const name of names) {
		const feature = features[name];
		const enabled = feature.enabled ? 'on' : 'off';
		let value = feature.value ?? '';
		if (feature.limit !== undefined && feature.limit !== null) {
			value = `${value} (${feature.used ?? 0}/${feature.limit} used)`;
		}
		if (feature.remaining !== undefined && feature.remaining !== null) {
			value = `${value} · ${feature.remaining} left`;
		}
		if (feature.period) {
			value = `${value} · per ${feature.period}`;
		}
		body.append(row(`${enabled} · ${name}`, value || '—'));
	}
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Run one licensing call, report it, and refresh the view.
 *
 * Every failure is a `KeygateError` with a code the app can branch on —
 * that is the whole point of the envelope.
 */
async function run(label, action, describe) {
	setBusy(true);
	try {
		const value = await action();
		logEvent(label, true, describe ? describe(value) : 'ok');
		await refresh();
		return value;
	} catch (err) {
		if (isKeygateError(err)) {
			const retry = err.retryAfterSeconds ? ` · retry in ${err.retryAfterSeconds}s` : '';
			logEvent(label, false, `${err.code}: ${err.detail}${retry}`);
		} else {
			logEvent(label, false, err instanceof Error ? err.message : String(err));
		}
		return null;
	} finally {
		setBusy(false);
	}
}

/** The server's own view of the licence: the plan name and the features. */
async function loadEntitlements() {
	try {
		const entitlements = await keygate.getEntitlements({});
		renderEntitlements(entitlements);
		return entitlements;
	} catch {
		return null;
	}
}

async function refresh() {
	try {
		const [license, cachedKey] = await Promise.all([
			keygate.getLicense(),
			keygate.getLicenseKey(),
		]);
		renderLicense(license, cachedKey);
		return license;
	} catch (err) {
		setPill('bad', 'Error');
		const detail = isKeygateError(err) ? `${err.code}: ${err.detail}` : String(err);
		logEvent('Read state', false, detail);
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('activate').addEventListener('click', () => {
	const key = $('key').value.trim();
	if (!key) {
		logEvent('Activate', false, 'no key was entered');
		return;
	}
	void run(
		'Activate',
		async () => {
			const license = await keygate.activate({ key, label: 'keygate demo' });
			await loadEntitlements();
			return license;
		},
		(license) => `licensed · expires ${formatTime(license?.expiresAt)}`,
	);
});

$('verify').addEventListener('click', () => {
	void run('Verify', () => keygate.verify({}), (license) => `status ${license?.status ?? 'unknown'}`);
});

$('entitlements').addEventListener('click', () => {
	void run('Entitlements', () => loadEntitlements(), (e) => `${Object.keys(e?.features ?? {}).length} features`);
});

$('deactivate').addEventListener('click', () => {
	void run('Deactivate', () => keygate.deactivate({}), () => 'device slot released');
});

$('reset').addEventListener('click', () => {
	void run('Reset state', () => keygate.resetLicense(), () => 'license cleared, key kept');
});

$('forget').addEventListener('click', () => {
	void run('Forget key', () => keygate.resetLicenseKey(), () => 'key cleared');
});

$('reveal').addEventListener('click', () => {
	const field = $('key');
	const hidden = field.type === 'password';
	field.type = hidden ? 'text' : 'password';
	$('reveal').textContent = hidden ? 'Hide' : 'Show';
});

$('refresh').addEventListener('click', () => {
	void refresh();
});

// Start from whatever the machine already has, so the demo is usable
// after a restart without re-entering the key.
void (async () => {
	const cached = await keygate.getLicenseKey().catch(() => null);
	if (cached) {
		$('key').value = cached;
	}
	await refresh();
})();
