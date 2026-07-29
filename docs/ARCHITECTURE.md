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
export function createPortfolioDomain({ records }) { ... }   // `now` only where a module needs a clock
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

1. **Server-referenced time.** Every sync response carries a `Date` header. Store the offset as
   `clockSkewMs` and subtract it on every write, so all devices stamp on one scale.
   *As built*, that lives in a small device-local IndexedDB owned by `state-sync.js`, not in a
   `sync_meta` table inside the Dexie mirror — the mirror's schema belongs to `localdb.js`, and the
   sync layer adding a table to it would couple the two in the direction §3 exists to prevent. Same
   guarantee, different home.
2. **Per-record monotonic guard.** A write to a record this device can already see is stamped
   `max(correctedNow, existing.clientTs + 1)` — editing what you can see always beats what you are
   overwriting, whatever either clock says.

Neither orders two *blind concurrent* writes on skewed devices. Accepted; surfaced as a "this
device's clock is off by N minutes" warning past a 2-minute threshold.

**Ties must break deterministically.** When two records collide on the same `clientTs`, both devices
must pick the *same* winner — the choice is arbitrary, its determinism is not. Otherwise each device
keeps its own side, a merge that changes nothing locally never schedules a push, and the two sit on
permanently divergent data with nothing to detect it. `state-sync.js` compares canonical forms, which
costs nothing and is stable across devices.

**One vault per browser profile, for now.** `localdb.js` opens one un-scoped Dexie database per
origin, so a second account would land on the first account's records. `state-sync.js` stamps its
metadata with the owning `accountId` and refuses a mismatch *before touching the wire*, claiming the
mirror on open rather than on first successful sync — a vault used entirely offline never reaches the
network, so a guard that waits for a response is absent exactly when it is needed. That turns a
silent cross-vault upload into a loud stop; namespacing the mirror per account is the real fix.

## 4. Record types

Portfolio Performance's model, trimmed to what v1 needs.

**`recordId` is an opaque, stable, unique string.** Records created by the user get
`<type>_<ms>_<rand>`. Records **derived** from an external source get a deterministic id derived from
a stable upstream key (`<type>_pp_<hash-or-uuid>` for PP import). This is not a style choice: an
idempotent importer is impossible with a time-and-random id, because re-importing the same file
would mint new ids and silently double the portfolio. Nothing may parse or order by `recordId`; only
equality is meaningful.

| type | body |
|---|---|
| `account` | `{ name, kind: "cash"\|"securities", currency, closed }` |
| `security` | `{ name, isin?, ticker?, wkn?, currency, assetClass?: "stock"\|"etf"\|"crypto"\|"bond"\|"commodity", quote: { provider, symbol } }` |
| `transaction` | `{ type, accountId, securityId?, date, shares?, amount, fees?, taxes?, currency, fx?, note?, counterAccountId? }` |
| `price` | `{ securityId, year, closes: {"MM-DD": n} }` — chunked per security-year, see "Price series storage" below. `MM-DD` keys are zero-padded; unpadded keys sort wrong and lose the latest-close race |
| `fx` | `{ pair: "EURUSD", date, rate }` |
| `settings` | singleton `recordId: "settings"` — `{ reportingCurrency, quoteProviders, costBasisMethod, ... }` |

`transaction.type` ∈ `buy`, `sell`, `dividend`, `deposit`, `removal`, `interest`, `fee`, `tax`,
`transfer_in`, `transfer_out`. This set is what makes PP import possible and TTWROR/IRR computable;
do not invent a "generic" transaction with a free-text kind.

**Settled semantics** (these were ambiguous in the first draft and are now pinned — B1/B2 built
against them):

- **`accountId` is the account `amount` moves on, for every transaction type**, with no per-type
  branching. It is the *cash* leg, and it stays that way.
