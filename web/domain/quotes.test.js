import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuotesDomain, QUOTE_HOSTS } from './quotes.js';

// ---------------------------------------------------------------------------
// Recorded provider payloads
// ---------------------------------------------------------------------------
//
// PROVENANCE, because it is the most important fact about this file's value:
//
//  * COINGECKO_MARKET_CHART — REAL. Captured 2026-07-29 from
//    api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=eur&days=3
//    with no API key. Trimmed from 73 hourly points to the six that straddle a
//    UTC midnight, which is the interesting part; the values and timestamps are
//    verbatim.
//  * TWELVEDATA_SINGLE — REAL. Captured 2026-07-29 from
//    api.twelvedata.com/time_series?symbol=AAPL&interval=1day&outputsize=2 with
//    the public `demo` key. Verbatim.
//  * TWELVEDATA_ERROR — REAL. The verbatim 401 body that same endpoint returns
//    for a bad key.
//  * TWELVEDATA_MULTI — WRITTEN FROM THE DOCS, not captured: the `demo` key
//    rejects comma-separated symbols, so the multi-symbol envelope could not be
//    recorded without a paid-tier key. The inner series objects are the real
//    single-symbol shape above; only the `{ "SYMBOL": ... }` wrapper is from
//    documentation. This is the one shape here that a live key should re-verify.
//
// Both hosts were confirmed to answer `access-control-allow-origin: *` on the
// same date, which is what makes browser-direct fetching possible at all (§7).

const COINGECKO_MARKET_CHART = {
  prices: [
    [1785099600000, 56714.40563768623], // 2026-07-26T21:00Z
    [1785103200000, 57110.02991030719], // 2026-07-26T22:00Z
    [1785106800000, 57402.810133005456], // 2026-07-26T23:00Z  <- last point of the 26th
    [1785110400000, 57314.89913414697], // 2026-07-27T00:00Z
    [1785114000000, 57111.778535974125], // 2026-07-27T01:00Z
    [1785117600000, 57071.819443252294], // 2026-07-27T02:00Z  <- last point of the 27th
  ],
  market_caps: [],
  total_volumes: [],
};

const TWELVEDATA_SINGLE = {
  meta: {
    symbol: 'AAPL', interval: '1day', currency: 'USD',
    exchange_timezone: 'America/New_York', exchange: 'NASDAQ',
    mic_code: 'XNGS', type: 'Common Stock',
  },
  values: [
    { datetime: '2026-07-28', open: '340.029999', high: '342.89001', low: '335.60001', close: '340.079987', volume: '50765695' },
    { datetime: '2026-07-27', open: '334.54001', high: '339.57001', low: '334.019989', close: '336.91000', volume: '49604300' },
  ],
  status: 'ok',
};

const TWELVEDATA_MULTI = {
  AAPL: TWELVEDATA_SINGLE,
  MSFT: {
    meta: { symbol: 'MSFT', interval: '1day', currency: 'USD', exchange: 'NASDAQ' },
    values: [{ datetime: '2026-07-28', open: '511.10', high: '514.20', low: '508.00', close: '512.34', volume: '17110200' }],
    status: 'ok',
  },
};

const TWELVEDATA_ERROR = {
  code: 401,
  message: '**apikey** parameter is incorrect or not specified. You can get your free API key instantly following this link: https://twelvedata.com/pricing.',
  status: 'error',
};

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

// An in-memory stand-in for the §3 records port. Same shape as portfolio.test.js.
function fixture() {
  const byType = new Map();
  const put = (recordType, body, recordId) => {
    if (!byType.has(recordType)) byType.set(recordType, new Map());
    byType.get(recordType).set(recordId, { ...body, recordId, recordType, clientTs: 1, deleted: false });
  };
  const records = {
    async list(recordType) {
      // Deep-copied on the way out, like a real Dexie read: the domain must not
      // be able to "write" by mutating what it was handed.
      return [...(byType.get(recordType) || new Map()).values()].map((r) => structuredClone(r));
    },
    async put(recordType, recordId, body) {
      put(recordType, body, recordId);
    },
  };
  return {
    put,
    records,
    all: (recordType) => [...(byType.get(recordType) || new Map()).values()],
  };
}

