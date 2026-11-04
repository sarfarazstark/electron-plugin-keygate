# Limits and inherited behaviours

What this package does not do, and where the edges are. Each item says
whether it was verified here and what that means.

## The offline window

The single most important limit.

Keygate issues a signed token with two separate clocks:

- `exp` — the **check-in interval**. How long the client may stay
  offline before it has to verify again. Seven days by default; a plan
  can override it with `token_ttl_days`.
- `vun` — the **license term**. When the license itself lapses, with
  `grc` grace days after it.

The server clamps `exp` so it never outlives `vun` plus the grace days,
and the client honours both.

**What this means in practice:** a license revoked on the server is still
honoured by an offline client until the cached token's `exp` passes. The
client cannot know about the revocation without asking the server, and
asking the server is what being offline means. Shorten the plan's
check-in interval to shorten that window — it is the only lever.

The alternative — refusing to run offline at all — would make the
offline support pointless. The trade is deliberate, and it is the
server's policy being enforced rather than a client-side guess.

## Oracle hardening shapes what the client can say

The server answers `404 LICENSE_NOT_FOUND` for a license that does not
exist, one that is suspended, revoked or expired, and one where this
device has no activation. All four are the same answer, on purpose: the
endpoint must not reveal which license keys are real.

**What this means:** `verify` cannot distinguish "your license expired"
from "this device is not activated" from "that key is not real". The
error code the renderer sees is `LICENSE_NOT_FOUND` in all three cases.

`activate` is different — it reports the specific status of an unusable
license (`LICENSE_EXPIRED`, `LICENSE_SUSPENDED`, `LICENSE_REVOKED`,
`LICENSE_CANCELED`), because activation is how a returning customer
learns their license has lapsed. `ACTIVATION_LIMIT` and `DEVICE_HELD`
come with `details` too.

## The public key is fetched, not pinned, by default

