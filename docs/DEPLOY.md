# Deploying myportfolio

One static binary in a `scratch` container, published through **Traefik**, deployed by **Portainer**
from a git-ops compose repo, image built and pushed to **GHCR** by GitHub Actions. TLS terminates at
Traefik. Pinned in [ARCHITECTURE.md §10](ARCHITECTURE.md).

Files: [`Dockerfile`](../Dockerfile), [`compose.yaml`](../compose.yaml),
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

---

## 1. The setting you have to get right

```
MYPORTFOLIO_TRUSTED_PROXIES=<the Traefik network's subnet>     # e.g. 172.20.0.0/16
```

This names the reverse proxies whose `X-Forwarded-For` the ceremony rate limiter may believe. **It
has no safe default for this topology, and both ways of getting it wrong fail silently** — nothing
logs, nothing 500s, the app looks fine:

| Value | What silently happens |
|---|---|
| **unset** (loopback-only default) | Every request arrives from Traefik, so **all users share one rate-limit bucket**. One person retrying a passkey throttles everybody. Correct for a directly-exposed binary; wrong here. |
| **too wide** — `10.0.0.0/8`, `172.16.0.0/12`, "any private address" | Any caller that can reach the app forges a fresh `X-Forwarded-For` per request and **the ceremony limiter stops existing**. This bypass has already been found in this codebase once (90 ceremonies through a limit of 30) and is regression-tested in `internal/server/rate_limit_test.go`. |
| **the Traefik network's subnet**, with no published container port | Correct. Each real client gets its own bucket; a forged header buys nothing. |

Read the value off the network Traefik actually runs on:

```bash
docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' <your-traefik-network>
```

Tighter alternative if your Traefik has a pinned address: give it the single IP instead of the
subnet (`MYPORTFOLIO_TRUSTED_PROXIES=172.20.0.5`, a bare address is accepted and treated as a /32).
That is strictly better, at the cost of breaking whenever Traefik's container is reassigned.

`compose.yaml` declares this variable with `${...:?}`, so **a stack missing it refuses to deploy**
rather than coming up quietly wrong:

```
error while interpolating services.myportfolio.environment.MYPORTFOLIO_TRUSTED_PROXIES:
required variable MYPORTFOLIO_TRUSTED_PROXIES is missing a value: set to the Traefik network
subnet (e.g. 172.20.0.0/16) or Traefik's container IP — never a blanket private range.
```

### Why "no published port" is part of the setting

`compose.yaml` deliberately has **no `ports:` section**. Trusting the Traefik network's subnet is
only honest while the *only* things that can reach the app are containers on that network. Publish a
port and every request on the internet arrives at the app from the bridge gateway's address — which
is inside the subnet you just told it to trust — and the limiter is a no-op again. If you add
`ports:` for debugging, narrow `MYPORTFOLIO_TRUSTED_PROXIES` to Traefik's exact IP first.

---

## 2. TLS, and why a proxy mistake looks like "passkeys are broken"

WebAuthn only runs in a **secure context**. On a non-loopback host that means real HTTPS. So a
proxy that terminates wrong does *not* show up as a browser TLS warning — it shows up as
**"passkeys don't work"**, with no error that points at the proxy. Budget for that when debugging a
signup that silently does nothing.

What `compose.yaml` sets up:

- The `websecure` router with a cert resolver, so the app is only served over TLS.
- A second router on `web` that **301s to HTTPS**, so the bare hostname lands on a secure context
  instead of a broken one.
- Traefik sets `X-Forwarded-Proto` itself; nothing needs configuring for that.

**HSTS comes from the app, not from Traefik.** `internal/server/server.go` sets
`Strict-Transport-Security: max-age=63072000; includeSubDomains` on every response, so there is no
HSTS middleware in the compose labels — one value, one place. Verified on a live response:

```
strict-transport-security: max-age=63072000; includeSubDomains
```

Health checks point Traefik's load balancer at `/readyz` (which probes the database) — unauthenticated
by design, as is `/healthz`. Neither needs credentials and neither should be swapped for an app route.

---

## 3. Persistence and backup — read this before you skip it

The named volume `myportfolio-data` holds `/data/myportfolio.db`, and that one file contains **both**:

- every account's **encrypted state blob**, credentials and envelopes; and
- the **session-signing secret** (`server_secrets.session_hmac`), which is generated on first boot
  rather than configured (`internal/store/vault.go`).

Consequences, stated plainly:

- **Lose the session secret → everyone is logged out.** Recoverable, annoying.
- **Lose the database → every vault is gone, permanently.** The server holds only ciphertext and
  never has the keys. There is no support path, no admin override, no "we restored it from our
  side". That is what zero-knowledge means. Users who still hold their passkey and recovery code
  have lost their server-side backup; users who were relying on the server for backup have lost
  everything.

So back the volume up, and check that the backup restores. The database is opened in WAL mode, so a
naive file copy of `myportfolio.db` alone can be torn — copy `myportfolio.db`, `-wal` and `-shm`
together from a stopped container, or use `sqlite3 ... ".backup"` / Litestream against a running one.

The container runs as UID 65532 and the image ships `/data` owned by that UID precisely so a fresh
named volume inherits it. If you ever restore files into the volume by hand, `chown -R 65532:65532`
them or the app crash-loops on `unable to open database file`.

---

## 4. One-time setup

