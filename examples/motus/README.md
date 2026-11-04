# Motus integration

How to wire `electron-plugin-keygate` into Motus, which already runs its
renderer with `sandbox: true`.

Motus is the reference consumer for this package: an Electron app that
keeps its credentials in the main process and ships a sandboxed renderer.

## 1. Install

```sh
bun add electron-plugin-keygate
```

## 2. Register the channels

`lib/main/keygate.ts` — see `examples/motus/lib/main/keygate.ts` in this
package for the whole file.

```ts
// lib/main/main.ts
import { initKeygate } from './keygate';

app.whenReady().then(async () => {
  // The channels exist before this returns, so an early renderer call
  // answers LICENSING_DISABLED rather than hanging.
  await initKeygate();
  ...
});
```

The configuration comes from the environment:

```sh
KEYGATE_API_URL=https://keygate.app
KEYGATE_PUBLIC_KEY=<the 64-character hex Ed25519 key>
```

`KEYGATE_API_URL` unset means licensing is off, and `initKeygate()`
returns `null`. A build without Keygate keeps working unchanged — which
is what makes the package safe to depend on before the server is
configured.

## 3. Add the preload

Motus's window already runs with `sandbox: true`, so it needs the
**sandboxed** preload — a single self-contained CommonJS file.

```ts
// lib/main/app.ts
import { keygateSandboxedPreloadPath } from 'electron-plugin-keygate';

const mainWindow = new BrowserWindow({
  webPreferences: {
    preload: [
      join(__dirname, '../preload/preload.js'),
      keygateSandboxedPreloadPath(),
    ],
    sandbox: true,
  },
});
```

Electron runs the preloads in order, so the app's own bridge is
installed first and the Keygate bridge second.

### Packaging

`keygateSandboxedPreloadPath()` resolves through the package's `exports`
map, so the file ships inside the app's `node_modules`. electron-builder
copies `node_modules` into the asar, and Electron can load a preload from
inside an asar — so no extra copying is needed.

If the build strips `node_modules`, copy the file explicitly:

```ts
// electron-builder.yml
extraFiles:
  - from: node_modules/electron-plugin-keygate/dist/preload/sandboxed.cjs
    to: keygate/sandboxed.cjs
```

and point the preload at `join(process.resourcesPath, 'keygate/sandboxed.cjs')`.

## 4. Use it in the renderer

```ts
// app/licensing.ts — see examples/motus/app/licensing.ts
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';

const license = await keygate.getLicense();
if (license?.valid && license.entitlements.includes('premium_support')) {
  // ...
}
```

## 5. Trust the windows

The trust list is what stops an embedded page from asking for licensing
operations.

```ts
// lib/main/keygate.ts
const licensedWindows = new Set<BrowserWindow>();

export function trackLicensedWindow(window: BrowserWindow): void {
  licensedWindows.add(window);
  window.on('closed', () => licensedWindows.delete(window));
}

// ...and in registerKeygate:
getTrustedWebContentsIds: () => [...licensedWindows].map((w) => w.webContents.id),
```

The list is re-read per request, so closing a window revokes its access
immediately — the `closed` handler is only housekeeping.

## What to check before shipping

- **The offline path.** Activate on a machine, quit the app, disconnect
  the network, and start it again. It must come up licensed. The
  `offline` flag on the license tells you the state was cached rather
  than confirmed with the server.
- **The revocation path.** Revoke the license in the customer portal and
  start the app again. The cached token is honoured until its `exp`
  passes — that window is the plan's check-in interval, so shorten it if
  the window is too long.
- **The vault path.** On Windows the key is protected by DPAPI, which
  stops other *users* of the machine from reading it — not other
  processes running as the same user. On Linux, a `basic_text` libsecret
  backend is refused outright rather than used.
- **The packaged app.** `npm run verify:electron` in this package checks
  the sandboxed preload in a live renderer. Motus's own Playwright suite
  should get the same coverage.

## Motus's conventions

- Tabs, single quotes, 120 columns — Biome formats this package's
  examples the same way.
- No barrel `index.ts` files. The example files are named for what they
  hold.
- Every feature needs a test that ends green: the package's own suite
  covers the protocol, and Motus's Playwright suite should cover the
  window-level behaviour.
