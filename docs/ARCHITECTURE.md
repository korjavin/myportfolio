# myportfolio — architecture

Local-first, offline-capable PWA for tracking investments (stocks / ETFs / crypto / cash).
A competitor to [Portfolio Performance](portfolio_performance_analysis.md) that is mobile-first
and syncs through a server that can never read your data.

Prior art we are deliberately reusing: `../medicationtrackerbot` shipped the passkey-PRF vault
and E2EE sync this app needs. Its [cloud-crypto.md](../../medicationtrackerbot/docs/cloud-crypto.md)
and [cloud-mode.md](../../medicationtrackerbot/docs/cloud-mode.md) are the normative references for
the key hierarchy; this document specifies only **what myportfolio does differently** plus the
portfolio-domain schema.

## Principles

1. **The app works with the network unplugged, forever.** No account required to use it. Signup is
   an opt-in step that adds backup + multi-device, nothing else.
2. **The server is dumb.** It stores one opaque encrypted blob per account plus WebAuthn material.
   It cannot read, merge, or interpret anything. (One deliberate exception: the opt-in quote proxy,
   §7.)
3. **No passphrases.** Unlock is a passkey ceremony; the only writable secret is the recovery code.
4. **Money is never a float.** §5.
5. **Lazy-correct.** Reuse `../medicationtrackerbot`'s modules verbatim where the logic is identical;
   change only the domain-separation labels and what this app genuinely needs differently.

## 1. Stack

Mirrors the sibling project: **vanilla ES modules, no bundler, no build step**, vendored Dexie for
IndexedDB. Domain modules are runtime-agnostic pure logic over injected ports (no `window`,
`document`, `fetch`, or `indexedDB` inside them) — same constraint that let medtracker's domain files
run unmodified under goja, and the reason the two tracks below can be built in parallel.

Server: Go, single static binary, `CGO_ENABLED=0`, SQLite. Lifted from `internal/cloudserver`.

## 2. Repo layout

```
web/
  static/            the PWA shell — UI, service worker, manifest
    js/core/         crypto.js, localdb.js, sync.js, store.js   ← ported from medtracker
    js/features/     holdings.js, transactions.js, performance.js, settings.js
    vendor/          dexie.min.js, chart lib
  domain/            PURE logic over the records port — portfolio.js, perf.js, quotes.js, ppimport.js
internal/
  server/            HTTP: webauthn, state blob, quote proxy
  store/             SQLite
docs/
```

## 3. The seam — the records port

**This is the contract between the two tracks. Neither track may change it unilaterally.**

Every domain module is a factory taking a `records` port and returning its API:

```js
export function createPortfolioDomain({ records, now }) { ... }
```

```js
records.list(recordType)              // → Promise<Record[]>   (excludes tombstones)
records.put(recordType, recordId, body) // → Promise<void>
records.del(recordType, recordId)       // → Promise<void>     (writes a tombstone, never a hard delete)
```

Stored record shape — the port owns these three fields, domain bodies never set them:

```js
{ recordId, recordType, clientTs, deleted: false, ...body }
```

Two implementations of the same port, chosen at boot:

| Implementation | Owner | Backing |
|---|---|---|
| `localRecords` | domain track | plaintext Dexie store, no server, no crypto — the offline-only mode |
| `vaultRecords` | vault track | the same Dexie mirror, plus encrypted state-blob sync (§6) |

A user who never signs up runs `localRecords` and is a complete, working app. Signing up migrates
the existing rows into the vault; nothing in `web/domain/` changes or even notices.

### clientTs is a merge token, not a wall clock

Learned the hard way in medtracker (bd med-d5t.6) and it matters more here, because the thing being
silently overwritten is a trade. Two guards, both client-side:

1. **Server-referenced time.** Every sync response carries a `Date` header. Store the offset in
   `sync_meta.clockSkewMs` and subtract it on every write, so all devices stamp on one scale.
2. **Per-record monotonic guard.** A write to a record this device can already see is stamped
   `max(correctedNow, existing.clientTs + 1)` — editing what you can see always beats what you are
   overwriting, whatever either clock says.

Neither orders two *blind concurrent* writes on skewed devices. Accepted; surfaced as a "this
device's clock is off by N minutes" warning past a 2-minute threshold.

## 4. Record types

Portfolio Performance's model, trimmed to what v1 needs. `recordId` is a client-generated
`<type>_<ms>_<rand>` string.

