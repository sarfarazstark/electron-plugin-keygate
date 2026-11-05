# Getting started

From an empty app to a feature that unlocks only for a licensed customer.

- [Install](#install)
- [Configure](#configure)
- [Register in the main process](#register-in-the-main-process)
- [Add the preload](#add-the-preload)
- [Use it in the renderer](#use-it-in-the-renderer)
- [Gate a feature](#gate-a-feature)
- [Handle the failures](#handle-the-failures)
- [Check that it works](#check-that-it-works)
- [When something goes wrong](#when-something-goes-wrong)

---

## Install

```sh
npm install electron-plugin-keygate
```

`electron >= 30` is a peer dependency, so your app keeps its own Electron.
The package itself has **no runtime dependencies** — `node:crypto` and
`node:fs` are enough.

## Configure

Everything can come from the environment:

| Variable | Meaning |
| --- | --- |
| `KEYGATE_API_URL` | The Keygate server. **Unset means licensing is off.** |
| `KEYGATE_PUBLIC_KEY` | The Ed25519 public key, hex. Pinning it is optional but stronger. |
| `KEYGATE_IDENTIFIER` | Override the device identifier. |
| `KEYGATE_REQUEST_TIMEOUT_MS` | Per-request timeout. Default 30 000. |
| `KEYGATE_MAX_CLOCK_DRIFT_SECONDS` | Tolerated clock disagreement. Default 300. |

Or configure it in code, which is better when the server address is known at
build time or the app has its own settings screen:

```ts
import { KeygateBuilder } from 'electron-plugin-keygate';

const config = KeygateBuilder.new('https://keygate.app')
  .publicKey('a'.repeat(64))
  .build();
```

`build()` validates and throws on a bad value, so a mistake surfaces at
startup rather than on the first customer.

> **The gate.** `KEYGATE_API_URL` unset, and no `config` passed, means
> licensing is **off**: `registerKeygate` returns `null` and every channel
> answers `LICENSING_DISABLED`. That is deliberate — a build without a
> server is a free build, not a broken one. Pass `config: null` to say the
> same thing in code.

## Register in the main process

One call. It registers the eight channels, probes the OS vault, and restores
the cached licence if there is one.

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerKeygate } from 'electron-plugin-keygate';

const windows = new Set<BrowserWindow>();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    webPreferences: {
      preload: keygateSandboxedPreloadPath(),
      sandbox: true,
      contextIsolation: true,
    },
  });
  windows.add(window);

  await registerKeygate({
    app,
    ipc: ipcMain,
    // Re-read per request: a closed window loses access by itself.
    getTrustedWebContentsIds: () => [...windows].map((w) => w.webContents.id),
  });
});
```

Two things to get right here:

- **`getTrustedWebContentsIds` is a function, not an array.** It is called
  for every request, so a window that closes loses its access immediately —
  there is nothing to unregister.
- **Register before the window is shown.** The channels exist from the first
  moment, so a renderer that calls early gets an answer rather than a hang.

## Add the preload

The preload is the only thing the renderer can see. Two variants:

```ts
import { keygateSandboxedPreloadPath, keygatePreloadPath } from 'electron-plugin-keygate';

// For sandbox: true — CommonJS, self-contained.
keygateSandboxedPreloadPath(); // dist/preload/sandboxed.cjs

// For sandbox: false — ESM.
keygatePreloadPath(); // dist/preload/index.mjs
```

Both install the same `window.keygate`. A sandboxed renderer cannot load an
ESM preload, and it cannot reach the package's other files at runtime — so
the sandboxed variant is a **single self-contained CommonJS file** with the
bridge bundled in at build time, and `electron` as its only external.

Keep `contextIsolation: true`. The bridge does not depend on it, but
everything else in your app does.

## Use it in the renderer

```ts
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';

const license = await keygate.activate({ key: 'KG-XXXX-XXXX-XXXX-XXXX' });
```

`window.keygate` is the same object, if you would rather not import.

## Gate a feature

Two levels, and they answer different questions.

**"Is this app licensed?"** — `getLicense()` is synchronous, reads memory,
and does no I/O. Use it to decide what to show on startup.

```ts
const license = keygate.getLicense();
if (!license?.valid) {
  showSignInPrompt();
}
```

**"Is this feature included?"** — `getEntitlements()` asks the server, and
falls back to the signed token when the server cannot be reached.

```ts
const entitlements = await keygate.getEntitlements();
if (entitlements.features['premium_support']?.enabled) {
  enablePremium();
}
```

`license.entitlements` is a flat list of the enabled feature names, for
cheap `includes()` checks:

```ts
if (license.entitlements.includes('premium_support')) {
  // ...
}
```

## Handle the failures

Every failure is a `KeygateError` with a `code` and a `detail`. The code is
what to branch on; the detail is for the log, and never contains key
material.

```ts
try {
  await keygate.activate({ key });
} catch (err) {
  if (!isKeygateError(err)) throw err;

  switch (err.code) {
    case 'LICENSE_EXPIRED':
    case 'LICENSE_SUSPENDED':
    case 'LICENSE_REVOKED':
    case 'ACTIVATION_LIMIT':
    case 'DEVICE_HELD':
      // The customer has to do something about it.
      showActivationProblem(err.detail);
      break;

    case 'REQUEST_ERROR':
    case 'HTTP_ERROR':
    case 'STORAGE_UNAVAILABLE':
      // We could not find out. Offer to try again.
      showTemporaryProblem(err.detail);
      break;

    default:
      showGenericProblem(err.detail);
  }
}
```

The full list of codes is in the [API reference](api.md#error-codes), and
what each one means for the customer is in
[Known issues and limits](bugs.md).

## Check that it works

The package's own checks need a real server and a real key:

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run verify:live
```

That activates a licence, verifies it, releases the slot, and checks the
idempotency rules. `npm run verify:live-electron` does the same inside a
real Electron with the real OS vault, and proves the offline restore by
starting a second process with the network gone.

Both are described in [Testing](testing.md).

## When something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every call answers `LICENSING_DISABLED` | `KEYGATE_API_URL` is unset, or `config` was `null` | Set the URL, or pass a `config` |
| `NO_KEYGATE_BRIDGE` | the preload is missing or wrong | use `keygateSandboxedPreloadPath()` for `sandbox: true` |
| `UNTRUSTED_SENDER` | the window is not in the trust list, or the call came from an iframe | add the window's `webContents.id` to `getTrustedWebContentsIds`, and call from the main frame |
| `STORAGE_UNAVAILABLE` | no usable OS vault | on Linux, install a secret service — `basic_text` is refused on purpose ([Security](security.md#the-os-vault)) |
| `NO_IDENTIFIER` | the machine id could not be read | set `KEYGATE_IDENTIFIER`, or pass `identifier` explicitly |
| `ERR` with "key is required" | the renderer sent something other than `{ key }` | check the argument shape against the [API reference](api.md) |
| The licence disappears on restart | the cached token expired or the server withdrew it | see [Offline](offline.md) |
| A packaged app finds no preload | the path was resolved from the app's own bundle | use the helpers; do not build the path by hand ([Architecture](architecture.md#the-two-packaging-rules)) |
