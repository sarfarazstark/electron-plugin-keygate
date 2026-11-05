# Documentation

The README is the front door: what the package is, how to install it, and
what each of the eight channels does. This folder is the longer form — the
reasoning behind the design, the security model, the rules of the offline
window, and how to verify an integration before shipping it.

Everything in this folder ships inside the package, so it is on disk after
`npm install` as well as on GitHub.

## Read this first

| If you are… | Start with |
| --- | --- |
| adding licensing to an app | [Getting started](getting-started.md) |
| reviewing the package before adopting it | [Security](security.md), then [Architecture](architecture.md) |
| writing a client against Keygate | [Offline](offline.md), then [Keygate vs Keygen](keygate-vs-keygen.md) |
| wiring up CI | [Testing](testing.md) |
| looking up a type, an option or an error code | [API reference](api.md) |
| looking for what is deliberately missing | [Known issues and limits](bugs.md) |

## The pages

### [Getting started](getting-started.md)

From `npm install` to a feature that unlocks only for a licensed customer:
configuration, the main process, the preload, the renderer, error handling,
and a table of the things that go wrong and what they mean.

### [Architecture](architecture.md)

Where the credential lives and why. The three processes, the eight channels,
what a call actually does between them, the storage layout, and the two
packaging rules that decide whether a packaged app finds the preload at all.

### [Security](security.md)

The threat model, one defence at a time, and what each one buys. Sender
trust, argument validation, the OS vault, the token signature, the device
binding — and the limits, stated plainly: what this package does **not**
protect against.

### [Offline](offline.md)

The signed token, field by field. Why a licence survives a restart with no
network, the two clocks the server keeps (`exp` and `vun`), the trap in the
signature scheme, and what happens when the server withdraws a licence that
is still cached.

### [Keygate vs Keygen](keygate-vs-keygen.md)

This package talks to **Keygate**. Keygen's plugin is an architectural
reference and nothing more — the two wire protocols are different, and a
Keygen-shaped detail in this code is a bug rather than a compatibility
feature.

### [Testing](testing.md)

The four layers of the test suite, the scripts that drive them, how to run
them against a live Keygate server, and a checklist for testing your own
integration before you ship it.

### [API reference](api.md)

Every export, every shape, every error code. The contract, rather than the
guide.

### [Known issues and limits](bugs.md)

The things that do not work, and the things that were left out on purpose.

## Keeping the docs honest

The README's table of contents is checked by `npm run check:readme`, which
recomputes every anchor from the headings — GitHub's own rule, including the
part where an emoji's variation selector stays in the URL.

```sh
npm run check:readme
```

The code in this package is the other half of the documentation: every
behaviour described here is covered by a test, and the live checks
([Testing](testing.md)) run against a real server and a real OS vault.
