# Keygate vs Keygen

This package talks to **Keygate**. Keygen's plugin was read as an
*architectural* reference and nothing more.

The two have the same shape and a different protocol. That is the whole
confusion, and it is worth spelling out.

- [The short version](#the-short-version)
- [The protocols side by side](#the-protocols-side-by-side)
- [What was borrowed](#what-was-borrowed)
- [What was not](#what-was-not)
- [Migrating](#migrating)
- [Where the confusion comes from](#where-the-confusion-comes-from)

---

## The short version

**Keygen** validates a license key against a server that owns a set of
**machines**. The client sends a fingerprint, the server creates a machine
resource, and offline validity comes from a **machine file** — an encrypted
blob the server issues on request, with a time-to-live the server chooses.
The client stores that file and trusts it until it expires.

**Keygate** issues a **signed token**. The server signs the license state
and hands it back; the client verifies the signature with the server's
public key and trusts the token until the `exp` inside it passes. There is
no machine file, and no checkout step.

Both bind the license to a machine, both verify an Ed25519 signature, and
both cache an offline artefact with OS-backed encryption. The **wire
protocol** is different in every detail.

## The protocols side by side

| | Keygen | Keygate |
| --- | --- | --- |
| Base path | `/v1/…` | `/license/…` |
| Validate | `POST /v1/licenses/actions/validate-key` | `POST /license/verify` |
| Activate | `POST /v1/machines` — create a machine resource under the license | `POST /license/activate` — register this device |
| Deactivate | delete the machine resource | `POST /license/deactivate` |
| Entitlements | arrive inside the validate response | `POST /license/entitlements` |
| Public key | the account's Ed25519 key, for response signatures | `GET /license/pubkey` — the key that signs tokens |
| Offline artefact | a **machine file**, checked out with a TTL the server picks | a **signed token** that carries its own `exp` |
| What the client stores | the machine file, encrypted, plus the license key | the signed token and the key, encrypted |
| What proves validity offline | the machine file was issued for this machine and has not expired | the signature verifies, and `exp` has not passed |
| Machine binding | the fingerprint, and the file is encrypted to the machine's key | `fpr` — `sha256(identifier + ":" + product_id)`, first 8 bytes |
| The offline lifetime | a TTL chosen at checkout | `exp` in the token, set by the server's check-in interval |

Three differences carry the most weight:

**The offline artefact.** Keygen's machine file is an opaque encrypted blob
whose lifetime the server decides when it issues it. Keygate's token is a
readable, signed statement with the expiry inside it. One is a lease, the
other is a signed fact.

**The check-out step.** Keygen has one: the client asks for a machine file
and gets a TTL with it. Keygate has none — `activate` returns a token that
is already usable offline.

**Where the signature lives.** In Keygen it is a header over the HTTP
response, and the client verifies the response it just received. In Keygate
it is *inside* the token, which is why the token can be stored and
re-verified later, with no network, against a public key fetched days ago.

## What was borrowed

The **architecture**, deliberately and in full:

- **One preload, one bridge.** A single self-contained preload file that
  installs a namespaced object on `window`. The renderer gets a small,
  typed surface and nothing else.
- **The IPC trust model.** An allow-list of trusted web contents, re-read
  per request, plus a main-frame-only check. The renderer cannot name a
  channel.
- **The offline cache shape.** An OS-encrypted cache, restored at startup,
  with no plaintext fallback.
- **The renderer API shape.** A `keygate` object with named methods that
  resolve or reject, rather than a set of loose functions.
- **The one-call registration.** `registerKeygate` in the main process is
  the whole integration.

## What was not

The **wire protocol**. Not one endpoint is shared, not one payload shape is
shared, and the offline artefact is a different idea entirely.

Concretely, this package does **not**:

- call `/v1/licenses/actions/validate-key`;
- create or delete a `machines` resource;
- check out a machine file, or store one;
- verify a response signature header;
- implement `validateCheckoutKey`, `resetLicense`, or any of Keygen's
  error-code vocabulary (`NO_MACHINES`, `NO_MACHINE`, `FINGERPRINT_*`,
  `VALIDATION_*`).

A Keygen-shaped detail appearing in this code is a **bug**, not a
compatibility feature. If you find one, it did not come from the protocol —
it came from the reference.

## Migrating

Migrating from `electron-plugin-keygen` to `electron-plugin-keygate` is not
a find-and-replace of the import. The **server** changes.

| | What you have to do |
| --- | --- |
| The server | Point the app at your Keygate instance. The Keygen account, the licenses and the machines stay where they are until you move them. |
| The import | `electron-plugin-keygate/renderer` instead of `electron-plugin-keygen/renderer` |
| The methods | `activate` / `verify` / `deactivate` / `getEntitlements` instead of `validateKey` / `checkout` / `validateCheckoutKey` |
| The errors | Keygate's codes, not Keygen's. `LICENSE_EXPIRED`, `ACTIVATION_LIMIT`, `DEVICE_HELD`, and the rest. |
| The offline artefact | Nothing to migrate. The token is issued by `activate`. |

The renderer API is close enough that most call sites move over in a few
lines, but the **error handling** is the part to look at carefully: the
vocabulary is different, and a code you did not handle before is now a code
you have never seen.

## Where the confusion comes from

The two packages have the same name shape, the same author-shaped
architecture, and the same job. Both are "the Electron licensing plugin".

They are not interchangeable, and neither one is a drop-in for the other.

When you see a Keygen-shaped detail in this package, it is one of three
things:

1. a bug;
2. a deliberate difference that this package documents — the hashed
   machine identifier, the encrypted cache, the enforced `fpr` binding;
3. an accident that got in before anyone noticed.

The third is what the [test suite](../README.md#-testing) is for.
