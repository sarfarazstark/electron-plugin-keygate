# Security

The threat model, one defence at a time, and what each one buys. The limits
are stated too, because a security story that only lists defences is not a
security story.

- [The threat model](#the-threat-model)
- [Sender trust](#sender-trust)
- [Argument validation](#argument-validation)
- [The OS vault](#the-os-vault)
- [The token signature](#the-token-signature)
- [The device binding](#the-device-binding)
- [Clock drift](#clock-drift)
- [What this package does not protect against](#what-this-package-does-not-protect-against)
- [Keeping it that way](#keeping-it-that-way)

---

## The threat model

**Untrusted:** the renderer. A page can be compromised — a remote script
injection, a malicious dependency, an ad, a supply-chain attack on the
front-end. Whatever the page can reach, an attacker can reach.

**Trusted:** the main process, the preload, and the operating system's
keystore. An attacker who has the main process has already won, and no
library can give that back.

The package is built around one sentence: **the renderer must not be able to
get the license key, and the license key must not be on disk in the clear.**

Everything below is a step towards that, or an honest statement of how far
it goes.

## Sender trust

Every handler starts by asking who is calling.

```ts
const ids = await getTrustedWebContentsIds();
if (!ids.includes(event.sender.id)) return;
if (event.senderFrame !== event.sender.mainFrame) return;
```

Three properties matter:

- **The id list is re-read per request.** It is a function, not a snapshot,
  so a window that closes loses its access at once, with nothing to
  unregister.
- **Main frame only.** A frame from an embedded document is refused, even
  inside a window the app trusts. An iframe is not the window.
- **The check happens before the arguments are looked at.** An untrusted
  sender gets `UNTRUSTED_SENDER` and nothing else — it cannot even tell
  whether a licence is configured.

The trust list is the app's to get right. A `getTrustedWebContentsIds` that
returns every window, or every web contents in the app, hands the licence
over to whichever one is compromised. Keep it to the windows that are
actually showing licensed content.

## Argument validation

The renderer is untrusted input, so every payload is checked before a
licence is touched. A rejected call never reaches the service.

| Field | Rule |
| --- | --- |
| `key` | required, a string, at most 256 characters, no control characters |
| `label` | optional, a string, at most 256 characters, no control characters |
| `identifier` | optional, a string, at most 256 characters, no control characters |
| `identifierType` | optional, exactly `device` or `user` |
| `feature` | optional, a string, at most 128 characters |

"Control characters" means C0 (including NUL), DEL, and the C1 range. The
check is a codepoint scan rather than a regular expression, because a source
file carrying a literal NUL is a hazard in its own right.

The lengths are not cosmetic. An unbounded string that reaches the server is
an unbounded request; a string with a NUL in it is a string some layers will
truncate and others will not.

Validation is hand-rolled rather than pulled from a library, so the package
ships with **no runtime dependencies at all** — `electron` stays the only
thing an app has to have.

## The OS vault

The key and the token are encrypted with Electron's `safeStorage` before
they touch the disk: DPAPI on Windows, the Keychain on macOS, libsecret or
kwallet on Linux.

**There is no plaintext fallback.** A vault that cannot encrypt is a vault
that cannot be used, and the package says so — `STORAGE_UNAVAILABLE` —
rather than writing a license key to disk in the clear.

On Linux, libsecret's `basic_text` backend counts as unusable. It is
encryption in name only: the "key" is a fixed string in a world-readable
file, so a licence stored under it would be readable by every process on the
machine. The package refuses it, and answers `STORAGE_UNAVAILABLE`.

The package speaks both generations of the API, because a package that
claims to support `electron >= 30` has to:

| Electron | API |
| --- | --- |
| 30–45 | `isEncryptionAvailable`, `encryptString`, `decryptString` |
| 45+ | `isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync` |

The asynchronous trio is preferred whenever it is present, because Electron
46 removed the synchronous one. The asynchronous decrypt answers an object —
`{ result, shouldReEncrypt }` — not a string, and reading the wrong shape
would turn every cached licence into a parse failure.

`persistsLicenses` answers `false` until the vault has actually been
probed, so an app can tell "licensing is off" from "the vault is broken"
before it has shown a licence screen.

## The token signature

Keygate's tokens are Ed25519-signed:

```
<base64url(payload-json)>.<base64url(ed25519-signature)>
```

The client verifies the signature locally with the server's public key
before it believes a single field of the payload. A token that was not
issued by your server, or was edited on the way, is refused with
`BAD_TOKEN`.

The detail that catches people: **the signed bytes are the base64url
payload string, not the JSON.** Verifying against the decoded JSON fails
against a real server on every token, and the failure looks like a corrupt
token rather than a mistake. See [Offline](offline.md#the-signature) for the
whole scheme.

## The device binding

A valid signature only proves the server issued the token. It does not prove
the server issued it *for this machine*.

The server writes `fpr` — `sha256(identifier + ":" + product_id)`, first
eight bytes, hex — and the client checks it. A token copied from another
machine, or issued for another product, fails the check and is refused with
`BAD_TOKEN`.

Without that check, a copied token would verify perfectly well and would
leave the other machine looking licensed.

## Clock drift

A token issued further in the future than `maxClockDriftSeconds` (300 by
default) is refused. That covers a clock that is behind, and a token minted
by someone else with a valid signature.

The tolerance is deliberate and small. A wider window would accept a token
that has not been issued yet; a negative one would break every machine whose
clock is a little off.

## What this package does not protect against

Stated plainly, because a customer will eventually ask:

- **A licence revoked while the app is offline stays valid** until the
  cached token's `exp` passes. That is the trade the offline window buys.
  Shorten the check-in interval to shorten it. See
  [Offline](offline.md#the-offline-window).
- **The key is in the main process's memory while it is in use.** An
  attacker with code execution in the main process can read it. The renderer
  cannot; the main process can, by definition.
- **An attacker with administrator rights on the machine** can read the
  machine id, and therefore forge an identifier, and therefore move a
  licence between machines they control. The vault stops the key at rest;
  it does not stop someone who already owns the machine.
- **The app itself is not tamper-proof.** The package does not sign your
  binaries or check them at startup. If your app can be patched to skip the
  licence check, it can be.
- **The renderer can still call all eight channels.** That is the design:
  the point is that it cannot get the key, and that every call is checked.
  A compromised page can still ask "is this licensed?" and can still try to
  activate a key it guesses — which is why the key is never in the page.
- **The entitlements in a cached token are only as fresh as the token.**
  When the server cannot be reached, the feature map comes from the signed
  token, so it reflects the state at the last check-in.

## Keeping it that way

The defences above are only as good as the code that implements them, and
the code is only as good as its tests. The suite that protects them:

```sh
npm run typecheck        # the types
npm test                 # 133 unit, integration and offline tests
npm run verify:electron  # a real Electron, a sandboxed renderer, every channel
npm run verify:packaged  # the tarball, installed and run
npm run check:readme     # the documentation still matches the code
```

`verify:electron` is the one that cannot be faked: it checks that a
sandboxed renderer really does get the bridge, that all eight channels are
there, that an untrusted sender is refused, and that a malformed argument is
rejected before any licence work happens. See [Testing](testing.md).

What was verified on which platform is recorded in
[Known issues and limits](bugs.md).