| type | body |
|---|---|
| `account` | `{ name, kind: "cash"\|"securities", currency, closed }` |
| `security` | `{ name, isin?, ticker?, currency, assetClass: "stock"\|"etf"\|"crypto"\|"bond"\|"commodity", quote: { provider, symbol } }` |
| `transaction` | `{ type, accountId, securityId?, date, shares?, amount, fees?, taxes?, currency, fx?, note?, counterAccountId? }` |
| `price` | `{ securityId, date, close }` — one record per security-day; historical quote series |
| `fx` | `{ pair: "EURUSD", date, rate }` |
| `settings` | singleton `recordId: "settings"` — `{ reportingCurrency, quoteProviders, ... }` |

`transaction.type` ∈ `buy`, `sell`, `dividend`, `deposit`, `removal`, `interest`, `fee`, `tax`,
`transfer_in`, `transfer_out`. This set is what makes PP import possible and TTWROR/IRR computable;
do not invent a "generic" transaction with a free-text kind.

Deferred to post-v1, do not build now: taxonomies/classification trees, rebalancing targets, bonds
with coupon schedules, options.

### Price series storage

`price` records are per-security-per-day and will dominate row count (10 securities × 5 years ≈ 18k
records). One record per day is correct for the port contract but wasteful in the blob. **v1 stores
them chunked: one `price` record per security-year**, body `{ securityId, year, closes: {"MM-DD": n} }`.
That keeps the record count in the hundreds and the LWW merge granularity at security-year, which is
fine because price history is append-mostly and refetchable.

<!-- ponytail: security-year chunking; if two devices backfill different date ranges of the same
     security-year offline, LWW loses one side's backfill (recoverable by refetching quotes).
     Upgrade path if that bites: merge `closes` maps key-wise instead of whole-record LWW. -->

## 5. Money is never a float

Fixed-point integers throughout, matching Portfolio Performance's scales so import is lossless and
round-trips:

| quantity | scale | example |
|---|---|---|
| amounts (cash, fees, taxes) | `1e2` | `€1234.56` → `123456` |
| shares | `1e8` | `0.00123456 BTC` → `123456` |
| prices | `1e8` | `$41.2350` → `4123500000` |
| FX rates | `1e8` | `1.0842` → `108420000` |

Every arithmetic path in `web/domain/` operates on these integers. Values become floats exactly once,
at the render boundary, and never flow back. Any function returning a currency amount as a JS number
in fractional units is a bug. The performance engine (TTWROR/IRR) is the one place ratios are real
floats — that is fine, they are ratios, not money.

## 6. Sync — the encrypted state blob

The server stores **one blob per account**, not an oplog. This is the "dumb server storing encrypted
backup-states" design and it is materially simpler than medtracker's oplog+snapshot: a portfolio has
a few thousand records and a handful of writes a day, so there is nothing to stream.

```
GET  /api/state            → 200 {version, nonce, ct} | 204 (none yet)
PUT  /api/state            body {version, nonce, ct}
                           → 204 | 409 {version, nonce, ct}   (version mismatch: caller is stale)
```

- `version` is a monotonic int the server increments; a `PUT` carries the version the client last
  read, so it is a compare-and-swap. No locks, no merge logic server-side.
- `ct = AES-GCM(K_data, gzip(utf8(JSON(records))), aad = encodeFields("mp/v1/state", accountId, version))`
  — gzip *before* encrypt, same as medtracker's snapshots (~10x smaller body).
- **On 409 the client merges and retries**: decrypt the returned remote blob, union with local by
  `recordId`, resolving each collision by higher `clientTs`; a tombstone is an ordinary record and
  wins or loses on `clientTs` like any other. Re-encrypt against the new version, `PUT` again.
  Bounded retry (5), then surface a real error — never a silent drop.
- **Rollback detection**: the client persists the highest `version` it has ever seen in
  `sync_meta`. A `GET` returning a lower version means the server served stale state (bug or
  malice) — refuse to apply it and warn. The AAD binds `version`, so the server cannot re-label an
  old blob as a new one, only replay the matched pair.
- Tombstones are retained indefinitely. At portfolio scale they cost nothing and dropping them
  resurrects deleted transactions on a device that was offline across the GC.

Writes are debounced (a few seconds) and coalesced; the blob is re-uploaded whole. A pull happens on
open and on focus.

## 7. Quotes

