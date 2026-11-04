# electron-plugin-keygate

Licensing for Electron applications that use [Keygate](https://keygate.app).

The package keeps every credential in the main process. The renderer gets
eight typed IPC channels and nothing else — no license key in the page, no
filesystem access, no arbitrary invoke.

```ts
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';

const license = await keygate.activate({ key: 'KG-XXXX-XXXX-XXXX-XXXX' });
if (license.entitlements.includes('premium_support')) {
  // ...
}
```

## This is a Keygate client, not a Keygen one

The protocol here is **Keygate's** — the endpoints `/license/activate`,
`/license/verify`, `/license/deactivate`, `/license/entitlements` and
`/license/pubkey`, and the signed-token scheme described below.

Keygen's plugin was read as an *architectural* reference only — for the
preload layout, the IPC trust model and the shape of the offline cache.
Keygen's **wire protocol is different and is not implemented here**: it uses
`/v1/licenses/…` paths and a server-controlled *machine file* for offline
validity, where Keygate issues a signed token that carries its own lifetime.

So this package is not a drop-in replacement for a Keygen client, and a
Keygen-shaped detail appearing in the code is a bug rather than a
compatibility feature.

## Install

```sh
npm install electron-plugin-keygate
```

`electron >= 30` is a peer dependency. The package itself has **no runtime
dependencies** — `node:crypto` and `node:fs` are enough.

## What it does

| | |
| --- | --- |
| **Activate** | Registers this device against a license and gets a signed token. |
| **Verify** | Checks the license and this device's activation against the server. |
| **Deactivate** | Releases this device's activation slot, so another machine can take it. |
| **Entitlements** | The license's feature map, with quota usage when the server is reachable. |
| **Offline** | A verified token is cached under the OS vault and restored on the next launch, without a network call. |
| **Secure storage** | The license key and the token are encrypted with Electron's `safeStorage`. There is no plaintext fallback. |

## Setup

### Main process

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerKeygate } from 'electron-plugin-keygate';

const windows = new Set<BrowserWindow>();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    webPreferences: {
      preload: [
        // The app's own preload, then the Keygate bridge.
        join(__dirname, '../preload/index.mjs'),
        // The sandboxed bridge. See "Sandboxing" below.
        keygateSandboxedPreloadPath(),
      ],
      sandbox: true,
      contextIsolation: true,
    },
  });
  windows.add(window);

  // The channels exist from the first moment, so an early call answers
  // LICENSING_DISABLED rather than hanging.
  await registerKeygate({
    app,
    ipc: ipcMain,
    // Re-read per request: a closed window loses access by itself.
    getTrustedWebContentsIds: () => [...windows].map((w) => w.webContents.id),
  });
});
```

The configuration comes from the environment:

| Variable | Meaning |
| --- | --- |
| `KEYGATE_API_URL` | The Keygate server. **Unset means licensing is off.** |
| `KEYGATE_PUBLIC_KEY` | The Ed25519 public key, hex. Pinning it is optional but stronger. |
| `KEYGATE_IDENTIFIER` | Override the device identifier. |
| `KEYGATE_REQUEST_TIMEOUT_MS` | Per-request timeout. Default 30 000. |
| `KEYGATE_MAX_CLOCK_DRIFT_SECONDS` | Tolerated clock disagreement. Default 300. |

Or configure it in code:

```ts
import { KeygateBuilder, registerKeygate } from 'electron-plugin-keygate';

const config = KeygateBuilder.new('https://keygate.app')
  .publicKey('a'.repeat(64))
  .build();

await registerKeygate({ app, ipc: ipcMain, getTrustedWebContentsIds, config });
```

`config: null` turns licensing off explicitly, without touching the
environment.

### Preload

```ts
import { keygateSandboxedPreloadPath, keygatePreloadPath } from 'electron-plugin-keygate';

