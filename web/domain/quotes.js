// Quotes — live prices without telling any server what you hold.
// ARCHITECTURE.md §7 is normative for this file.
//
// The whole point: fetches go **browser-direct with the user's own key**, so
// our server never sees a ticker. That is the differentiator against
// Capitally/Ghostfolio, and it is why there is no proxy here. (An opt-in proxy
// is a separate, off-by-default feature behind an explicit consent screen —
// myportfolio-18h.8. Not this module.)
//
// THERE IS ONE REQUEST TO OUR OWN ORIGIN, and it keeps that property rather than
// bending it (myportfolio-18h.19): GET /api/quotes/universe. It takes no
// parameters and answers with one blob covering a FIXED symbol list, identical
// for every caller, which this module filters to the securities it holds — so
// the server cannot learn a holding, because every client sends the same
// request. It is tried FIRST because it needs no API key at all, and anything it
// misses falls through to the user's own provider exactly as before. A universe
// that is down, empty or stale is not an error anywhere: it is a fallthrough.
//
// Pure module: no window/document/indexedDB, and the HTTP transport arrives as
// an injected `http` port rather than a global (ARCHITECTURE.md §1 and the
// domain-purity guard test). That is also what makes this testable with
// recorded provider payloads and no network.
//
// Everything fetched lands in `price` records (§4), chunked per security-year
// with zero-padded "MM-DD" keys, at the §5 fixed-point price scale of 1e8. So
// valuation never depends on the network: portfolio.js reads only what is
// already stored, and a provider that is down, throttled or slow degrades to
// the last cached close. `refresh()` therefore never throws — it reports.

import { RECORD, SETTINGS_ID } from './schema.js';
import { DECIMALS, parseFixed } from './money.js';

// The complete set of hosts this module will ever contact. Hardcoded and
// exported so the CSP `connect-src` allowlist (myportfolio-18h.9) can be
// derived from it — §7 forbids a bare `https:` wildcard, which is exactly the
// token that would let an XSS exfiltrate a decrypted portfolio. Nothing here
// builds a hostname out of user input; only the query string carries it.
export const QUOTE_HOSTS = Object.freeze({
  coingecko: 'api.coingecko.com',
  twelvedata: 'api.twelvedata.com',
});

// Provider choice, §7. CoinGecko for crypto: CORS-enabled and the free tier
// works with no key. Twelve Data for stocks/ETFs, of the three §7 candidates,
// because it is the only one whose free tier still serves daily history from
// the same endpoint as the latest close (Finnhub moved `/stock/candle` behind
// its paid tier; Alpha Vantage's free quota is 25 requests/day, which one
// refresh of a small portfolio would exhaust) and because it takes
// comma-separated symbols, so N holdings cost one round trip.
//
// A third provider is a third entry in this table plus its own `load`. It is
// deliberately not an adapter framework.
const PROVIDERS = {
  coingecko: {
    host: QUOTE_HOSTS.coingecko,
    needsKey: false,
    // market_chart is single-coin, so one request per holding.
    batch: 1,
    // Keyless callers are throttled hard; ~24 requests/minute is under every
    // published free-tier ceiling.
    minIntervalMs: 2500,
    load: loadCoinGecko,
  },
  twelvedata: {
    host: QUOTE_HOSTS.twelvedata,
    needsKey: true,
    // The free tier bills one credit per symbol and allows 8 credits/minute, so
    // a batch is capped at 8 and successive batches wait out the minute. A
    // portfolio of 8 or fewer stocks is a single request with no delay at all.
    batch: 8,
    minIntervalMs: 60_000,
    load: loadTwelveData,
  },
};

// The pre-fetched universe (myportfolio-18h.19). A PATH, not a host: it is our
// own origin, which the CSP already admits as 'self', so this deliberately does
// NOT belong in QUOTE_HOSTS — adding it there would widen connect-src for
// nothing.
export const UNIVERSE_PATH = '/api/quotes/universe';

