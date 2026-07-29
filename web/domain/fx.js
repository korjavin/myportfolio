// FX — turning a mixed-currency portfolio into one coherent number.
// ARCHITECTURE.md §4 (`fx` records) and §5 (fixed point) are normative here.
//
// An `fx` record is `{ pair: "EURUSD", date, rate }` with `rate` at the §5 FX
// scale of 1e8. The pair reads BASE then QUOTE, and the rate is "one unit of
// BASE is this many units of QUOTE" — so EURUSD 108420000 means €1 = $1.0842,
// and converting euros to dollars is a multiplication.
//
// §5 already records that FX is the one scale where a Portfolio Performance
// import is NOT lossless: PP stores `<exchangeRate>` as a BigDecimal and 1e8
// genuinely rounds. That is documented and accepted, not a bug to fix here.
//
// Two things live in this file:
//
//   createFxRates()   pure lookup over stored `fx` records — the half
//                     portfolio.js folds with.
//   createFxDomain()  the ECB fetcher, an ARCHITECTURE.md §3 factory over an
//                     injected `http` port, exactly like quotes.js. No global
//                     fetch, so it is testable with a recorded payload and no
//                     network.

import { RECORD, SETTINGS_ID } from './schema.js';
import { DECIMALS, parseFixed, proportion } from './money.js';

// The complete set of hosts this module will ever contact, hardcoded and
// exported so the CSP `connect-src` allowlist can be derived from it rather
// than from a `https:` wildcard — the same contract as quotes.js's QUOTE_HOSTS.
// Nothing here builds a hostname out of user input.
export const FX_HOSTS = Object.freeze({
  ecb: 'data-api.ecb.europa.eu',
});

// A rate of exactly 1, at the §5 FX scale. `convert(amount, FX_ONE) === amount`.
export const FX_ONE = 10 ** DECIMALS.fx;

// HOW WEEKENDS AND HOLIDAYS ARE HANDLED — a decision, stated here because it is
// the one place this feature can go quietly wrong.
//
// The ECB fixes rates on TARGET business days only. There is no Saturday rate,
// no Christmas rate, and no Easter Monday rate — and a transaction dated
// Saturday is not an edge case, it is most retail settlement paperwork. So a
// published fixing is treated as the applicable rate for its own day AND for
// every following day until the next fixing, bounded by this window. That is
// not a fallback: for a daily-fixing series it is what the rate *means*, and it
// is the same rule portfolio.js already applies to prices (the newest close on
// or before the day).
//
// The bound is what keeps it from becoming a silent fallback. The longest ECB
// closure is four consecutive days (Good Friday through Easter Monday), so
// seven covers every real gap in the series with margin, while a genuine hole —
// history that was never fetched, a provider outage, a rate from 2015 sitting
// alone in the record set — falls outside it and surfaces as an explicit gap
// instead of converting a 2024 transaction at a 2015 rate.
//
// The applicable date is returned alongside every rate, so a carried-forward
// fixing is visible to the caller rather than indistinguishable from a
// same-day one.
export const FX_CARRY_FORWARD_DAYS = 7;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCY_RE = /^[A-Z]{3}$/;
const PAIR_RE = /^[A-Z]{3}[A-Z]{3}$/;

// §4's time convention: a date is a UTC calendar day, and a string that is not
// a real one is rejected rather than rolled forward — Date.UTC(2024, 1, 30)
// quietly becomes March 1, so round-tripping the string is what catches it.
export function isCalendarDay(day) {
  if (!DAY_RE.test(day)) return false;
  const ms = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return new Date(ms).toISOString().slice(0, 10) === day;
}

// Epoch ms of a UTC calendar day, or null if it is not one.
export function dayMs(day) {
  if (!isCalendarDay(day)) return null;
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

const utcDay = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);
const shiftDay = (day, days) => utcDay(dayMs(day) + days * DAY_MS);

const upper = (s) => (s ? String(s).toUpperCase() : null);

