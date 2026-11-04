# API

Every export, every shape, every error code. This is the reference the
README points at; the README is the guide, this is the contract.

## Package surface

| Import specifier | Runs in | Ships | Purpose |
| --- | --- | --- | --- |
| `electron-plugin-keygate` | main | `dist/main/index.js` | `registerKeygate`, `KeygateBuilder`, config, IPC registration, preload paths, service |
| `electron-plugin-keygate/renderer` | renderer | `dist/renderer/index.js` | the `keygate` API object, `KeygateError`, `isKeygateError` |
| `electron-plugin-keygate/preload` | preload (`sandbox: false`) | `dist/preload/index.mjs` | installs `window.keygate`; ESM |
| `electron-plugin-keygate/preload/sandboxed` | preload (`sandbox: true`) | `dist/preload/sandboxed.cjs` | the same bridge, self-contained CommonJS |
| `electron-plugin-keygate/preload/api` | preload / tests | `dist/preload/api.js` | `createKeygateBridge(invoke)`, with no `electron` import |

Peer dependency: `electron >= 30`. The main and renderer entries are
ESM-only — the `exports` map has no `require` condition. The sandboxed
preload is CommonJS because that is what a sandboxed renderer can load.

---

## Main process

### `registerKeygate`

```ts
function registerKeygate(options: RegisterKeygateOptions): Promise<LicensingService | null>
```

The one call an app needs.

| Option | Type | Meaning |
| --- | --- | --- |
| `app` | `KeygateAppHost` | structural: `name`, `getPath("userData")`, `getVersion()`, `getLocale()`, `whenReady()` |
| `ipc` | `IpcMainLike` | structural: `handle(channel, listener)` — `ipcMain` satisfies it |
| `getTrustedWebContentsIds` | `() => number[]` | re-read **per request**, so a closed window loses access without unregistering |
| `config` | `KeygateConfigInput \| null` | omitted → read from `KEYGATE_*`; `null` → licensing disabled |
| `log` | `Logger` | `{ info, warn, error }`; defaults to `console` with a `[keygate]` prefix |
| `createService` | `(args: ServiceInitArgs) => Promise<LicensingService \| null>` | injection point for tests |
| `fetchImpl` | `FetchLike` | injection point for tests |
| `safeStorage` | `SafeStorageLike` | injection point for tests |

Behaviour worth knowing:

- The eight channels are registered **before** `whenReady()` resolves, so
  an early request answers `LICENSING_DISABLED` instead of hanging.
- The service is built after the app is ready, when `userData` resolves.
- A licensing failure never takes the app down: the error is logged and
  every channel reports it.
- `config` omitted and no `KEYGATE_API_URL` in the environment means
  licensing is off, and the function returns `null`.

### `KeygateBuilder`

```ts
KeygateBuilder.new(apiUrl?): KeygateBuilder
KeygateBuilder.withPublicKey(publicKey): KeygateBuilder
  .apiUrl(url)               // the Keygate server's base URL
  .publicKey(hexKey)        // the server's Ed25519 public key
  .identifier(id)           // pin the device identifier
  .requestTimeoutMs(ms)     // clamped to [1000, 120000]
  .maxClockDriftSeconds(s)  // how far the local clock may disagree
  .build(): KeygateConfigInput
```

`build()` validates and throws `CONFIG` on a bad value, so a mistake
surfaces at build time rather than on the first licensing call.

### Config

| Field | Default | Rule |
| --- | --- | --- |
| `apiUrl` | `https://keygate.app` | absolute, http or https, no trailing slash |
| `publicKey` | `null` | 64 hex characters when set; otherwise fetched and cached |
| `identifier` | `null` | derived per machine when unset |
| `requestTimeoutMs` | `30000` | clamped to `[1000, 120000]` |
| `maxClockDriftSeconds` | `300` | not settable per request |

| Env var | Maps to |
| --- | --- |
| `KEYGATE_API_URL` | `apiUrl` (**the gate**: unset means licensing is off) |
| `KEYGATE_PUBLIC_KEY` | `publicKey` |
| `KEYGATE_IDENTIFIER` | `identifier` |
| `KEYGATE_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` |
| `KEYGATE_MAX_CLOCK_DRIFT_SECONDS` | `maxClockDriftSeconds` |

### Preload path helpers

```ts
keygatePreloadPath(): string          // dist/preload/index.mjs   — unsandboxed only
keygateSandboxedPreloadPath(): string // dist/preload/sandboxed.cjs — for sandbox: true
```