const ISO_DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// UTC day of an epoch-ms instant. §4's time convention is UTC calendar days and
// toISOString is always zero-padded — an unpadded "MM-DD" key sorts above every
// well-formed one ("2024-3-15" > "2024-12-31") and silently wins the
// latest-close race, a bug this project has already fixed once.
function utcDay(ms) {
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return ISO_DAY_RE.test(iso.slice(0, 10)) ? iso.slice(0, 10) : null;
}

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : lo);

// `quote.provider` and `quote.symbol` are user data, so every lookup keyed by
// them is an own-property lookup. A plain `PROVIDERS[p]` would happily resolve
// "constructor" to a truthy function and then read `undefined` batch sizes off
// it, which is an infinite loop, not a config error.
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

// Identity of a §4 price chunk. One helper rather than two call sites building
// the same string, because the two disagreeing silently is a second chunk for
// the same security-year and a lost merge. The separator cannot occur in a
// recordId or a year.
const chunkKey = (securityId, year) => `${securityId}\u0000${year}`;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// The one boundary where a provider's float (or decimal string) becomes a §5
// fixed-point integer at 1e8. Nothing downstream sees the float again.
//
// A zero, negative or unparseable price is not a quote, it is a bad payload:
// letting one through would silently value a position at nothing. Such a point
// is dropped rather than thrown on, so one bad row cannot cost a security its
// whole series — and a series that ends up empty is reported as an error.
function priceUnits(raw) {
  try {
    const units = parseFixed(raw, DECIMALS.price);
    return units > 0 ? units : null;
  } catch {
    return null;
  }
}