**GitHub secret** — <https://github.com/korjavin/myportfolio/settings/secrets/actions>:

| Name | Value |
|---|---|
| `PORTAINER_REDEPLOY_HOOK` | The stack's webhook URL, from Portainer → your stack → *Webhooks*. |

If it is absent the workflow still builds, pushes and updates the `deploy` branch; it just logs that
nothing was redeployed.

**Portainer stack** — *Repository* type, pointed at this repo, and:

- **Branch: `deploy`. Not `master`.** `master` carries `image: ghcr.io/korjavin/myportfolio:latest`
  as a placeholder that is never published; `deploy` is rewritten by CI to the exact commit SHA that
  was built, so "what is running" always has a precise answer.
- Compose path: `compose.yaml`
- Enable the webhook.

**Portainer environment variables:**

| Variable | Required | Notes |
|---|---|---|
| `MYPORTFOLIO_TRUSTED_PROXIES` | **yes** | §1. Deploy fails without it. |
| `MYPORTFOLIO_HOST` | **yes** | Public hostname, e.g. `portfolio.example.com`. Deploy fails without it. |
| `TRAEFIK_NETWORK` | no | Defaults to `traefik`. Must be the external network Traefik is on. |
| `TRAEFIK_CERTRESOLVER` | no | Defaults to `letsencrypt`. Must match a resolver your Traefik defines. |

If GHCR rejects the pull, the package is private: either make it public, or add a registry
credential in Portainer for `ghcr.io`.

---

## 5. How a release flows

```
push to master (or a v* tag)
  └─ .github/workflows/release.yml
       ├─ build the image, push ghcr.io/korjavin/myportfolio:<sha>     (SHA only, never :latest)
       ├─ force-push `deploy` with compose.yaml pinned to that SHA
       └─ POST the Portainer webhook
             └─ Portainer pulls `deploy`, re-reads compose.yaml, recreates the container
```

CI (`.github/workflows/ci.yml`) is untouched and remains the correctness gate. The release workflow
only ships.

To roll back: point the Portainer stack at an earlier `deploy` commit, or edit the image tag in the
stack. The `deploy` branch is force-pushed, so its history is not a reliable log — GHCR's tag list is.

---

## 6. Running it locally

`master`'s `compose.yaml` references an image tag that is never published, so build it yourself:

```bash
docker build -t myportfolio:local .
docker run --rm -p 8080:8080 -v myportfolio-data:/data myportfolio:local
```

Leave `MYPORTFOLIO_TRUSTED_PROXIES` **unset** for that — with a published port and no proxy in
front, loopback-only is the correct setting, and setting anything wider is the bypass from §1.
WebAuthn works on `http://localhost` because loopback is a secure context.

---

## 7. What was verified, and how

Run on Docker 29.6.1 with Traefik v3.6 on an isolated `172.31.77.0/24` network, using the real
`compose.yaml` plus an overlay that changed only the image source (local build) and added Traefik
itself. Client containers were pinned to fixed IPs so Traefik genuinely observed distinct clients.

**Image.** Builds `CGO_ENABLED=0` to a `scratch` final stage: 5.3 MB, 4 layers, `USER 65532:65532`.

**Through the proxy** (HTTPS, Traefik's self-signed fallback cert):

```
HTTPS /healthz -> 200
HTTPS /readyz  -> 200   (strict-transport-security: max-age=63072000; includeSubDomains)
GET   /        -> 200   (3578 bytes, the PWA shell)
HTTP  /        -> 301   location=https://portfolio.localhost/
```

**Rate limiting per real client IP** — the acceptance criterion, driven from two apparent clients,
not read off the config. Limit is 30/minute.

```
MYPORTFOLIO_TRUSTED_PROXIES=172.31.77.0/24

client A  172.31.77.50   35 requests →  30 200,  5 429     budget spent
client B  172.31.77.51    8 requests →   8 200            separate budget, unaffected by A
client C  172.31.77.52   35 requests →  30 200,  5 429     rotating a forged X-Forwarded-For
                                                           and X-Real-IP per request bought
                                                           nothing: Traefik appends the address
                                                           it observed last, and that is the hop
                                                           the app keys on
```

Negative control, to prove the test can fail — same stack, `MYPORTFOLIO_TRUSTED_PROXIES=127.0.0.1/32`
(equivalent to leaving it unset):

```
client D  172.31.77.60   35 requests →  30 200,  5 429
client E  172.31.77.61    8 requests →   8 429            a different client, throttled by D's
                                                          traffic — the shared-bucket failure
```

**Persistence.** `docker compose down` (containers destroyed, volume kept) then `up`:

```
session secret before:  session_hmac|0E93F2D2C59D9B865E26A90FA7E2D2D06A8711FB75CEDE4A52643087B5BC52FA
new container id:       5b8f5ab4d146...
session secret after:   session_hmac|0E93F2D2C59D9B865E26A90FA7E2D2D06A8711FB75CEDE4A52643087B5BC52FA
volume ownership:       drwxr-xr-x 65532 65532 /data
```

**Not verified locally:** a real Let's Encrypt certificate (ACME cannot run on a laptop; the test
used Traefik's self-signed fallback), a full passkey ceremony end to end (no browser in the harness
— the limiter was exercised at `POST /api/webauthn/login/begin`, which is the rate-limited entry
point, but no credential was created), the GHCR push, and the Portainer webhook. Those need the
first real deploy.