// A fetch-shaped transport over a script of responses. Records every URL it was
// asked for, so a test can assert on request count and on what leaked into one.
function transport(handler) {
  const calls = [];
  const http = async (url, init) => {
    calls.push(url);
    const out = await handler(url, init, calls.length);
    if (out instanceof Error) throw out;
    const { status = 200, body } = out;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  http.calls = calls;
  return http;
}

const json = (body, status = 200) => ({ status, body });

// Every test runs with minIntervalMs 0 so the pacing never costs wall time.
const noPace = { coingecko: { minIntervalMs: 0 }, twelvedata: { apiKey: 'k', minIntervalMs: 0 } };

function setup({ securities, quoteProviders = noPace, prices = [] } = {}) {
  const f = fixture();
  f.put('settings', { reportingCurrency: 'EUR', quoteProviders }, 'settings');
  for (const [id, sec] of Object.entries(securities)) f.put('security', sec, id);
  for (const p of prices) f.put('price', p, p.recordId);
  return f;
}

const BTC = { name: 'Bitcoin', currency: 'EUR', assetClass: 'crypto', quote: { provider: 'coingecko', symbol: 'bitcoin' } };
const AAPL = { name: 'Apple', currency: 'USD', assetClass: 'stock', quote: { provider: 'twelvedata', symbol: 'AAPL' } };
const MSFT = { name: 'Microsoft', currency: 'USD', assetClass: 'stock', quote: { provider: 'twelvedata', symbol: 'MSFT' } };

// ---------------------------------------------------------------------------

test('CoinGecko: closes land in a §4 chunk with zero-padded MM-DD keys', async () => {
  const f = setup({ securities: { sec_btc: BTC } });
  const http = transport(() => json(COINGECKO_MARKET_CHART));
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ days: 3 });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.skipped, []);
  assert.equal(report.updated.length, 1);

  const chunk = f.all('price')[0];
  assert.equal(chunk.securityId, 'sec_btc');
  assert.equal(chunk.year, '2026');
  // The last point of each UTC day is that day's close, and both keys are
  // zero-padded — an unpadded "7-26" sorts above "12-31" and would win the
  // latest-close race in portfolio.js.
  assert.deepEqual(Object.keys(chunk.closes), ['07-26', '07-27']);
  assert.equal(chunk.closes['07-26'], 5740281013301); // 57402.810133005456 -> 1e8, rounded once
  assert.equal(chunk.closes['07-27'], 5707181944325); // 57071.819443252294 -> 1e8
});

test('float -> 1e8 is exact at the boundary', async () => {
  // §5's own worked example: $41.2350 -> 4123500000. A provider hands this over
  // as a JSON float; nothing downstream may ever see the float again.
  const f = setup({ securities: { sec_btc: BTC } });
  const http = transport(() => json({ prices: [[1785110400000, 41.235]] }));
  await createQuotesDomain({ records: f.records, http }).refresh();
  assert.equal(f.all('price')[0].closes['07-27'], 4123500000);

  // And a decimal string, which is how Twelve Data sends it — parsed digit-wise,
  // so it never round-trips through a double at all.
  const g = setup({ securities: { sec_aapl: AAPL } });
  const http2 = transport(() => json({
    ...TWELVEDATA_SINGLE,
    values: [{ datetime: '2026-07-28', close: '41.2350' }],
  }));
  await createQuotesDomain({ records: g.records, http: http2 }).refresh();
  assert.equal(g.all('price')[0].closes['07-28'], 4123500000);
});

test('Twelve Data: one request covers every stock, single- and multi-symbol shapes both parse', async () => {
  const f = setup({ securities: { sec_aapl: AAPL, sec_msft: MSFT } });
  const http = transport(() => json(TWELVEDATA_MULTI));
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ days: 2 });

  assert.equal(http.calls.length, 1, 'both symbols batch into one round trip');
  assert.match(http.calls[0], /symbol=AAPL%2CMSFT/);
  assert.deepEqual(report.errors, []);
  assert.equal(report.updated.length, 2);

  const closes = Object.fromEntries(f.all('price').map((r) => [r.securityId, r.closes]));
  assert.deepEqual(closes.sec_aapl, { '07-27': 33691000000, '07-28': 34007998700 });
  assert.deepEqual(closes.sec_msft, { '07-28': 51234000000 });

  // A single-symbol request answers with the series inline instead of keyed by
  // symbol; both shapes are real and both have to work.
  const g = setup({ securities: { sec_aapl: AAPL } });
  await createQuotesDomain({ records: g.records, http: transport(() => json(TWELVEDATA_SINGLE)) }).refresh({ days: 2 });
  assert.deepEqual(g.all('price')[0].closes, { '07-27': 33691000000, '07-28': 34007998700 });
});