Both resolve through the package's `exports` map, with a `dist/`
fallback for a source checkout with no install step.

The package directory is found with **Node's own resolution** —
`require.resolve('electron-plugin-keygate/package.json')` walks the
`node_modules` chain from the calling file — and the package's `exports`
map decides the file name.

That detail matters: an app that bundles its main script inlines this
package's code, and `import.meta.url` then points at the *app's* bundle
rather than at the package. Resolving relative to it produced a path
inside the app's own directory, where there is no preload file, and the
renderer silently found no bridge.

### The service
`LicensingService` is a **main-process** object. The renderer only ever
sees the eight channels.

| Member | Kind | Note |
| --- | --- | --- |
| `getLicense()` | sync | the license in memory, or `null` — no I/O |
| `getLicenseKey()` | async | decrypts `keygate/key` |
| `activate(options)` | async | registers this device; idempotent on the server |
| `verify(options)` | async | checks the license and this device against the server |
| `deactivate(options)` | async | releases this device's slot |
| `getEntitlements(options)` | async | the server's entitlements, or the cached token's feature map |
| `resetLicense()` | async | clears the cached token and the in-memory state; keeps the cached key |
| `resetLicenseKey()` | async | clears the cached key |
| `persistsLicenses` | getter | `false` when the OS vault is unusable — check this in the main process |
| `startupDiagnostic` | getter | why startup left the app licensed or not; deliberately **not** an IPC channel |
| `init()` | async | probes the vault, restores state, records `startupDiagnostic` |
| `getPublicKey()` | sync | the public key in use, for diagnostics |

### The low-level pieces

```ts
createLicensingService(args: InitArgs): Promise<LicensingService | null>
buildSafeStorageCodec(safeStorage): SecretCodec
registerKeygateIpc(ipc, getService, isTrustedSender): void
makeWindowTrustChecker(ids: () => number[]): (event: unknown) => boolean
resolveConfig(input): KeygateConfig
configFromEnv(env?): KeygateConfigInput | null
isHexPublicKey(key): boolean
normalizeApiUrl(url): string
createEd25519PublicKey(hex): KeyObject
decodeToken(raw): DecodedToken
verifyToken(raw, hexPublicKey): KeygateTokenPayload
evaluateTokenFreshness(payload, options): TokenFreshness
expectedFingerprint(identifier, productId): string
tokenBindingMatches(payload, identifier): boolean
buildMachineIdentity(options?): Promise<MachineIdentity>
KeygateError  asKeygateError(err): KeygateError  isKeygateError(err): boolean
```

### The preload path helpers

```ts
keygatePreloadPath(): string          // dist/preload/index.mjs   — unsandboxed only
keygateSandboxedPreloadPath(): string // dist/preload/sandboxed.cjs — for sandbox: true
```

The package directory is found with **Node's own resolution** —
`require.resolve('electron-plugin-keygate/package.json')` walks the
`node_modules` chain from the calling file — and the package's `exports`
map decides the file name.

That detail matters: an app that bundles its main script inlines this
package's code, and `import.meta.url` then points at the *app's* bundle
rather than at the package. Resolving relative to it produced a path
inside the app's own directory, where there is no preload file, and the
renderer silently found no bridge.

---

## Renderer

`window.keygate` — installed by either preload — is the **bridge**: eight
methods returning the envelope untouched, because `contextBridge` strips
custom fields off thrown objects.

```ts
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; detail: string } }
```

`electron-plugin-keygate/renderer` is the layer that unwraps it, so
application code deals with values and thrown `KeygateError`s.

```ts
import { keygate, isKeygateError, KeygateError } from "electron-plugin-keygate/renderer";

const license = await keygate.verify();
// or the same eight as named members of the API object
createKeygateLicensingApi(bridge: KeygateBridge | null): KeygateLicensingAPI
isKeygateError(err): err is { code: string; detail: string }   // cross-realm safe
```

| Method | Argument | Resolves to | Rejects with |
| --- | --- | --- | --- |
| `getLicense()` | — | `KeygateLicense \| null` | `LICENSING_DISABLED`, `UNTRUSTED_SENDER` |
| `getLicenseKey()` | — | `string \| null` | as above, `STORAGE_*` |
| `activate({ key, label?, identifier? })` | — | `KeygateLicense` | `NO_IDENTIFIER`, `REQUEST_ERROR`, `BAD_RESPONSE`, `STORAGE_UNAVAILABLE`, server codes |
| `verify({ key?, identifier? })` | — | `KeygateLicense` | `NO_LICENSE`, `NOT_FOUND`, server codes |
| `deactivate({ key?, identifier? })` | — | `void` | `NO_LICENSE`, server codes |
| `getEntitlements({ key?, feature? })` | — | `KeygateEntitlements` | `NO_LICENSE`, server codes |
| `resetLicense()` | — | `void` | `LICENSING_DISABLED`, `UNTRUSTED_SENDER` |
| `resetLicenseKey()` | — | `void` | as above |