Default is **browser-direct with the user's own key** — the server never learns which tickers you
hold. Provider config and API keys live in the vault as `settings.quoteProviders`, never server-side.

- Crypto: CoinGecko (CORS-enabled, free tier works keyless).
- Stocks/ETFs: a CORS-enabled provider the user brings a key for (Finnhub / Twelve Data /
  Alpha Vantage). Yahoo Finance is **not** usable browser-direct — it blocks CORS.
- The document's CSP `connect-src` is an allowlist derived from the configured provider hostnames,
  per medtracker's per-account egress design — no bare `https:` wildcard anywhere, ever, because
  that is exactly the token that lets an XSS exfiltrate a decrypted portfolio.

**Opt-in proxy fallback**: `GET /api/quote?provider=&symbol=` for users with no key. It is gated
behind an explicit consent screen stating plainly that *the server will see which symbols you hold*.
Off by default, per-account flag, revocable. It is the only endpoint on the server that sees anything
meaningful, and it must never be silently enabled by any other flow.

Fetched quotes are written to `price` records, so **the last known price is always available
offline** and valuation never depends on the network.

## 8. Crypto — deltas from medtracker

The key hierarchy (passkey → PRF → KEK → envelope → DEK → K_data/K_mac), envelope format, recovery
code, device transfer, and revocation are **taken as-is** from
[cloud-crypto.md](../../medicationtrackerbot/docs/cloud-crypto.md). `web/cloud/js/crypto.js` ports
over near-verbatim. Four differences:

1. **Domain-separation labels change** `mt/v1/*` → `mp/v1/*`, and
   `salt_kek = SHA-256("myportfolio/v1/prf-kek")`. Different app, different key derivation — an
   envelope from one must never be openable by the other.
2. **Single origin, not per-account subdomains.** No wildcard DNS, no wildcard cert, no invite-only
   provisioning. Consequence for cold unlock: the client does not know `account_id` before the
   ceremony. The flow still costs exactly one assertion — `navigator.credentials.get()` with empty
   `allowCredentials` (discoverable credential) and `prf.eval = salt_kek`; the server verifies the
   signature and returns `{account_id, envelope}`; only then is
   `KEK = HKDF(prf, salt=account_id, info="mp/v1/kek" ‖ credential_id)` derived. PRF output never
   leaves the client, unchanged.
3. **No push, no NK, no inbox keypair, no MCP relay.** A portfolio tracker has no background
   notifications to decrypt, which deletes the single largest compromise in medtracker's design.
   Do not port `push.js`, `inbox*`, `mcp*`.
4. **No oplog** — §6 replaces `sync.js`'s ops machinery with the state blob. Keep its
   `deriveKData`/`encryptSnapshot`-shaped primitives, drop `encryptRecord`/seq handling.

Unchanged and non-negotiable: PRF capability is feature-detected at enrollment and a non-PRF
credential is deleted rather than enrolled; every ceremony is `residentKey: required`,
`userVerification: required`; the recovery code is 160-bit Crockford base32 with a checksum group;
envelope `mac` audit flags operator-forged credentials.

**Local at-rest posture is unchanged and must be stated to users honestly**: the E2EE boundary is the
server; locally, plaintext in IndexedDB is protected by device unlock and OS disk encryption, the
same as any local database. The LDK is non-extractable, which is a script-level guarantee, not
disk-forensics protection.

**The code-serving caveat applies to us too**: E2EE cannot protect against the origin serving
poisoned JavaScript. Mitigations in force: strict CSP, zero third-party script, SRI, versioned
immutable assets, service-worker-pinned bundles. Say so in the user-facing security note rather than
claiming a guarantee we do not have.

## 9. Tracks

Two tracks, disjoint file ownership, meeting only at §3.

**Track A — vault + server.** `internal/`, `web/static/js/core/crypto.js`, `unlock.js`, `signup.js`,
`vaultRecords`. Passkey signup/unlock, envelopes, recovery, device transfer, state-blob endpoints,
quote proxy.

**Track B — domain + UI.** `web/domain/`, `web/static/js/features/`, `localRecords`. Schema, the
portfolio engine (holdings, valuation, TTWROR, IRR), PP import, quote fetchers, the mobile-first
shell, service worker.

Track B ships a usable offline app without Track A existing. Track A plugs in underneath by swapping
the port implementation. Anything that needs to edit a file the other track owns gets queued, not
raced.