// createQuotesDomain — ARCHITECTURE.md §3 factory over injected ports.
//
//   records    the §3 records port
//   http       fetch-shaped: (url, { headers, signal }) => Promise<Response>.
//              Injected, never reached for globally; the browser passes
//              `(u, i) => window.fetch(u, i)` and tests pass a recorded double.
//   now        clock, ms
//   timeoutMs  per-request deadline. Not optional: a bare request hangs forever
//              on a half-open connection — a captive portal, not clean airplane
//              mode — and that is the difference between "prices are stale" and
//              "the app is frozen".
//   universe   try the keyless pre-fetched universe before the user's provider.
//              On by default; the ONE caller that turns it off is ?demo=1, whose
//              fixture carries its own deterministic price history and must never
//              show real market prices against invented share counts
//              (ARCHITECTURE.md §12).
export function createQuotesDomain({ records, http, now = Date.now, timeoutMs = 10_000, universe = true }) {
  if (typeof http !== 'function') throw new TypeError('quotes: an http port is required');

  // Enforced two ways on purpose. The signal is what a real transport honours
  // and what frees the socket; the race is what keeps a transport that ignores
  // its signal — a buggy polyfill, a service worker, a bad double — from
  // wedging the refresh anyway.
  async function getJson(url, headers) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([http(url, { headers, signal: ctrl.signal }), deadline]);
      if (!res || typeof res.json !== 'function') throw new TypeError('http port returned no response');
      // The body is raced too: a response that never finishes streaming hangs
      // just as thoroughly as one that never arrives.
      let body = null;
      try {
        body = await Promise.race([res.json(), deadline]);
      } catch (err) {
        // An error response is often not JSON at all, and its status code is
        // the useful part. A timeout is never swallowed this way.
        if (ctrl.signal.aborted || res.ok) throw err;
      }
      if (!res.ok) throw providerError(providerMessage(body) || `HTTP ${res.status}`, body, res.status);
      if (body === null || typeof body !== 'object') throw new TypeError('malformed provider response');
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  // Per provider, not global: a rate limit belongs to the provider that imposes
  // it. Sharing one timestamp would make a CoinGecko request that just returned
  // hold Twelve Data's first batch for its whole 60-second interval, so a
  // portfolio holding both crypto and stocks would stall for a minute it does
  // not owe anyone.
  const lastRequestAt = new Map();
  async function pace(name, minIntervalMs) {
    const wait = (lastRequestAt.get(name) ?? 0) + minIntervalMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt.set(name, now());
  }

  // refresh — fetch the last `days` daily closes for every configured security
  // and merge them into the `price` chunks.
  //
  //   securityIds  optional allowlist; default is every security
  //   days         1 (the default) is "just bring the latest close current";
  //                larger backfills history from the same endpoint, so there is
  //                no separate historical code path to drift out of sync
  //
  // Every security routes to its own provider through `security.quote.provider`
  // (§4) and reads that provider's config out of the `settings.quoteProviders`
  // map by name. So a user with only CoinGecko configured still gets their
  // crypto priced, and their stocks come back as a clean `no_api_key` skip —
  // there is no notion of "the one active provider" anywhere in here.
  //
  // Returns { updated, skipped, errors } and never throws: a dead provider must
  // degrade to cached prices with a staleness signal, never an error screen.
  // The staleness signal itself is `position.priceDate` from portfolio.js —
  // the caller compares it to today; a security appearing in `errors` says the
  // number on screen did not get refreshed just now.
  //
  //   skipped[].reason  no_quote_config | unknown_provider | no_api_key
  //   errors[].code     bad_api_key | rate_limited | fetch_failed | no_closes
  //   fetchedAt         ms, or null when nothing landed
  async function refresh({ securityIds = null, days = 1 } = {}) {
    const updated = [];
    const skipped = [];
    const errors = [];

    const [securityRecs, settingsRecs, priceRecs] = await Promise.all([
      records.list(RECORD.security),
      records.list(RECORD.settings),
      records.list(RECORD.price),
    ]);

    const settings = settingsRecs.find((r) => r.recordId === SETTINGS_ID) || {};
    // §7: provider config and API keys live here, in the vault. Never
    // server-side, and never anywhere this module would log them.
    const quoteProviders = settings.quoteProviders || {};

    // The §4 chunks that already exist, keyed by security-year, so a refresh
    // merges into them instead of minting a second chunk for the same year.
    // Lowest recordId wins if there somehow are two, so the choice is stable.
    const chunks = new Map();
    for (const rec of priceRecs) {
      const key = chunkKey(rec.securityId, rec.year);
      const seen = chunks.get(key);
      if (!seen || rec.recordId < seen.recordId) {
        chunks.set(key, { recordId: rec.recordId, closes: { ...(rec.closes || {}) } });
      }
    }

    const wanted = securityIds ? new Set(securityIds) : null;
    const pending = []; // [{ securityId, symbol, currency, provider }]

    for (const sec of securityRecs) {
      if (wanted && !wanted.has(sec.recordId)) continue;
      const { provider, symbol } = sec.quote || {};
      if (!provider || !symbol) {
        skipped.push({ securityId: sec.recordId, reason: 'no_quote_config' });
        continue;
      }
      if (!own(PROVIDERS, provider)) {
        skipped.push({ securityId: sec.recordId, reason: 'unknown_provider', provider });
        continue;
      }
      pending.push({
        securityId: sec.recordId,
        symbol: String(symbol),
        currency: sec.currency || settings.reportingCurrency || 'USD',
        provider,
      });
    }

    // The universe pass, before any provider is touched: it needs no key, so
    // whatever it covers costs the user nothing and spends none of their quota.
    // Everything it misses drops through to the provider loop below unchanged —
    // that is the fallback the design leans on, not a degraded mode.
    //
    // Only for `days === 1`. The blob carries ONE close per symbol, so a caller
    // asking for history is asking for something it cannot answer, and quietly
    // satisfying the latest day would then suppress the backfill.
    const remaining = universe && days === 1 && pending.length > 0
      ? await applyUniverse(pending, chunks, updated)
      : pending;

    const targets = new Map(); // provider name -> [{ securityId, symbol, currency }]
    for (const t of remaining) {
      if (!targets.has(t.provider)) targets.set(t.provider, []);
      targets.get(t.provider).push(t);
    }

    for (const [name, list] of targets) {
      const provider = PROVIDERS[name];
      const config = own(quoteProviders, name) || {};
      const apiKey = config.apiKey || null;
      if (provider.needsKey && !apiKey) {
        // The user's own key or nothing. There is deliberately no fallback that
        // would route this through our origin.
        for (const t of list) skipped.push({ securityId: t.securityId, reason: 'no_api_key', provider: name });
        continue;
      }

      const batches = chunk(list, provider.batch);
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        await pace(name, config.minIntervalMs ?? provider.minIntervalMs);
        let closes;
        try {
          closes = await provider.load({ batch, apiKey, days, getJson });
        } catch (err) {
          // Errors carry provider + symbol so the user can fix a bad config,
          // and never the request URL — the URL is where the API key is.
          const code = errorCode(err);
          const message = messageOf(err);
          const fail = (t) => errors.push({ securityId: t.securityId, provider: name, symbol: t.symbol, code, message });
          batch.forEach(fail);
          // A rejected key or an exhausted quota is a property of the provider,
          // not of this batch: sending the remaining batches would fail
          // identically while burning the user's quota. A stored key can even be
          // the *wrong* provider's credential, so this is a live case, not a
          // hypothetical. Stop, report every affected security, and let the user
          // fix the key — there is deliberately no retry anywhere in this module.
          if (code === 'bad_api_key' || code === 'rate_limited') {
            batches.slice(i + 1).forEach((rest) => rest.forEach(fail));
            break;
          }
          continue;
        }
        for (const t of batch) {
          const byDate = closes.get(t.securityId);
          // A per-symbol failure inside an otherwise good batch. It is this
          // security's problem, so it never halts the provider.
          if (byDate instanceof Error) {
            errors.push({
              securityId: t.securityId, provider: name, symbol: t.symbol,
              code: errorCode(byDate), message: messageOf(byDate),
            });
            continue;
          }
          if (!byDate || Object.keys(byDate).length === 0) {
            errors.push({
              securityId: t.securityId, provider: name, symbol: t.symbol,
              code: 'no_closes', message: 'no closes returned',
            });
            continue;
          }
          const written = await writeCloses(t.securityId, byDate, chunks);
          updated.push({ securityId: t.securityId, provider: name, ...written });
        }
      }
    }

    // `fetchedAt` is what wg-stale-badge's `render({ fetchedAt })` wants, and it
    // is stamped only when something actually landed — a refresh where every
    // provider failed must not reset the badge to "just updated". Persisting it
    // across reloads is the screen's call, not this module's; the durable
    // fallback is portfolio.js's per-position `priceDate`.
    return { updated, skipped, errors, fetchedAt: updated.length ? now() : null };
  }

  // applyUniverse — write whatever the keyless universe blob covers, and return
  // the targets it did not so the provider loop can have them.
  //
  // A failure here is NEVER reported: the universe is a bonus, the user's own key
  // is the supported path (§7), and a symbol the blob missed produces exactly the
  // same outcome as a blob that never arrived. So there is nothing a user could
  // act on and nothing to put in `errors`.
  //
  // MATCHING IS BY TICKER AND CURRENCY, BOTH. The blob is keyed by the upstream's
  // symbol, which is the same string as the configured `quote.symbol` for a US
  // listing and for the `.DE`/`.PA`-suffixed European ones — but a bare ticker
  // can name different instruments in different symbologies, and the same
  // instrument can be quoted in a different unit (Yahoo prices London lines in
  // pence). Requiring the currency to agree with the security's own is what turns
  // "probably the same instrument" into "wrong by 100x is impossible": a
  // mismatch is not a guess, it is a fallthrough to the provider that was
  // configured for this security.
  async function applyUniverse(pending, chunks, updated) {
    let quotes = null;
    try {
      const body = await getJson(UNIVERSE_PATH);
      if (body && body.quotes && typeof body.quotes === 'object') quotes = body.quotes;
    } catch {
      // Down, blocked, 404 on an older server build, or offline. Fall through.
    }
    if (!quotes) return pending;

    const remaining = [];
    for (const t of pending) {
      // Own-property lookup, like every other lookup keyed by user data here.
      const entry = own(quotes, t.symbol.toUpperCase());
      const date = entry && ISO_DAY_RE.test(String(entry.date)) ? entry.date : null;
      // The one float boundary, and it is the SAME one every provider crosses —
      // priceUnits/parseFixed at the §5 price scale of 1e8. The server forwards
      // the upstream's decimal literal as a string and never parses it, so this
      // is the only place a price becomes a number in the whole path.
      const units = date && entry.currency === t.currency ? priceUnits(entry.close) : null;
      if (units === null) {
        remaining.push(t);
        continue;
      }
      const written = await writeCloses(t.securityId, { [date]: units }, chunks);
      updated.push({ securityId: t.securityId, provider: 'universe', ...written });
    }
    return remaining;
  }

  // Merge closes into the §4 per-security-year chunks. Merge, not replace: the
  // port's put() writes the body wholesale, so handing it only today's close
  // would erase the year's history. Re-fetching a day therefore overwrites that
  // one key and duplicates nothing.
  async function writeCloses(securityId, byDate, chunks) {
    const byYear = new Map();
    for (const [date, units] of Object.entries(byDate)) {
      const year = date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, {});
      // "MM-DD", zero-padded because `date` was validated as an ISO day.
      byYear.get(year)[date.slice(5)] = units;
    }

    for (const [year, closes] of byYear) {
      const key = chunkKey(securityId, year);
      // A PP import already writes chunks under its own deterministic ids, so
      // reuse whatever id this security-year is already stored under; two
      // chunks for one security-year would drift apart. Otherwise mint a
      // deterministic one, which is what makes a re-fetch overwrite rather
      // than duplicate (§4: derived records get a deterministic id).
      const existing = chunks.get(key);
      const recordId = existing ? existing.recordId : `${RECORD.price}_${securityId}_${year}`;
      const merged = { ...(existing ? existing.closes : {}), ...closes };
      // `year` is a string here, matching what ppimport.js writes.
      await records.put(RECORD.price, recordId, { securityId, year, closes: merged });
      chunks.set(key, { recordId, closes: merged });
    }

    const dates = Object.keys(byDate).sort();
    const latest = dates[dates.length - 1];
    return { dates: dates.length, latest, close: byDate[latest] };
  }

  return { refresh };
}