// createFxRates — the lookup portfolio.js folds with.
//
//   fxRecs  the §4 `fx` records
//   issue   (code, recordId, message) — malformed records are surfaced, never
//           skipped in silence, because a dropped rate becomes a missing-rate
//           gap several hundred lines away with nothing pointing at the cause.
//
// Returns { rate(from, to, day) } -> { rate, date } | null, where `rate` is at
// 1e8 and `date` is the fixing the answer came from (which may be earlier than
// `day` — see FX_CARRY_FORWARD_DAYS).
export function createFxRates(fxRecs, issue = () => {}) {
  const series = new Map(); // pair -> [{ date, rate }] ascending

  for (const rec of fxRecs || []) {
    const pair = upper(rec.pair);
    const date = String(rec.date ?? '').slice(0, 10);
    if (!PAIR_RE.test(pair ?? '') || !isCalendarDay(date)
        || !Number.isSafeInteger(rec.rate) || rec.rate <= 0) {
      issue('malformed_fx', rec.recordId,
        'fx record needs { pair: "EURUSD", date: "YYYY-MM-DD", rate } with rate a positive '
        + `1e8 integer; got ${JSON.stringify({ pair: rec.pair, date: rec.date, rate: rec.rate })}`);
      continue;
    }
    if (!series.has(pair)) series.set(pair, []);
    series.get(pair).push({ date, rate: rec.rate });
  }
  // Ascending by date, with a rate tiebreak so two records for the same
  // pair-day resolve to the same one on every run rather than to whichever the
  // port happened to list last.
  for (const list of series.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rate - b.rate));

  // Sorted once: the cross-rate search below iterates it, and a search order
  // that depends on record insertion order would pick a different bridge
  // currency — and so a different rounding — from one load to the next.
  const pairs = [...series.keys()].sort();

  // The applicable fixing for `pair` on `day`: the newest on or before it,
  // within the carry-forward window.
  function on(pair, day, ms) {
    const list = series.get(pair);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].date > day) continue;
      return ms - dayMs(list[i].date) <= FX_CARRY_FORWARD_DAYS * DAY_MS ? list[i] : null;
    }
    return null;
  }

  // Rates are inverted and crossed through `proportion`, which is exact BigInt
  // arithmetic rounded once — but the RESULT is still quantised back to 1e8, so
  // an inverted or crossed rate carries one more rounding than a stored one.
  // That is the §5 FX residual, ≤1e-8 relative, far below a cent on any
  // realistic amount. A rate so extreme that its inverse overflows the
  // fixed-point range is not a rate; it becomes an explicit gap.
  const safely = (fn) => { try { return fn(); } catch { return null; } };

  // snapshot() asks per transaction, and a portfolio trades the same currency
  // on the same handful of days over and over, so the cross-rate search runs
  // once per distinct question rather than once per record. NUL joins the
  // parts, written as an ESCAPE and never as a literal byte — a literal one
  // makes git classify this source as binary and stop diffing it.
  const cache = new Map();

  function rate(from, to, day) {
    const a = upper(from);
    const b = upper(to);
    if (!a || !b) return null;
    // Nothing to convert. Returned rather than refused so callers can treat
    // "same currency" and "converted" through one code path.
    if (a === b) return { rate: FX_ONE, date: day };

    const key = `${a}\u0000${b}\u0000${day}`;
    if (cache.has(key)) return cache.get(key);
    const answer = lookup(a, b, day);
    cache.set(key, answer);
    return answer;
  }

  function lookup(a, b, day) {
    const ms = dayMs(day);
    if (ms === null) return null;

    const direct = on(a + b, day, ms);
    if (direct) return direct;

    // The ECB quotes everything against the euro, so a EUR-reporting portfolio
    // holding dollars has EURUSD and needs USDEUR. The inverse is not optional.
    const inverse = on(b + a, day, ms);
    if (inverse) {
      const r = safely(() => proportion(FX_ONE, FX_ONE, inverse.rate));
      if (r) return { rate: r, date: inverse.date };
    }

    // Cross through a shared base, for the same reason: with a EUR-based
    // series, a CHF-reporting portfolio holding dollars has EURUSD and EURCHF
    // and no USDCHF anywhere. (X->b) / (X->a) is a->b.
    for (const pair of pairs) {
      if (pair.slice(3) !== a) continue;
      const legFrom = on(pair, day, ms);
      if (!legFrom) continue;
      const legTo = on(pair.slice(0, 3) + b, day, ms);
      if (!legTo) continue;
      const r = safely(() => proportion(legTo.rate, FX_ONE, legFrom.rate));
      if (r) return { rate: r, date: legFrom.date < legTo.date ? legFrom.date : legTo.date };
    }

    return null;
  }

  return { rate };
}

