# Testing

The suite, the scripts, how to run them against a live Keygate server, and
a checklist for testing **your** integration before you ship it.

- [The layers](#the-layers)
- [The scripts](#the-scripts)
- [Against a live server](#against-a-live-server)
- [What the live checks actually prove](#what-the-live-checks-actually-prove)
- [Taking a slot and keeping it](#taking-a-slot-and-keeping-it)
- [Testing your own integration](#testing-your-own-integration)
- [In CI](#in-ci)

---

## The layers

| Layer | Where | What it covers |
| --- | --- | --- |
| **unit** | `test/unit/` | the token, the config, the errors, the validation, the service, the storage, the client |
| **integration** | `test/integration/` | the renderer bridge and the IPC envelope, end to end inside one process |
| **offline** | `test/offline/` | restoring a licence with no server at all |
| **live** | `test/live/` | the client against a real Keygate server — skipped unless the environment says otherwise |

The live tests skip themselves when `KEYGATE_LIVE_URL` or `KEYGATE_LIVE_KEY`
is missing, so `npm test` is safe to run anywhere.

```sh
npm test              # everything: 133 passing, 9 skipped
npm run test:unit
npm run test:integration
npm run test:offline
npm run test:live     # needs the environment below
```

## The scripts

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm test` | the whole automated suite |
| `npm run build` | bundles the five entry points and writes the declarations |
| `npm run smoke` | checks that every entry point and the `exports` map resolve |
| `npm run check:readme` | checks that every table-of-contents link points at a heading that exists |
| `npm run verify:electron` | a real Electron, a sandboxed renderer, every channel |
| `npm run verify:packaged` | installs the tarball into an app, packages it, runs it |
| `npm run verify:live` | the client against a live server, reporting each step |
| `npm run verify:live-electron` | a real Electron, the real OS vault, a real server |
| `npm run activate:live` | activates **this** machine and leaves it active |
| `npm run assets` | redraws the README images, including the Mermaid diagram |

`verify:electron` and `verify:packaged` need no server and no key. They are
the ones to run in CI on every commit.

## Against a live server

Two environment variables, and nothing else:

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run test:live
```

> **The key is never written to disk.** Only ciphertext is: the package
> encrypts the key with `safeStorage` before it touches the filesystem, and
> the live checks assert that the files on disk are ciphertext.

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run verify:live
```

`verify:live` reports each step it takes, so a failure says which one broke:

1. activate this machine;
2. verify it;
3. read the entitlements;
4. deactivate it;
5. activate it again — the server must not take a second slot;
6. replay the same request with the same idempotency key — the server must
   answer the same thing;
7. replay it with a **different** body and the same key — the server must
   answer `422 IDEMPOTENCY_KEY_CONFLICT`;
8. and the rest of the thirteen checks.

All of them **release the slot they took**, so the server is left as it was
found.

## What the live checks actually prove

`verify:live-electron` is the one that cannot be faked, because it uses
the real operating system's vault and a real Electron:

1. **Activate** against the live server.
2. **Assert the files on disk are ciphertext** — read `userData/keygate/key`
   and check that it does not contain the key.
3. **Start a second process** with the server set to an address that cannot
   be reached (`http://127.0.0.1:1`).
4. **Prove the offline restore** — the second process comes up licensed, from
   the cache, with no network.
5. **Release the slot.**

It also reports which generation of the `safeStorage` API the running Electron
provided, and asserts that the asynchronous decrypt resolves with an object
rather than a string — the shape difference that broke a packaged app once.

To run it against a different Electron build:

```sh
KEYGATE_ELECTRON_PATH="$TEMP/electron45/node_modules/electron/dist/electron.exe" \
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run verify:live-electron
```

## Taking a slot and keeping it

To see an activation in the Keygate portal, or to test against a machine
that is already licensed:

```sh
KEYGATE_LIVE_URL=http://localhost:9000 \
KEYGATE_LIVE_KEY=KG-XXXX-XXXX-XXXX-XXXX \
  npm run activate:live
```

It uses the same device identifier a real install derives from the machine
id, so the activation looks like a real one. Release it again with:

```sh
npm run activate:live -- --release <identifier>
```

## Testing your own integration

Before shipping an app that uses this package, check these. Each one has
caught a real bug at some point.

**In the renderer**

- [ ] A sandboxed renderer gets `window.keygate` — `verify:electron` does
      this against the built package.
- [ ] All eight methods are present, and nothing else is on `window`.
- [ ] A call from an iframe is refused with `UNTRUSTED_SENDER`.
- [ ] A call from a window that is not in the trust list is refused.
- [ ] A malformed argument is refused **before** any licence work happens.

**In the main process**

- [ ] `registerKeygate` returns `null` when `KEYGATE_API_URL` is unset, and
      every channel answers `LICENSING_DISABLED`.
- [ ] `persistsLicenses` is `false` until the vault has been probed.
- [ ] `startupDiagnostic` says `restored` on a machine with a good cache.
- [ ] The app starts unlicensed — and says why — when the vault is unusable.

**On disk**

- [ ] `userData/keygate/key` is ciphertext, not the key.
- [ ] The key and the token survive a restart.
- [ ] `resetLicense()` clears the licence and keeps the key.
- [ ] `resetLicenseKey()` clears the key.

**Against a live server**

- [ ] Activation, verification, entitlements and deactivation all work.
- [ ] Activating the same machine twice does not take a second slot.
- [ ] The offline restore works with the network gone.

## In CI

The checks that need no server are the ones that belong on every commit:

```sh
npm run typecheck
npm test
npm run build
npm run smoke
npm run check:readme
npm run verify:electron
npm run verify:packaged
```

`verify:packaged` is the one people forget, and it is the one that catches
packaging bugs: it packs the tarball, installs it into a real Electron app,
packages that app, runs it, and checks the bridge is there. A preload that
only resolves from a source checkout fails here and nowhere else.

The live checks need a server and a key, so they belong on a schedule or on
a release, not on every commit. They are also the only checks that exercise
the **real** `safeStorage` and a **real** server, so they are worth running
before a release even if they are not worth running on every push.

> A note on npm's install-script policy: npm 11 refuses to run install
> scripts for packages that have not been approved. The package's own
> `package.json` lists `electron` and `esbuild` in `allowScripts`, so a
> fresh `npm ci` in CI installs them without anyone having to approve
> anything by hand.