Three renderer-side codes describe the wiring, not the license:

| Code | Meaning |
| --- | --- |
| `NO_KEYGATE_BRIDGE` | this window has no preload bridge |
| `IPC_UNREACHABLE` | no handler is registered — the call never reached a licensing operation |
| `unknown` | the envelope was malformed |

---

## The IPC contract

Eight fixed channel names. Every handler does the same three things:

1. **Sender policy** — the web contents id must be in
   `getTrustedWebContentsIds()` *and* the frame must be that window's
   main frame, so iframes get no licensing access.
2. **Argument validation** — the payload is checked before a license is
   touched. Keys are capped at 256 characters and rejected when they
   contain control characters.
3. **Envelope** — success `{ ok: true, data }`, any failure
   `{ ok: false, error: { code, detail } }`. Nothing throws across the
   boundary.

| Channel | Args | `data` on success |
| --- | --- | --- |
| `keygate:get-license` | none | `KeygateLicense \| null` |
| `keygate:get-license-key` | none | `string \| null` |
| `keygate:activate` | `{ key, label?, identifier? }` | `KeygateLicense` |
| `keygate:verify` | `{ key?, identifier? }` | `KeygateLicense` |
| `keygate:deactivate` | `{ key?, identifier? }` | `null` |
| `keygate:get-entitlements` | `{ key?, feature? }` | `KeygateEntitlements` |
| `keygate:reset-license` | none | `null` |
| `keygate:reset-license-key` | none | `null` |

There is no arbitrary-invoke channel, no filesystem channel, and no
channel that reaches the network directly.

### `KeygateLicense`

```ts
type KeygateLicense = {
  key: string;
  status: string;         // 'active' | 'trialing' | 'past_due' | …
  valid: boolean;
  licenseId: string;
  productId: string;
  planId: string;
  planName: string | null;
  features: Record<string, unknown>;
  entitlements: string[]; // the names of the enabled features
  validUntil: string | null;   // ISO 8601; null means perpetual
  updatesUntil: string | null; // ISO 8601; the maintenance period's end
  graceDays: number;
  identifier: string;
  issuedAt: string | null;     // ISO 8601
  expiresAt: string | null;    // ISO 8601; the token's offline lifetime
  offline: boolean;            // restored from the cache, not confirmed online
  metadata: Record<string, unknown>;
}
```

`status` is a report, never a verdict: it carries the status string the
server put in the signed token. `valid` is the verdict, and it is only
set after the token's signature verified.

### `KeygateEntitlements`

```ts
type KeygateEntitlements = {
  licensed: boolean;
  status: string;
  planId: string;
  planName: string;
  features: Record<string, KeygateFeatureStatus>;
}

type KeygateFeatureStatus = {
  enabled: boolean;
  valueType: string;
  value: string;
  used?: number;
  limit?: number;
  remaining?: number;
  period?: string;
  resetsAt?: string;
}
```

---

## The signed token

Keygate's token is `base64url(payload-json).base64url(ed25519-signature)`.

The signed bytes are the **base64url payload string**, not the raw JSON.
Verifying against the decoded JSON fails against a real server on every
token — this is the single most common integration mistake.

The payload uses Keygate's short field names:

| Field | Meaning |
| --- | --- |
| `lid` | license id |
| `pid` | product id |
| `pln` | plan id |
| `sts` | license status at issue time |
| `did` | the identifier the token was issued for |
| `ftr` | feature entitlements |
| `iat` | issued at, unix seconds |
| `exp` | the token's lifetime — a **check-in interval**, not the license term |
| `vun` | when the license itself lapses; absent means perpetual |
| `upd` | the end of the maintenance period; absent means no limit |
| `grc` | grace days after `vun` |
| `nce` | a per-issuance nonce |
| `fpr` | the device binding: `sha256(did + ":" + pid)`, first 8 bytes, hex |

The server clamps `exp` so it never outlives `vun` plus the grace days.
The client honours both, and additionally rejects a token issued further
into the future than `maxClockDriftSeconds`.

---