- **A position is keyed by `(accountId, securityId)`** — the securities account is modelled, so the
  same ETF held at two brokers is two positions with a portfolio-wide aggregate on top. This is what
  Portfolio Performance does, and matching it is what lets a PP import round-trip.
  Because `accountId` is the cash leg, a `buy`/`sell` names **both** accounts: `accountId` (cash out /
  in) and `portfolioId` (where the shares land / leave). Import and the UI must write both.
  <!-- Was security-keyed through B1/B2; g7e.11 restructures the fold. Anything reading a position
       must treat its identity as opaque rather than reconstructing it from securityId. -->
- **Cost basis method is selectable per portfolio**, `settings.costBasisMethod ∈ "fifo" |
  "moving_average"`, defaulting to `fifo`. Lots are tracked **always** — each buy opens a lot, each
  sell consumes them oldest-first — and the method chooses only how realized gain is *reported*.
  Tracking lots unconditionally is what makes the two views agree; deriving lots on demand from a
  moving-average fold is not possible, so the storage decision is not reversible later.
  FIFO is the default because it is what most EU tax authorities require for declaring capital gains,
  and a number that is merely indicative is the wrong default in a filing context.
- **`amount` is the cash that actually moves**, matching PP so import round-trips: on a buy it is
  gross + fees + taxes (what left the account); on a sell, gross − fees − taxes (what arrived).
- **Fees and taxes diverge, and that divergence is the reason they are separate fields.** Fees are a
  cost of acquiring or disposing the asset: capitalised into cost basis on a buy, deducted from
  proceeds on a sell — so they reduce the gain. Taxes are levied on the transaction, not part of what
  the asset cost: they leave cash but never touch the basis. So per security,
  `cost += amount − taxes` on a buy and `proceeds = amount + taxes` on a sell, while cash always
  moves by the full `amount`. This changes every realized-gain number, so it is pinned here rather
  than left to each module.
  <!-- ponytail: buy-side transaction taxes (stamp duty, FTT) are economically part of acquisition
       cost in several jurisdictions but are excluded from basis here, matching PP. Revisit per-
       jurisdiction if it ever matters; it needs a tax-treatment flag, not a semantics change. -->
- **A transfer is two records, one per leg** (`transfer_out` on the source, `transfer_in` on the
  destination), linked by `counterAccountId`. The counter account is **not** booked from the other
  leg's record — doing so double-counts. A UI that writes only one leg leaves the other account
  unmoved, so both legs are the writer's responsibility.
- **Security transfers (a `transfer_in`/`transfer_out` carrying `securityId`) are not representable
  in v1** — there is no way to express carried-over cost basis, and inventing one silently would
  corrupt every downstream gain number. The engine refuses them with an explicit issue rather than
  guessing. Tracked as a real gap for a PP competitor.

### Settled while building the importer

- **`assetClass` is optional.** Portfolio Performance has no per-security asset class, so an imported
  security has none. Absent means *unclassified* and the UI says so. Do not infer a class from the
  security's name — a wrong asset class silently mis-buckets an allocation chart, and a guess is
  worse than a blank because it looks like knowledge.
- **`wkn` is carried** alongside `isin`/`ticker`. It is a real identifier PP users have, and dropping
  an identifier breaks re-import matching.
- **A negative `amount` is legal only on the cash-only types** — `fee`, `tax`, `interest` — where it
  means the flow runs the other way. That is how PP's `FEES_REFUND`, `TAX_REFUND` and
  `INTEREST_CHARGE` are represented, and it is why cash balances come out right without inventing
  three new record types. A negative `amount` on `buy`, `sell`, `deposit`, `removal` or `dividend`
  is a **data error to surface**, not a reversal — those types have a defined direction and
  `CASH_SIGN` already carries it. Any reinterpretation of a source type must appear in the import
  report; it must never be silent.

### Time conventions — pinned, because every return number depends on them

Settled while building the performance engine. All three are load-bearing; the UI must not re-decide
them. Full rationale lives in the header of `web/domain/perf.js`.

- **Days are UTC calendar days.** A date is the first 10 characters of a record's `date`, read as a
  UTC day. All day arithmetic goes through `Date.UTC`; nothing constructs a local-time `Date` or
  calls `new Date()` with no argument, so no result moves when the machine's timezone does. A string
  that is not a real calendar day is rejected, never silently rolled forward. The sibling project's
  entire timezone bug class came from implicit local dates.