test('a timeout does not hang, and leaves cached prices untouched', async () => {
  const cached = { recordId: 'price_sec_btc_2026', securityId: 'sec_btc', year: '2026', closes: { '07-20': 5000000000 } };
  const f = setup({ securities: { sec_btc: BTC }, prices: [cached] });

  // A transport that honours the abort signal, which is what a real one does.
  const honours = transport((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const report = await createQuotesDomain({ records: f.records, http: honours, timeoutMs: 20 }).refresh();
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].code, 'fetch_failed');

  // And a transport that ignores its signal entirely — a bad polyfill, a wedged
  // service worker. The deadline race is why this still returns instead of
  // wedging the whole refresh forever.
  const ignores = transport(() => new Promise(() => {}));
  const report2 = await createQuotesDomain({ records: f.records, http: ignores, timeoutMs: 20 }).refresh();
  assert.equal(report2.errors.length, 1);
  assert.match(report2.errors[0].message, /timed out/);

  // The whole point: the cached close is still there, so valuation is unaffected.
  assert.deepEqual(f.all('price')[0].closes, { '07-20': 5000000000 });
});

test('a provider error degrades to cached prices and never throws', async () => {
  const cached = { recordId: 'price_sec_aapl_2026', securityId: 'sec_aapl', year: '2026', closes: { '07-20': 33000000000 } };
  const f = setup({ securities: { sec_aapl: AAPL, sec_btc: BTC }, prices: [cached] });

  const http = transport((url) => (url.includes(QUOTE_HOSTS.twelvedata)
    ? json({ error: 'upstream exploded' }, 503)
    : json(COINGECKO_MARKET_CHART)));

  const report = await createQuotesDomain({ records: f.records, http }).refresh();

  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].securityId, 'sec_aapl');
  assert.equal(report.errors[0].code, 'fetch_failed');
  // The healthy provider still updated: one dead provider is not a dead refresh.
  assert.equal(report.updated.length, 1);
  assert.equal(report.updated[0].securityId, 'sec_btc');
  // And the stock keeps its last known close rather than losing it.
  const aapl = f.all('price').find((r) => r.securityId === 'sec_aapl');
  assert.deepEqual(aapl.closes, { '07-20': 33000000000 });
});

test('re-fetching a day overwrites that key and duplicates nothing', async () => {
  const f = setup({ securities: { sec_btc: BTC } });
  const domain = createQuotesDomain({ records: f.records, http: transport(() => json(COINGECKO_MARKET_CHART)) });
  await domain.refresh({ days: 3 });

  // Same day, new price — an intraday re-tap, which is the common case.
  const later = createQuotesDomain({
    records: f.records,
    http: transport(() => json({ prices: [[1785117600000, 60000.5]] })),
  });
  await later.refresh();

  assert.equal(f.all('price').length, 1, 'one chunk per security-year, not two');
  const chunk = f.all('price')[0];
  assert.equal(chunk.closes['07-27'], 6000050000000, 'the refetched day is overwritten');
  assert.equal(chunk.closes['07-26'], 5740281013301, 'the rest of the year survives the merge');
});

test('an existing chunk from a PP import is merged into, not shadowed by a second one', async () => {
  // ppimport.js mints its own deterministic recordId for a security-year. A
  // refresh has to write back through that id or the two chunks drift apart.
  const imported = { recordId: 'price_pp_deadbeef', securityId: 'sec_btc', year: '2026', closes: { '01-02': 4000000000 } };
  const f = setup({ securities: { sec_btc: BTC }, prices: [imported] });
  await createQuotesDomain({ records: f.records, http: transport(() => json(COINGECKO_MARKET_CHART)) }).refresh({ days: 3 });

  assert.equal(f.all('price').length, 1);
  assert.equal(f.all('price')[0].recordId, 'price_pp_deadbeef');
  assert.deepEqual(Object.keys(f.all('price')[0].closes).sort(), ['01-02', '07-26', '07-27']);
});