// --- the ECB fetcher --------------------------------------------------------

// The ECB's SDMX data API, chosen over the eurofxref CSV/XML on www.ecb.europa.eu
// because this host sends CORS headers and that one does not — and a browser-
// direct fetch is the whole point (§7: our server never learns what you hold).
// It is free and needs no key.
//
//   GET /service/data/EXR/D.{CCY}[+{CCY}...].EUR.SP00.A
//       ?startPeriod=YYYY-MM-DD&endPeriod=YYYY-MM-DD&format=csvdata
//
// csvdata rather than jsondata: SDMX-JSON encodes observations as offsets into
// a separate dimension table, which is thirty lines of index-chasing to read
// what four labelled CSV columns say outright.
//
//   KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,...
//   EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-01-02,1.0956,...
//
// CURRENCY_DENOM is the base and CURRENCY the quote, so that row is EURUSD.
// Rates arrive as decimal STRINGS, which parseFixed consumes digit-wise — the
// value never passes through a float.
//
// A plain split on commas rather than a CSV parser, because the real response
// DOES contain quoted commas — the trailing TITLE_COMPL column reads
// `"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)"` — but only
// in metadata columns that sit after all four read here. The safety net is that
// every field is validated (three letters, a real calendar day, a parseable
// positive decimal), so a column order that ever shifts under us drops the row
// and surfaces as a missing-rate gap rather than storing a title as a rate.
//
// Non-published days are simply ABSENT from the response — there is no NaN row
// for Good Friday. That is what FX_CARRY_FORWARD_DAYS exists to cover.
const ECB_COLUMNS = ['CURRENCY', 'CURRENCY_DENOM', 'TIME_PERIOD', 'OBS_VALUE'];

export function parseEcbCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = (lines.shift() || '').split(',').map((s) => s.trim());
  const [iQuote, iBase, iDate, iValue] = ECB_COLUMNS.map((name) => header.indexOf(name));
  if ([iQuote, iBase, iDate, iValue].some((i) => i < 0)) {
    throw new TypeError(`ECB response is missing one of ${ECB_COLUMNS.join(', ')}`);
  }

  const out = [];
  for (const line of lines) {
    const f = line.split(',');
    const quote = upper(f[iQuote]?.trim());
    const base = upper(f[iBase]?.trim());
    const date = (f[iDate] ?? '').trim();
    if (!CCY_RE.test(base ?? '') || !CCY_RE.test(quote ?? '') || !isCalendarDay(date)) continue;
    // A non-published day comes back blank or as "NaN". Dropping the row is
    // right: there is no fixing, and the carry-forward window is what covers
    // the day, not an invented zero.
    let units;
    try {
      units = parseFixed((f[iValue] ?? '').trim(), DECIMALS.fx);
    } catch {
      continue;
    }
    if (units <= 0) continue;
    out.push({ pair: base + quote, date, rate: units });
  }
  return out;
}