- **A range `[from, to]` is inclusive at both ends.** So the opening valuation is the close of the
  day *before* `from`, and a transaction dated `from` is inside the range. This is the reading a date
  filter on the transaction list gives — "2024 performance" contains every 2024 transaction.
- **Money in at the start of its day, money out at the end**, so every unit of capital is at risk for
  the whole of each day it is present: `factor = (value(d) + outflow(d)) / (value(d−1) + inflow(d))`.
  This is the only timing convention that stays defined at both ends of a position's life — "all
  flows at end of day" divides by zero on the day a position opens, and "all flows at start of day"
  gives a negative denominator on the day one closes at a profit. Daily closes carry no intraday
  information, so this is a convention; it is stated rather than buried. Flows are **netted per day**
  before the formula is applied, so a same-day matched transfer pair cannot dilute the return.

**External vs internal flows**: a flow is external if it crosses the portfolio boundary (`deposit`,
`removal`). Transfers between the user's own accounts are *not* excluded as internal — `portfolio.js`
genuinely reports the total dropping while a transfer is in flight, so excluding the flow prints a
phantom loss. Both directions are regression-tested.

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

Fixed-point integers throughout, matching Portfolio Performance's scales so import round-trips:

| quantity | scale | example |
|---|---|---|
| amounts (cash, fees, taxes) | `1e2` | `€1234.56` → `123456` |
| shares | `1e8` | `0.00123456 BTC` → `123456` |
| prices | `1e8` | `$41.2350` → `4123500000` |
| FX rates | `1e8` | `1.0842` → `108420000` |

**Amounts, shares and prices import from PP exactly** — those are its own scales. **FX rates are the
one exception and the claim of losslessness does not extend to them**: PP stores `<exchangeRate>` as
an arbitrary-precision `BigDecimal`, so quantising to `1e8` genuinely rounds. The residual is ≤1e-8
relative, far below a cent on any realistic amount, but it is a rounding and the doc should not
pretend otherwise. If a use case ever needs exact FX round-tripping, that needs a wider scale or a
rational representation — not a bug fix.

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
  **Wire contract, both fields pinned:** `version` in the AAD is the version this blob **will be
  stored as** — i.e. the version last read plus one, which CAS makes deterministic — not the version
  it was read at. And it is encoded as a **fixed 8-byte big-endian integer**, following the sibling's
  `encodeSeq` precedent; passing a JS number to `encodeFields` would silently stringify it and make
  the two sides disagree at the first three-digit version. Pinned in
  `web/static/js/core/tests/vectors.json`.
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
poisoned JavaScript.

*In force*: strict CSP, zero third-party script, versioned immutable assets, and a service worker
that stages a new version in a separate cache, never swaps code mid-session, and prompts before
applying an update.

*Not in force, and previously claimed here in error*:

- **Subresource integrity.** Our scripts load as ES modules and `integrity` does not apply to module
  specifiers; the vendored Dexie is a side-effect `import`, so there is no `<script integrity=…>` to
  attach. Adding SRI would mean changing the loading path, not adding an attribute.
- **Consent that actually pins code.** Declining the update prompt does not keep the old version
  forever: close every window and the staged worker activates anyway. The real property is *no swap
  mid-session, plus a prompt while you are looking* — a narrowed window, not a veto. The obvious
  mechanism (the worker refuses to serve past an `acceptedVersion`) does not bind the adversary this
  section names, because the origin serves `sw.js` too, so a hostile build simply ships a worker
  that ignores it.

State this precisely in the user-facing security note. Claiming a mitigation we do not have is worse
than the gap itself, because it is the claim a reader would rely on.

## 9. Frontend design system — Wandergeek, ported

We reuse the sibling project's visual system wholesale rather than inventing one. It is already
mobile-first, token-driven, self-hosted-font, and — the part that actually matters — **enforced by
architecture tests**, which is why it has not rotted across a year of feature work. Source of truth
for the original: `../medicationtrackerbot/docs/frontend.md` §Design Tokens and §Navigation.