// --- providers -------------------------------------------------------------

// CoinGecko, crypto. GET /api/v3/coins/{id}/market_chart?vs_currency=&days=
// Response: { prices: [[epochMs, float], ...], market_caps: [...], total_volumes: [...] }
//
// `quote.symbol` is CoinGecko's coin id ("bitcoin"), not a ticker. Granularity
// is chosen by the API from `days` (5-minutely for 1, hourly to 90, daily
// beyond), so rather than depend on it we bucket every point by UTC day and
// keep the last one — which is that day's close for an intraday series, and the
// single 00:00 UTC snapshot for the daily one.
//
// ponytail: crypto trades 24/7, so "close" is a convention either way and a
// backfill can label a day from a 00:00 snapshot while a same-day refresh
// labels it from an intraday point. Upgrade path if that ever matters: pin
// `interval=daily` and stop mixing granularities.
async function loadCoinGecko({ batch, apiKey, days, getJson }) {
  const [{ securityId, symbol, currency }] = batch; // batch size is 1
  const url = new URL(`https://${QUOTE_HOSTS.coingecko}/api/v3/coins/${encodeURIComponent(symbol)}/market_chart`);
  url.searchParams.set('vs_currency', String(currency).toLowerCase());
  // The public tier serves at most a year of history.
  url.searchParams.set('days', String(clamp(days, 1, 365)));
  // Optional: a CoinGecko demo key raises the keyless rate limit. Sent as a
  // query parameter rather than the x-cg-demo-api-key header so no CORS
  // preflight is involved.
  if (apiKey) url.searchParams.set('x_cg_demo_api_key', apiKey);

  const body = await getJson(url.toString());
  const points = Array.isArray(body.prices) ? body.prices : null;
  if (!points) throw new TypeError('CoinGecko response has no `prices` array');

  const byDate = {};
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const day = utcDay(point[0]);
    const units = day ? priceUnits(point[1]) : null;
    if (units !== null) byDate[day] = units;
  }
  return new Map([[securityId, byDate]]);
}

