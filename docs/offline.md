# Offline

How a licence survives a restart with no network at all — and what that
costs.

- [Why](#why)
- [The token](#the-token)
- [The signature](#the-signature)
- [The fields](#the-fields)
- [Two clocks](#two-clocks)
- [What happens at launch](#what-happens-at-launch)
- [The offline window](#the-offline-window)
- [When the server withdraws the licence](#when-the-server-withdraws-the-licence)
- [Deactivating](#deactivating)
- [Choosing a check-in interval](#choosing-a-check-in-interval)

---

## Why

A desktop app that stops working on a train is a bad desktop app. Keygate's
answer is not a checkout and not a machine file: the server issues a
**signed token** that carries its own lifetime, and the client verifies that
signature locally.

So the offline path is not a degraded mode. It is the same code, minus the
network call.

## The token

```
<base64url(payload-json)>.<base64url(ed25519-signature)>
```

base64**url**, without padding, and a single `.` as the separator. The
payload is Keygate's own short-field JSON.

## The signature

> **The signed bytes are the base64url payload string, not the JSON.**

This is the single most common integration mistake with Keygate, and it is
worth stating twice because it fails in a confusing way. The server signs
the *encoded* payload; the client verifies the *encoded* payload. Verifying
the decoded JSON instead fails against a real server on **every** token, and
the failure looks like a corrupt token rather than a mistake.

```ts
// Right — the bytes that were signed.
const ok = ed25519Verify(null, Buffer.from(encodedPayload, 'utf8'), publicKey, signature);

// Wrong — the same signature, over different bytes. Always fails.
const ok = ed25519Verify(null, Buffer.from(payloadJson, 'utf8'), publicKey, signature);
```

The client's Ed25519 public key comes from Node's crypto as an SPKI DER
blob, which means wrapping the server's 32 raw bytes in a fixed 12-byte
header:

```ts
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hexPublicKey, 'hex')]);
```

## The fields

| Field | Meaning |
| --- | --- |
| `lid` | the license id |
| `pid` | the product id |
| `pln` | the plan name |
| `sts` | the status the server recorded |
| `did` | the identifier the token was issued for |
| `ftr` | the feature map |
| `iat` | when the token was issued |
| `exp` | **the check-in interval** — how long the client may stay offline |
| `vun` | **the license term** — when the licence itself lapses; absent means perpetual |
| `grc` | grace days after `vun` |
| `upd` | the end of the maintenance period, for a perpetual licence |
| `nce` | a nonce |
| `fpr` | the device binding: `sha256(identifier + ":" + product_id)`, first 8 bytes, hex |

The client requires `lid`, `pid`, `pln`, `sts`, `did`, `iat`, `exp`, `grc`
and `nce` to be present, and `iat` and `exp` to be numbers. A token missing
one of them is refused with `BAD_TOKEN` rather than half-believed.

## Two clocks

The server keeps two lifetimes apart on purpose, and a client that
confuses them is either too strict or too lax.

- **`exp` — the check-in interval.** How long this client may stay offline
  before it has to verify again. This is the *offline window*.
- **`vun` — the license term.** When the licence itself lapses. Absent
  means perpetual.

The server clamps `exp` so it never outlives `vun` plus the grace days. The
client checks both anyway, in this order:

1. `iat` further in the future than the tolerated clock drift → **issued in
   the future** → refused.
2. Now past `vun` plus `grc` days → **licence expired** → refused.
3. Now past `exp` → **expired** → refused.

Step 2 is what a client that only honoured `exp` would miss: it would keep
a lapsed licence alive for the rest of the check-in window. The grace days
the server granted are the only thing allowed to extend the term.

## What happens at launch

Startup **never touches the network**. The service:

1. probes the OS vault — if it is unusable, the app starts unlicensed and
   says why;
2. reads the cached token;
3. resolves the public key — a pinned key always wins; otherwise the key
   **cached on disk** is used, because the machine may have no network and
   the server is deliberately not consulted here;
4. verifies the signature;
5. checks the freshness and the device binding;
6. restores the licence, with `offline: true` so the app can tell the
   difference between "the server confirmed this" and "this was restored
   from the cache".

`startupDiagnostic` says exactly which of those steps decided the outcome —
`restored`, `no-cache`, `no-public-key`, `bad-token`, `expired` or
`storage-unavailable`. It is deliberately **not** an IPC channel: it is a
main-process diagnostic, and a channel for it would put server detail in the
renderer.

## The offline window

The honest trade: **a licence withdrawn on the server stays valid offline
until the cached token's `exp` passes.**

The client cannot know what happened on the server while it is not talking
to it — that is what a signature is for. The window is the check-in
interval, and nothing else shortens it.

So the interval is a licensing decision, not a technical one:

| Interval | A withdrawn licence is honoured for | Good for |
| --- | --- | --- |
| 1 hour | up to an hour | metered, high-value licences |
| 24 hours | up to a day | most subscription software |
| 7 days | up to a week | licences bought once, rarely |
| 30 days | up to a month | perpetual licences with a maintenance period |

The server clamps the interval so it never exceeds the licence term plus
grace, so a short-lived licence cannot be configured into a long offline
window.

The server's default is **seven days**; a plan overrides it with
`token_ttl_days`.

The full list of limits, and what was verified where, is in
[Known issues and limits](bugs.md).

## When the server withdraws the licence

A `verify` that fails with `LICENSE_NOT_FOUND` **clears the cached token and
the cached key**.

Without that, the cached token would be restored on the next launch and the
app would keep running licensed on a licence the server had withdrawn —
until the token's own check-in interval ran out. Clearing the key as well
means the app asks for one again instead of retrying a key the server has
already rejected.

The clearing is deliberately narrow:

| Situation | What is cleared |
| --- | --- |
| `verify` fails `LICENSE_NOT_FOUND` for the cached key | the token **and** the key |
| `verify` fails for a *different* key | nothing — a customer trying a second licence keeps the one this device has |
| a lockout, a rate limit, a network failure | nothing |
| `deactivate` succeeds | the token; the key is kept |

The server answers `404 LICENSE_NOT_FOUND` for a licence that does not
exist, one that is suspended or revoked, and one where this device has no
activation — deliberately the same answer for all three, so the endpoint
cannot be used to probe which keys are real.

## Deactivating

`deactivate()` releases this device's slot so another machine can take it.
The cached token is cleared — the device is no longer activated, so it must
not keep the app licensed — and the **key is kept**, so the app can verify
again without asking the customer to retype it.

The server does not check the licence's status here. A suspended or expired
licence can still free its slots, which is exactly what makes this useful
for a customer moving machines.

## Choosing a check-in interval

The interval lives on the server, on the plan. Three things decide it:

- **How much a withdrawn licence costs you.** The window is the maximum
  time a customer keeps access after you cancel them.
- **How often the app talks to the server anyway.** An app that checks for
  updates hourly gains nothing from a 24-hour window.
- **How bad an outage is.** The window is how long the app keeps working
  when your server is down — which is usually the reason to want one at all.