**Port**: the `--wg-*` token system (palette / semantic / gloss material / status tags / typography /
dimensional / chart theme), the self-hosted fonts (JetBrains Mono for display + numerics, Space
Grotesk for UI body), and the domain-neutral primitives — `wg-bottom-nav`, `wg-icons`,
`wg-sparkline`, `wg-stale-badge`, `wg-toggle`, `wg-ring`, `stat-card`, `empty-state`, `action-row`,
`wg-phone-chrome`.

**Drop**: every medication-domain token group and component — `--wg-bp-*`, `--wg-food-*`,
`--wg-meds-*`, `--wg-med-*`, `--wg-health-*`, `--wg-workouts-*`, `--wg-weight-*`, `--wg-settings-*`,
`--wg-next-*`, gamification/rings/journey, and the per-domain chart components. Do not copy
`styles.css` wholesale — it is 316 KB and roughly half of it is another app's screens.

**Conventions that carry over unchanged** (they are load-bearing, not stylistic preference):

- **No hardcoded colors in CSS, no inline `.style.` in JS, no `--wg-*` token referenced from JS.**
  JS sets class names; CSS resolves values. Narrow structural exceptions (e.g. `--wg-nav-cols` on the
  nav grid) go in an explicit allowlist, one file at a time, with a justification.
- **Bottom nav is the canonical navigation.** One slot per real section, no "More" aggregator, no
  section-header banners — screens sit directly on the stage and the active nav pill is the screen
  indicator.
- **Primary actions render inline** with the tab strip / range selector / day navigator, as a
  `.wg-toolbar-btn--primary` pill. Never a floating FAB, never a bottom CTA dock. The sibling project
  tried both and retired them.
- **Shared modal shell** (`.wg-modal` + `__header`/`__title`/`__body`/`__actions`) and field
  utilities (`.wg-field`, `.wg-label`, `.wg-input`, `.wg-select`) — new screens reuse these rather
  than introducing per-section variants.
- **Shared chart theme tokens** (`--wg-chart-card-*`, `--wg-chart-guide-*`, `--wg-chart-axis-tick-*`)
  — every chart consumes these instead of reintroducing per-chart colors. This matters more here than
  it did there: a portfolio app is mostly charts.
- **Self-hosted fonts only.** No external font CDN — it would punch a hole in the `connect-src`
  allowlist (§7) that the whole XSS-exfiltration argument depends on.

**Port the enforcement, not just the CSS.** The architecture tests are what make the above survive
contact with feature work: design-tokens, inline-styles, wg-primitives, chart-theme,
no-external-fonts-in-html, no-inline-handlers. A design system without its guard tests degrades to
suggestions within a month. (`domain-purity` and `sw-precache` are listed in the original but have
nothing to bind to until the PWA shell exists — they land with §B6, not here.)

Nav slots for this app: **Dashboard, Holdings, Transactions, Performance, Settings** — five, so the
bottom nav is one row and `--wg-bottom-nav-reserved` is 106px, not the sibling's two-row 160px.

### Gain and loss — the one token group the sibling could not supply

The sibling's status vocabulary is severity-shaped (`normal`/`high`/`alert`) because it is a health
app. A portfolio app's most-repeated visual signal is **gain vs. loss**, on essentially every row,
tile and chart. Added as semantic triplets aliased onto the existing tag colours so no new hue enters
the palette: `--wg-{gain,loss,flat}-{bg,fg,border}`. Chart series tokens resolve to the same pair, so
a negative performance line and a losing holdings row agree by construction.

**Gain/loss is never encoded by colour alone, and this is enforced, not advised.**
`.wg-delta--gain/--loss/--flat::before` emits ▲/▼/— from CSS, and
`architecture.wg-primitives.test.js` fails if a glyph is removed — so a screens author cannot forget
it and a later "cleanup" cannot quietly delete it. `.wg-delta--bare` drops the pill chrome for dense
table cells but keeps the glyph. Red/green alone is the standard finance-UI accessibility failure and
it fails for roughly 1 in 12 men; a convention would have decayed, a guard test does not.