// Twelve Data, stocks/ETFs. GET /time_series?symbol=&interval=1day&outputsize=&apikey=
//
// One symbol:      { meta: {...}, values: [{ datetime: "YYYY-MM-DD", close: "340.079987", ... }], status: "ok" }
// Several symbols: { "AAPL": { meta, values, status }, "MSFT": { ... } }
// Error:           { code: 401, message: "...", status: "error" }   (usually with a matching HTTP status)
//
// Closes arrive as decimal *strings*, which parseFixed consumes digit-wise —
// so the value never passes through a float at all.
async function loadTwelveData({ batch, apiKey, days, getJson }) {
  const url = new URL(`https://${QUOTE_HOSTS.twelvedata}/time_series`);
  url.searchParams.set('symbol', batch.map((t) => t.symbol).join(','));
  url.searchParams.set('interval', '1day');
  url.searchParams.set('outputsize', String(clamp(days, 1, 5000)));
  url.searchParams.set('apikey', apiKey);

  const body = await getJson(url.toString());
  // Twelve Data reports a rejected key or an exhausted credit budget inside a
  // 200 body as often as through the HTTP status, so `code` is read from either.
  const msg = providerMessage(body);
  if (msg) throw providerError(msg, body, 0);
  // A single-symbol request answers with the series inline; a multi-symbol one
  // keys it by symbol.
  const bySymbol = body.status === 'ok' ? { [batch[0].symbol]: body } : body;

  const out = new Map();
  for (const t of batch) {
    const series = own(bySymbol, t.symbol);
    if (!series || typeof series !== 'object') continue;
    // A multi-symbol response reports per-symbol failures per symbol: one
    // delisted or mistyped ticker sits next to seven good series. Returning the
    // error for that security alone keeps its neighbours' closes — throwing here
    // would discard a whole batch of good prices over one typo.
    const seriesMsg = providerMessage(series);
    if (seriesMsg) {
      out.set(t.securityId, providerError(`${t.symbol}: ${seriesMsg}`, series, 0));
      continue;
    }
    const byDate = {};
    for (const row of Array.isArray(series.values) ? series.values : []) {
      const day = String(row && row.datetime ? row.datetime : '').slice(0, 10);
      if (!ISO_DAY_RE.test(day)) continue;
      const units = priceUnits(row.close);
      if (units !== null) byDate[day] = units;
    }
    out.set(t.securityId, byDate);
  }
  return out;
}

// Both providers can report a failure inside a 200 body (Twelve Data does this
// when credits run out), so the status field is checked as well as the HTTP
// code. Truncated because these messages are marketing copy several lines long.
function providerMessage(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.status === 'error' && body.message) return String(body.message).slice(0, 200);
  if (typeof body.error === 'string') return body.error.slice(0, 200);
  return null;
}

// Carries the provider's own status code alongside the message. Both providers
// answer with a numeric `code` in the body, sometimes under a 200, so the body
// wins over the HTTP status when it has one.
function providerError(message, body, httpStatus) {
  const err = new Error(message);
  const fromBody = body && Number.isFinite(Number(body.code)) ? Number(body.code) : 0;
  err.status = fromBody || httpStatus || 0;
  return err;
}

// The `code` on every error entry, so a caller can say "check your API key for
// <provider>" rather than showing a raw provider message.
function errorCode(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) return 'bad_api_key';
  if (status === 429) return 'rate_limited';
  return 'fetch_failed';
}

const messageOf = (err) => String((err && err.message) || err).slice(0, 200);