test('a security routes to its own provider; a missing config is a clean skip', async () => {
  // The user configured CoinGecko only. Their crypto must still price.
  const f = setup({
    securities: { sec_btc: BTC, sec_aapl: AAPL, sec_bare: { name: 'Cash-like', currency: 'EUR' } },
    quoteProviders: { coingecko: { minIntervalMs: 0 } },
  });
  const http = transport(() => json(COINGECKO_MARKET_CHART));
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ days: 3 });

  assert.equal(http.calls.length, 1, 'no request is made for an unconfigured provider');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.updated.map((u) => u.securityId), ['sec_btc']);
  assert.deepEqual(
    report.skipped.map((s) => [s.securityId, s.reason]).sort(),
    [['sec_aapl', 'no_api_key'], ['sec_bare', 'no_quote_config']],
  );
});

test('a rejected API key stops the provider instead of burning the quota', async () => {
  // Nine stocks is two batches. A 401 on the first must not send the second: a
  // stored key can be the wrong provider's credential entirely, and retrying
  // spends the user's daily allowance to learn nothing.
  const securities = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`sec_${i}`, { ...AAPL, quote: { provider: 'twelvedata', symbol: `S${i}` } }]),
  );
  const f = setup({ securities });
  const http = transport(() => json(TWELVEDATA_ERROR, 401));
  const report = await createQuotesDomain({ records: f.records, http }).refresh();

  assert.equal(http.calls.length, 1, 'the second batch is never sent');
  assert.equal(report.errors.length, 9, 'every affected security is still reported');
  assert.ok(report.errors.every((e) => e.code === 'bad_api_key'));
  assert.match(report.errors[0].message, /apikey/);
});

test('an exhausted credit budget reported inside a 200 body is still a stop', async () => {
  const securities = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`sec_${i}`, { ...AAPL, quote: { provider: 'twelvedata', symbol: `S${i}` } }]),
  );
  const f = setup({ securities });
  const http = transport(() => json({ code: 429, message: 'You have run out of API credits', status: 'error' }));
  const report = await createQuotesDomain({ records: f.records, http }).refresh();

  assert.equal(http.calls.length, 1);
  assert.ok(report.errors.every((e) => e.code === 'rate_limited'));
});

test('one bad ticker does not cost its batch-mates their prices', async () => {
  // Twelve Data reports a delisted or mistyped symbol per symbol, alongside
  // seven perfectly good series. Discarding the batch over it would be the
  // expensive kind of wrong: the user loses prices they are entitled to and
  // spends a request to do it.
  const f = setup({ securities: { sec_aapl: AAPL, sec_msft: MSFT } });
  const http = transport(() => json({
    AAPL: TWELVEDATA_SINGLE,
    MSFT: { code: 404, message: '**symbol** not found: MSFT', status: 'error' },
  }));
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ days: 2 });

  assert.deepEqual(report.updated.map((u) => u.securityId), ['sec_aapl']);
  assert.equal(f.all('price').length, 1);
  assert.deepEqual(f.all('price')[0].closes, { '07-27': 33691000000, '07-28': 34007998700 });
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].securityId, 'sec_msft');
  assert.match(report.errors[0].message, /symbol\*\* not found/);
});

test('one provider\'s rate limit does not hold up another provider', async () => {
  // Twelve Data's interval is a minute. Sharing one timestamp with CoinGecko
  // would make a crypto request that just returned stall the first stock batch
  // for the whole of it — a mixed portfolio would take a minute to refresh.
  const f = setup({
    securities: { sec_btc: BTC, sec_aapl: AAPL },
    quoteProviders: { coingecko: {}, twelvedata: { apiKey: 'k' } }, // real intervals
  });
  const http = transport((url) => (url.includes(QUOTE_HOSTS.twelvedata)
    ? json(TWELVEDATA_SINGLE)
    : json(COINGECKO_MARKET_CHART)));

  const started = Date.now();
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ days: 2 });

  assert.equal(report.updated.length, 2);
  assert.ok(Date.now() - started < 2000, `refresh waited ${Date.now() - started}ms on an unrelated provider`);
});