## Error codes

`KeygateError` is `{ code, detail }`, with the message
`Keygate Error: {code}: {detail}`.

| Code | Raised by | Meaning |
| --- | --- | --- |
| `CONFIG` | `resolveConfig` | the configuration cannot be used |
| `LICENSING_DISABLED` | every channel | licensing is not configured in this build |
| `UNTRUSTED_SENDER` | every channel | the frame or window is not in the trust list |
| `NO_IDENTIFIER` | `activate`, `verify`, `deactivate` | this machine has no usable device identifier |
| `REQUEST_ERROR` | `KeygateClient` | the request failed or the timeout fired |
| `HTTP_ERROR` | the client | a status this package does not understand |
| `BAD_RESPONSE` | the client | a 2xx body this package cannot use |
| `BAD_TOKEN` | `verifyToken` | the token is malformed or its signature does not verify |
| `TOKEN_EXPIRED` | `evaluateTokenFreshness` | the token is past its offline lifetime |
| `BAD_CACHE` | the storage layer | the cached state is past its lifetime or unverifiable |
| `STORAGE_UNAVAILABLE` | writes, `activate`, `verify` | the OS vault is unusable |
| `STORAGE_DECRYPT_FAILED` | reads | the ciphertext was tampered with, or the key rotated |
| `NOT_ACTIVATED` | `deactivate` | this device has no activation |
| `NO_LICENSE` | `verify`, `deactivate`, `getEntitlements` | there is no license to act on |
| `EXPIRED` | the freshness check | the license term is over, grace included |
| `NOT_FOUND` | the client | the server does not know this license |
| server `code` | the client | the server's own code, verbatim |
| `ERR` | parse and I/O paths | a local failure |
| `NO_KEYGATE_BRIDGE` | the renderer entry | the window has no preload |
| `IPC_UNREACHABLE` | the renderer entry | no handler is registered for the channel |
| `unknown` | the renderer entry | the envelope was malformed |

### Server codes passed through verbatim

| Code | Status | Meaning |
| --- | --- | --- |
| `LICENSE_NOT_FOUND` | 404 | the license does not exist, is unusable, or this device is not activated |
| `LICENSE_EXPIRED` | 403 | the license term is over |
| `LICENSE_CANCELED` | 403 | the license was canceled |
| `LICENSE_SUSPENDED` | 403 | the license was suspended |
| `LICENSE_REVOKED` | 403 | the license was revoked |
| `LICENSE_INVALID` | 403 | the license is not valid |
| `ACTIVATION_LIMIT` | 409 | the plan's device limit is reached |
| `DEVICE_HELD` | 409 | this device is activated with another key on this license |
| `FLOATING_LICENSE` | 409 | the plan is floating — use floating checkout |
| `SEAT_PAUSED` | 403 | this member's seat is paused |
| `FEATURE_NOT_AVAILABLE` | 404 | the product type does not offer device activation |
| `LOCKED_OUT` | 429 | too many failed attempts |
| `RATE_LIMITED` | 429 | the request rate cap was hit |

---

## Storage

Under `app.getPath("userData")`:

```
userData/keygate/key     the license key — safeStorage ciphertext
userData/keygate/token   the signed token and its state — safeStorage ciphertext
userData/keygate/pubkey  the verification public key — safeStorage ciphertext
```

| Rule | Where |
| --- | --- |
| every write probes the vault first | `storage.ts` |
| no plaintext is ever written | `storage.ts` |
| Linux's `basic_text` backend counts as unusable | `vault.ts` / `storage.ts` |
| `safeStorage`'s async API is used when present, the sync one otherwise | `storage.ts` |
| the methods are always bound to the `safeStorage` object | `storage.ts` |

The public key is cached because it is public information, and because an
offline machine needs it: the token in the cache is verified against it
without a network call. The resolution order is the pinned key, then the
cached copy, then the server — the server is asked last so an offline
launch never waits on a request that cannot succeed.

Windows DPAPI protects against other **users** of the machine, not other
applications running in the same session.

---

## Deliberately absent

- No payment or billing surface, no separate licensing backend, no
  database. This package is a client of Keygate.
- No arbitrary-invoke channel, no filesystem channel, and no channel that
  reaches the network directly.
- No plaintext fallback when OS encryption is missing.
- No weakening of signature verification, and no clock tolerance beyond
  `maxClockDriftSeconds`.
- The cached token is honoured offline until its `exp` passes. A license
  revoked on the server is not known until the next online check — that
  window is the plan's check-in interval.
