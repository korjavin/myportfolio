# myportfolio

A local-first, offline-capable PWA for tracking investments — stocks, ETFs, crypto and cash.
Mobile-first, and built so the server can never read your data.

**Status: early. Under active construction, not yet usable.**

## What it is

[Portfolio Performance](https://www.portfolio-performance.info/) is the open-source benchmark for
investment tracking: mathematically rigorous, completely local, and a heavy Java desktop app with no
web version and poor mobile support. myportfolio aims at the same rigor with the opposite form
factor — an installable web app that works with the network unplugged and syncs through a server
that only ever sees ciphertext.

- **Works offline, always.** No account is required to use it. Your data lives in IndexedDB on your
  device. Signing up adds backup and multi-device sync; it adds nothing else.
- **No passwords.** Unlock is a passkey ceremony (Face ID / fingerprint / device PIN). The key that
  encrypts your data is derived from the passkey via the WebAuthn PRF extension and never leaves
  your device. The only thing you can write down is a high-entropy recovery code.
- **The server is dumb.** It stores one opaque encrypted blob per account. It cannot read, merge or
  interpret anything in it. A full database breach yields ciphertext.
- **Your holdings stay yours.** Price quotes are fetched browser-direct with your own API key by
  default, so the server never learns which tickers you own. A proxy exists for users without a key,
  off by default and behind an explicit consent screen that says exactly what it leaks.

## Honest limitations

- **Web-delivered cryptography has a ceiling.** End-to-end encryption protects data at rest and in
  transit, but it cannot protect against the origin serving poisoned JavaScript. In force today:
  strict CSP, zero third-party script, versioned immutable assets, and a service worker that will
  not swap code mid-session and prompts before applying an update. **Not** in force: subresource
  integrity — our scripts are ES modules, and `integrity` does not apply to module specifiers.
  And the update prompt narrows the window rather than closing it: declining it does not pin the
  old code forever, because the origin also serves the service worker. This is a real residual
  risk, not a solved problem. See `docs/ARCHITECTURE.md` §8.
- **Locally, your data is protected by your OS**, not by us — the same posture as any local
  database.
- **Lose every passkey and the recovery code and the data is gone.** That is what zero-knowledge
  means. Onboarding pushes a second credential hard for this reason.

## Architecture

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the normative contract — record schema,
fixed-point money, the sync protocol, the crypto, and the design system. Read it before changing
anything.

Vanilla ES modules, no bundler, no build step. Go server, single static binary, SQLite.

## Development

```sh
go build ./... && go test ./...   # server
cd web && node --test             # domain, crypto, and architecture guard tests
```

The guard tests are load-bearing, not hygiene: they enforce that domain modules stay pure, that no
colour is hardcoded, that no gain/loss indicator is encoded by colour alone, and that fonts are never
loaded from a CDN. If one bites you, it is usually right.

Issue tracking uses [beads](https://github.com/gastownhall/beads) (`bd ready`, `bd show <id>`).

## Deployment

A `scratch` container behind Traefik, deployed by Portainer, image built to GHCR by
`.github/workflows/release.yml`. [`docs/DEPLOY.md`](docs/DEPLOY.md) is the operator guide.

Two things there are not optional reading. **`MYPORTFOLIO_TRUSTED_PROXIES` must name the Traefik
network** — left at its default every user shares one rate-limit bucket, and widened to "any private
address" the ceremony rate limiter stops existing; neither failure logs anything. And the named
volume holds both the SQLite database and the session secret, so **losing it destroys every vault
irrecoverably** — the server only ever had ciphertext, so there is no restore path on our side.

## License

MIT — see [LICENSE](LICENSE). Vendored components and their terms: [THIRD-PARTY.md](THIRD-PARTY.md).