Without `KEYGATE_PUBLIC_KEY`, the client fetches the server's Ed25519
public key from `GET /api/v1/license/pubkey` and uses it. That is the
pattern the server documents ("SDKs fetch this once, or hard-code it
after first run"), and it is sound as long as the transport is trusted —
which it is, over HTTPS to the configured host.

**Pin it for a stronger guarantee.** With `KEYGATE_PUBLIC_KEY` set, the
package never asks the server for a key, so a server that is later
compromised cannot sign tokens the client would accept.

The key is fetched once per process and then held in memory. It is not
written to disk — a pinned key needs no disk at all, and a fetched one
is re-fetched on the next launch.

## Windows DPAPI protects against other users, not other applications

On Windows, `safeStorage` uses DPAPI. DPAPI binds the ciphertext to the
**user account**, so another user on the same machine cannot read it.

It does not protect against another process running as **the same user**.
An application with the same privileges can, in principle, ask DPAPI to
decrypt the same blob. This is a property of the platform, not of this
package, and it is why the package does not oversell the protection.

## Linux's `basic_text` backend is refused

libsecret's `basic_text` fallback stores the "key" as a fixed string in a
world-readable file. Anything it protects is readable by every process on
the machine.

The package treats that backend as **unusable**: `persistsLicenses` is
`false`, `activate` and `verify` refuse with `STORAGE_UNAVAILABLE`, and
no plaintext fallback is written. A Linux machine without a real secret
service cannot use this package's persistence, and it says so rather than
pretending.

**Not verified here:** the `basic_text` branch itself was exercised
through an injected `safeStorage` double, not on a real Linux box.

## The device identifier is derived, not proven

The identifier comes from the operating system's machine id —
`MachineGuid` on Windows, `IOPlatformUUID` on macOS,
`/etc/machine-id` on Linux — hashed, and prefixed `kg-`.

It is stable across reinstalls and the same on every launch, which is
what an activation slot needs. It is not a hardware attestation: a
machine whose machine id can be read can have its identifier reproduced.

`KEYGATE_IDENTIFIER` overrides it, for an app that manages its own
device identity.

**Not verified here:** the macOS `ioreg` and Linux `machine-id` paths
were not exercised on those platforms.

## No seat is ever released except by this package's own deactivate

`deactivate` frees this device's activation slot. Nothing else does.
Activating on a new machine without deactivating on the old one leaves
the old slot occupied, and the plan's device limit counts both.

The Keygen plugin this package is modelled on had the same property, and
it is a property of the licensing model rather than of the client.

## Rate limits and lockouts are the server's

The server counts failed `/license/*` calls per IP and locks the address
out after a handful of failures. A successful call clears the counter.

**What this means:** an app that retries a bad key in a loop can lock
its own address out. The client does not retry automatically — a failure
is reported once, and it is up to the app to decide.

`Retry-After` is on 429 answers. The client passes the server's code
through but does not act on the header; an app that wants to back off
should read `429` and wait.

## The client does not retry

No request is retried automatically. A `REQUEST_ERROR` is reported as
such.

This is deliberate: the activation endpoint takes a device slot, and a
blind retry could take two of them. The server's `Idempotency-Key`
header would make a retry safe, and this client does not send one —
activation is idempotent on the server for the same identifier, so a
retry of the same device is already safe, but the client leaves the
decision to the app.

## The `exp` clock and a rolled-back clock

A token issued further into the future than `maxClockDriftSeconds`
(default 300) is rejected. A clock rolled **back** cannot extend a
token's life indefinitely: `exp` is an absolute instant, so a clock set
back makes the token look younger and it expires later in real time only
by the amount the clock was moved.

The protection is bounded by the drift window, not absolute. A machine
whose clock is wrong by more than five minutes will refuse a valid
token.

## What was verified here, and where

**Verified by the automated suite, on this machine:**

- The signed-token format: a token produced by the reference server's
  signing rules verifies against the package's verification code, and a
  tampered payload, a wrong key and a malformed token all fail.
- The token's freshness rules: expiry, the grace window, the perpetual
  case, and the future-issued rejection.
- The API client's envelope handling, including the server's error codes
  passed through verbatim.
- The IPC contract: sender trust, main-frame-only, the trust list
  re-read per request, argument validation, and the envelope.
- The storage policy: no plaintext on disk, the vault probed before the
  network call, `basic_text` refused.
- Offline restoration across a simulated restart, with the network gone.

**Verified in a live Electron renderer:**

- The sandboxed preload installs `window.keygate` under `sandbox: true`,
  all eight channels are present, and the channels answer.

**Verified in a packaged Windows application:**

- The package installed from a tarball, inside an `app.asar`, with the
  preload loaded from inside the archive: the bridge is installed and all
  eight channels answer.
- The installed package carries only the built output. The `files`
  field decides what ships, and the test asserts the source tree does
  not.

**Not verified here:**

- macOS Keychain and Linux libsecret. The `safeStorage` behaviour was
  exercised through doubles, not on those platforms.
- A packaged installer (NSIS, MSI). The application was packaged
  unpacked, with `electron-builder --dir`; the asar layout is the same
  either way, but the installer's own behaviour was not exercised.
- The real Keygate server end to end. The protocol was reproduced
  faithfully against the server's own source — the envelope, the
  endpoints, the token format and the fingerprint definition — and the
  live suite exists (`npm run test:live`) but needs a real server and a
  real license key.
- Windows DPAPI against another process running as the same user.

## Not implemented on purpose

- **No payment or billing surface.** This package is a client.
- **No raw-request channel.** The renderer cannot make the client call
  an arbitrary endpoint.
- **No filesystem channel.** The renderer cannot read the cache.
- **No plaintext fallback.** A vault that cannot encrypt is a vault that
  cannot be used.
- **No weakening of signature verification.** A token that does not
  verify is never turned into a license.
- **No bypass of the offline window.** `exp` is honoured exactly.