// createFxDomain — ARCHITECTURE.md §3 factory over injected ports, same shape
// as quotes.js.
//
//   records    the §3 records port
//   http       fetch-shaped: (url, { signal }) => Promise<Response>. Injected,
//              never reached for globally.
//   now        clock, ms
//   timeoutMs  per-request deadline. Not optional, for quotes.js's reason: a
//              bare request hangs forever on a half-open connection.
export function createFxDomain({ records, http, now = Date.now, timeoutMs = 10_000 }) {
  if (typeof http !== 'function') throw new TypeError('fx: an http port is required');

  // Enforced two ways, as in quotes.js: the signal frees the socket on a
  // transport that honours it, and the race keeps one that ignores it from
  // wedging the refresh anyway.
  async function getText(url) {
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([http(url, { signal: ctrl.signal }), deadline]);
      if (!res || typeof res.text !== 'function') throw new TypeError('http port returned no response');
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return await Promise.race([res.text(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // refresh — fetch ECB daily fixings and store them as §4 `fx` records.
  //
  //   currencies  optional; default is every currency the portfolio actually
  //               uses (accounts, securities, transactions, reporting), which
  //               is what makes this a one-button call from the UI
  //   from / to   optional "YYYY-MM-DD" range; default spans the transaction
  //               log up to today, because a rate is needed for every date a
  //               transaction happened on and not for any other
  //
  // Returns { written, skipped, errors, pairs, from, to } and never throws — a
  // dead provider must degrade to "some totals have an FX gap", which
  // portfolio.js already reports, not to an error screen.
  //
  // ponytail: one record per pair-day, which §4 pins. A decade of history for
  // two currencies is ~5000 records, against §6's "a few thousand" budget for
  // the whole blob. Upgrade path if that bites: chunk fx per pair-year exactly
  // as §4 already does for prices.
  async function refresh({ currencies = null, from = null, to = null } = {}) {
    const [accountRecs, securityRecs, txRecs, settingsRecs, fxRecs] = await Promise.all([
      records.list(RECORD.account),
      records.list(RECORD.security),
      records.list(RECORD.transaction),
      records.list(RECORD.settings),
      records.list(RECORD.fx),
    ]);

    const settings = settingsRecs.find((r) => r.recordId === SETTINGS_ID) || {};

    let wanted = currencies;
    if (!wanted) {
      const inUse = new Set();
      for (const rec of [...accountRecs, ...securityRecs, ...txRecs]) {
        if (rec.currency) inUse.add(upper(rec.currency));
      }
      if (settings.reportingCurrency) inUse.add(upper(settings.reportingCurrency));
      wanted = [...inUse];
    }
    // This series is EUR-based, so the euro itself has no key and needs none:
    // createFxRates inverts and crosses the EUR pairs to reach everything else.
    const legs = [...new Set(wanted.map(upper).filter((c) => CCY_RE.test(c ?? '') && c !== 'EUR'))].sort();
    const end = to || utcDay(now());
    if (legs.length === 0 || !isCalendarDay(end)) {
      return { written: 0, skipped: 0, errors: [], pairs: [], from: null, to: null };
    }

    // The default start reaches a carry-forward window BEFORE the first
    // transaction, not to it. A portfolio whose earliest trade is dated over a
    // weekend or an ECB holiday has no fixing on that day by definition, and
    // starting the range there fetches everything except the one rate that
    // day actually needs — leaving the user a `currency_not_converted` gap
    // immediately after a refresh that reported success. Found by codex
    // review. An explicit `from` is honoured as given; the caller asked for a
    // range, not for this correction.
    const days = txRecs.map((t) => String(t.date ?? '').slice(0, 10)).filter(isCalendarDay).sort();
    const start = from || shiftDay(days[0] || end, -FX_CARRY_FORWARD_DAYS);
    const pairs = legs.map((c) => `EUR${c}`);

    const url = new URL(`https://${FX_HOSTS.ecb}/service/data/EXR/D.${legs.join('+')}.EUR.SP00.A`);
    url.searchParams.set('startPeriod', start);
    url.searchParams.set('endPeriod', end);
    url.searchParams.set('format', 'csvdata');

    let rows;
    try {
      rows = parseEcbCsv(await getText(url.toString()));
    } catch (err) {
      const status = err && err.status;
      return {
        written: 0,
        skipped: 0,
        errors: [{
          code: status === 429 ? 'rate_limited' : 'fetch_failed',
          message: String((err && err.message) || err).slice(0, 200),
        }],
        pairs,
        from: start,
        to: end,
      };
    }

    // §4: a derived record gets a deterministic id, which is what makes a
    // re-fetch overwrite rather than mint a second rate for the same pair-day.
    // An unchanged rate is not rewritten at all — a refresh that re-put a
    // decade of history would bump clientTs on every record and hand the sync
    // blob a full rewrite for nothing.
    const seen = new Map(fxRecs.map((r) => [`${upper(r.pair)}\u0000${r.date}`, r.rate]));
    let written = 0;
    let skipped = 0;
    for (const row of rows) {
      const key = `${row.pair}\u0000${row.date}`;
      if (seen.get(key) === row.rate) { skipped += 1; continue; }
      await records.put(RECORD.fx, `${RECORD.fx}_${row.pair}_${row.date}`, row);
      seen.set(key, row.rate);
      written += 1;
    }

    return { written, skipped, errors: [], pairs, from: start, to: end };
  }

  return { refresh };
}