### Guard scope is deliberately stricter here than in the sibling

Two guards were widened during the port, and **frontend executors should expect them to bite**:

- **`inline-styles` covers every file and its allowlist is empty.** The sibling narrowed this guard to
  ~8 files because it had years of pre-reskin inline styles to grandfather in. This codebase has no
  legacy, so there is nothing to grandfather. Set class names; let CSS resolve values. If you think
  you need an exception, you almost certainly need a CSS class.
- **`no-external-fonts` covers every `.html` **and** `.css`**, not just `index.html`, and also asserts
  that the woff2 files `fonts.css` names actually exist. The narrower version would not have caught
  an `@import url(https://fonts.googleapis.com/…)` inside a stylesheet — and a guard that only bans
  the CDN in one file is half a guard.

### Assets are served from the root, not `/static/`

`web/embed.go` does `//go:embed static`, which **roots the served filesystem at `web/static`**. So an
asset stored at `web/static/css/styles.css` is served from **`/css/styles.css`** — writing
`/static/css/styles.css` gives a 404.

Two files have already shipped with the wrong prefix by two different authors, so this is a
documentation defect rather than carelessness — and, worse, **neither failure was visible at
runtime**: `fonts.css` 404'd every glyph while `font-display: swap` quietly kept the fallback, and
`design.html` rendered unstyled for as long as it existed. `architecture.asset-paths.test.js` now
resolves every `href`/`src`/`url()` in every shipped `.html` and `.css` against the embedded tree, so
a missing asset fails the build instead of degrading silently.

Legacy colour names (`--bg-color`, `--text-color`, `--hint-color`, `--secondary-bg-color`) are kept
as *names* but now resolve onto the Wandergeek palette. That let the ported utility blocks carry over
byte-identical instead of being rewritten. The sibling's Telegram theme-mirror tokens
(`--tg-theme-*`) are gone — there is no Telegram host here.

## 10. Deployment — Docker behind Traefik

Target topology: the single static binary in a container, published through **Traefik**, managed by
**Portainer** with a git-ops compose repo and a GHCR image build. TLS terminates at Traefik.

**The one setting that must be right, because getting it wrong is silent**: the ceremony rate
limiter keys on the client IP, and behind a proxy every request arrives from the proxy. So
`MYPORTFOLIO_TRUSTED_PROXIES` **must** name Traefik's address on the Docker network — the default is
loopback-only, which is correct for a directly-exposed binary and wrong here (every user then shares
one bucket, so one client's retries throttle everybody).

It must **not** be widened to "any private address". With a published container port, every request
on the planet arrives from the bridge gateway's private address, so trusting that range lets any
caller forge a fresh bucket per request and the limiter stops existing. That failure has already
been found and fixed once in this codebase; it is regression-tested, and the test is why the
configured-peer design exists at all.

Also required at the edge: HSTS, and `X-Forwarded-Proto` set by Traefik so the app knows it is
behind TLS. WebAuthn requires a secure context — no ceremony works over plain HTTP on a non-loopback
host, so a misconfigured proxy presents as "passkeys don't work", not as a TLS warning.

## 11. Tracks

Two tracks, disjoint file ownership, meeting only at §3.

**Track A — vault + server.** `internal/`, `web/static/js/core/crypto.js`, `unlock.js`, `signup.js`,
`vaultRecords`. Passkey signup/unlock, envelopes, recovery, device transfer, state-blob endpoints,
quote proxy.

**Track B — domain + UI.** `web/domain/`, `web/static/js/features/`, `web/static/css/`,
`web/static/js/components/`, `localRecords`. Schema, the portfolio engine (holdings, valuation,
TTWROR, IRR), PP import, quote fetchers, the ported design system (§9), the mobile-first shell,
service worker.

Track B ships a usable offline app without Track A existing. Track A plugs in underneath by swapping
the port implementation. Anything that needs to edit a file the other track owns gets queued, not
raced.