test('the API key never appears in an error, and only the two known hosts are contacted', async () => {
  const f = setup({
    securities: { sec_aapl: AAPL, sec_btc: BTC },
    quoteProviders: { coingecko: { minIntervalMs: 0 }, twelvedata: { apiKey: 'SUPER-SECRET-KEY', minIntervalMs: 0 } },
  });
  const http = transport(() => json(TWELVEDATA_ERROR, 401));
  const report = await createQuotesDomain({ records: f.records, http }).refresh();

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('SUPER-SECRET-KEY'), 'the key must never reach a report a caller might log');
  assert.ok(report.errors.some((e) => e.provider === 'twelvedata'));

  // Every hostname this module contacts is one of the exported constants, which
  // is what the CSP connect-src allowlist is derived from. Nothing is built out
  // of user input.
  const hosts = new Set(http.calls.map((u) => new URL(u).host));
  assert.deepEqual([...hosts].sort(), Object.values(QUOTE_HOSTS).sort());
  for (const u of http.calls) assert.equal(new URL(u).protocol, 'https:');
});

test('a hostile provider value cannot be resolved off Object.prototype', async () => {
  // `quote.provider` is user data. A plain PROVIDERS[p] lookup resolves
  // "constructor" to a function, whose `batch` is undefined — and chunking by
  // undefined is an infinite loop, not a config error.
  const f = setup({ securities: { sec_x: { ...AAPL, quote: { provider: 'constructor', symbol: 'X' } } } });
  const http = transport(() => json({}));
  const report = await createQuotesDomain({ records: f.records, http }).refresh();

  assert.equal(http.calls.length, 0);
  assert.deepEqual(report.skipped, [{ securityId: 'sec_x', reason: 'unknown_provider', provider: 'constructor' }]);
});

test('garbage points are dropped, not propagated as prices', async () => {
  const f = setup({ securities: { sec_btc: BTC } });
  const http = transport(() => json({
    prices: [
      [1785110400000, 0],            // a zero close would value the position at nothing
      [1785196800000, -5],           // ditto, louder
      [1785283200000, 'not a price'],
      ['not a time', 100],
      [1785369600000, 1.5],          // the only real one
    ],
  }));
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ days: 5 });

  assert.deepEqual(f.all('price')[0].closes, { '07-30': 150000000 });
  assert.equal(report.errors.length, 0);
});

test('a response with nothing usable in it is an error, not a silent success', async () => {
  const f = setup({ securities: { sec_btc: BTC } });
  const http = transport(() => json({ prices: [] }));
  const report = await createQuotesDomain({ records: f.records, http }).refresh();

  assert.deepEqual(f.all('price'), []);
  assert.deepEqual(report.updated, []);
  assert.equal(report.errors[0].code, 'no_closes');
  // A refresh where nothing landed must not tell the staleness badge that
  // prices are fresh.
  assert.equal(report.fetchedAt, null);
});

test('fetchedAt is stamped when something lands, for the staleness badge', async () => {
  const f = setup({ securities: { sec_btc: BTC } });
  const http = transport(() => json(COINGECKO_MARKET_CHART));
  const report = await createQuotesDomain({ records: f.records, http, now: () => 1700000000000 }).refresh({ days: 3 });
  assert.equal(report.fetchedAt, 1700000000000);
});

test('securityIds narrows the refresh to one security', async () => {
  const f = setup({ securities: { sec_btc: BTC, sec_aapl: AAPL } });
  const http = transport(() => json(COINGECKO_MARKET_CHART));
  const report = await createQuotesDomain({ records: f.records, http }).refresh({ securityIds: ['sec_btc'], days: 3 });

  assert.equal(http.calls.length, 1);
  assert.deepEqual(report.updated.map((u) => u.securityId), ['sec_btc']);
  assert.deepEqual(report.skipped, []);
});

test('the http port is required, and the CoinGecko request is built from the security currency', async () => {
  assert.throws(() => createQuotesDomain({ records: {} }), /http port/);

  const f = setup({ securities: { sec_btc: { ...BTC, currency: 'CHF' } } });
  const http = transport(() => json(COINGECKO_MARKET_CHART));
  await createQuotesDomain({ records: f.records, http }).refresh({ days: 9999 });

  const url = new URL(http.calls[0]);
  assert.equal(url.searchParams.get('vs_currency'), 'chf');
  assert.equal(url.searchParams.get('days'), '365', 'clamped to what the public tier serves');
  assert.equal(url.pathname, '/api/v3/coins/bitcoin/market_chart');
});