// For sandbox: true — CommonJS, self-contained.
keygateSandboxedPreloadPath(); // dist/preload/sandboxed.cjs

// For sandbox: false — ESM.
keygatePreloadPath(); // dist/preload/index.mjs
```

Both install the same bridge on `window.keygate`.

### Renderer

```ts
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';

try {
  const license = await keygate.activate({ key });
  console.log(license.planName, license.entitlements);
} catch (err) {
  if (isKeygateError(err)) {
    switch (err.code) {
      case 'LICENSE_EXPIRED':
      case 'LICENSE_SUSPENDED':
      case 'LICENSE_REVOKED':
      case 'ACTIVATION_LIMIT':
      case 'DEVICE_HELD':
        showActivationProblem(err.detail);
        break;
      default:
        showTemporaryProblem(err.detail);
    }
  }
}
```

## Sandboxing

A sandboxed renderer cannot load an ESM preload, and it cannot reach the
package's other files at runtime. `keygateSandboxedPreloadPath()` returns
a **single self-contained CommonJS file** — the bridge is bundled in at
build time, with `electron` as the only external.

```ts
webPreferences: {
  preload: [keygateSandboxedPreloadPath()],
  sandbox: true,
  contextIsolation: true,
}
```

## How the offline window works

Keygate issues an Ed25519-signed token rather than a checked-out machine
file. The token carries:

| Field | Meaning |
| --- | --- |
| `exp` | The **check-in interval** — how long the client may stay offline before verifying again. |
| `vun` | The **license term** — when the license itself lapses. Absent means perpetual. |
| `grc` | Grace days after `vun`. |
| `upd` | End of the maintenance period, for a perpetual license. |
| `fpr` | The device binding: `sha256(identifier + ":" + product_id)`, first 8 bytes. |

The client verifies the signature locally with the server's public key, so
**a licence can be restored on launch with no network at all**. The server
clamps `exp` so it never outlives `vun` plus the grace days, and the
client honours both.

The token is `base64url(payload-json) + "." + base64url(ed25519-signature)`,
and **the signed bytes are the base64url payload string, not the JSON**.
Signing or verifying the JSON instead is the most common integration mistake
here: it produces a token that looks well-formed and is rejected by the
server.

The consequence worth knowing: a license revoked on the server is still
honoured offline until the cached token's `exp` passes. Shorten the
check-in interval on the plan to shorten that window.

## The IPC contract

Eight channels, all under `keygate:`. Every handler checks the sender,
validates its arguments, and answers with an envelope — nothing throws
across the boundary.

| Channel | Arguments | Success data |
| --- | --- | --- |
| `keygate:get-license` | — | `KeygateLicense \| null` |
| `keygate:get-license-key` | — | `string \| null` |
| `keygate:activate` | `{ key, label?, identifier? }` | `KeygateLicense` |
| `keygate:verify` | `{ key?, identifier? }` | `KeygateLicense` |
| `keygate:deactivate` | `{ key?, identifier? }` | `null` |
| `keygate:get-entitlements` | `{ key?, feature? }` | `KeygateEntitlements` |
| `keygate:reset-license` | — | `null` |
| `keygate:reset-license-key` | — | `null` |

**Sender policy.** The requesting web contents must be in the trust list
*and* the frame must be that window's main frame. An iframe gets no
licensing access even inside a trusted window. The trust list is re-read
per request, so closing a window removes its access with no cleanup.

**Argument validation.** Every payload is checked before a license is
touched. Keys are capped at 256 characters and rejected if they contain
control characters.

## Error codes

`KeygateError` carries `{ code, detail }`. The detail is a human-readable
sentence and never contains key material.

| Code | Meaning |
| --- | --- |
| `CONFIG` | The configuration cannot be used. |
| `LICENSING_DISABLED` | Licensing is not configured in this build. |
| `UNTRUSTED_SENDER` | The frame is not a trusted main frame. |
| `NO_IDENTIFIER` | This machine has no usable device identifier. |
| `REQUEST_ERROR` | The request failed or timed out. |
| `HTTP_ERROR` | The server answered with an unusable status. |
| `BAD_RESPONSE` | The server answered 2xx with a body this package cannot use. |
| `BAD_TOKEN` | The signed token is malformed or its signature does not verify. |
| `TOKEN_EXPIRED` | The signed token is past its offline lifetime. |
| `BAD_CACHE` | The cached offline state is past its lifetime or unverifiable. |
| `STORAGE_UNAVAILABLE` | The OS encryption vault is unusable. |
| `STORAGE_DECRYPT_FAILED` | Stored ciphertext could not be decrypted. |
| `NOT_ACTIVATED` | This device is not activated for the license. |
| `NO_LICENSE` | There is no license to act on. |
| `EXPIRED` | The license term is over, grace included. |
| `NOT_FOUND` | The server does not know this license. |
| `NO_KEYGATE_BRIDGE` | The window has no preload bridge. |
| `IPC_UNREACHABLE` | No handler is registered for the channel. |
| `unknown` | The envelope was not shaped the way this package expects. |

The server's own codes are passed through verbatim, so you can branch on
`LICENSE_EXPIRED`, `LICENSE_CANCELED`, `LICENSE_SUSPENDED`,
`LICENSE_REVOKED`, `ACTIVATION_LIMIT`, `DEVICE_HELD`, `FLOATING_LICENSE`,
`SEAT_PAUSED`, `FEATURE_NOT_AVAILABLE` and the rest.

## Storage

Under `app.getPath("userData")`:

```
userData/keygate/key     the license key, encrypted
userData/keygate/token   the signed token and its state, encrypted
```

Both are encrypted with Electron's `safeStorage` — DPAPI on Windows, the
Keychain on macOS, libsecret or kwallet on Linux. **There is no plaintext
fallback.** Linux's `basic_text` backend counts as unusable, because the
"key" is a fixed string in a world-readable file.

The package speaks both generations of the `safeStorage` API, so it works on
Electron 30 through 46 and beyond: the synchronous trio on 30–45, the
asynchronous trio on 45+. Electron 46 removed the synchronous one, so the
asynchronous API is preferred whenever it is present.

## Testing

| Command | What it does |
| --- | --- |
| `npm test` | The whole automated suite. The live tests skip themselves. |
| `npm run typecheck` | TypeScript, no emit. |
| `npm run build` | Bundles the five entry points and writes the declarations. |
| `npm run smoke` | Checks that every entry point and the `exports` map resolve. |
| `npm run verify:electron` | A real Electron, a sandboxed renderer, every channel. |
| `npm run verify:packaged` | Installs the tarball into an app, packages it, runs it. |

The checks that need a real server take the URL and the key from the
environment. **The key is never written to disk** — only ciphertext is:

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run test:live            # the client against a live server
```

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run verify:live          # the same, reporting each step
```

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run verify:live-electron # a real Electron, the real OS vault
```

`verify:live-electron` is the one that cannot be faked: it activates a real
license, lets the real `safeStorage` encrypt it, checks the files on disk are
ciphertext, and then starts a **second process with the network gone** to
prove the offline restore works. Set `KEYGATE_ELECTRON_PATH` to run it against
a different Electron build.

## Deliberately absent

- No arbitrary-invoke channel, no filesystem channel, and no channel that
  reaches the network directly. The renderer can only ask the main process
  to do the eight things above.
- No plaintext fallback when OS encryption is missing.
- No weakening of signature verification, and no clock tolerance beyond
  `KEYGATE_MAX_CLOCK_DRIFT_SECONDS`.
- No billing or payment surface. The package is a client of Keygate, not
  a licensing server.
- The cached token is honoured offline until its `exp` passes. A license
  revoked in the meantime is not known until the next online check.

## Licence

MIT.
