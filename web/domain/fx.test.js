import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFxRates, createFxDomain, parseEcbCsv,
  FX_HOSTS, FX_ONE, FX_CARRY_FORWARD_DAYS,
} from './fx.js';

// ---------------------------------------------------------------------------
// Recorded provider payload
// ---------------------------------------------------------------------------
//
// PROVENANCE: REAL. Captured 2026-07-29, verbatim including the trailing
// metadata columns, from
//   data-api.ecb.europa.eu/service/data/EXR/D.USD+CHF.EUR.SP00.A
//     ?startPeriod=2024-03-28&endPeriod=2024-04-03&format=csvdata
// The same host answered `access-control-allow-origin: *` on that date, which
// is what makes the browser-direct fetch possible at all (§7).
//
// This range was chosen because it is EASTER 2024. Good Friday (03-29) and
// Easter Monday (04-01) are ECB holidays and 03-30/03-31 are the weekend, so
// the response jumps from Thursday the 28th straight to Tuesday the 2nd with
// no rows in between and no placeholder — the longest gap the series ever has.
// A fixture with a tidy unbroken week would not exercise the one thing that
// makes or breaks this module.
const ECB_CSV = [
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT',
  'EXR.D.CHF.EUR.SP00.A,D,CHF,EUR,SP00,A,2024-03-28,0.9766,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,Swiss franc/Euro ECB reference exchange rate,"ECB reference exchange rate, Swiss franc/Euro, 2.15 pm (C.E.T.)",CHF,0',
  'EXR.D.CHF.EUR.SP00.A,D,CHF,EUR,SP00,A,2024-04-02,0.9765,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,Swiss franc/Euro ECB reference exchange rate,"ECB reference exchange rate, Swiss franc/Euro, 2.15 pm (C.E.T.)",CHF,0',
  'EXR.D.CHF.EUR.SP00.A,D,CHF,EUR,SP00,A,2024-04-03,0.9792,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,Swiss franc/Euro ECB reference exchange rate,"ECB reference exchange rate, Swiss franc/Euro, 2.15 pm (C.E.T.)",CHF,0',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-03-28,1.0811,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-04-02,1.0749,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-04-03,1.0783,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0',
].join('\n');

// An in-memory stand-in for the §3 records port.
function fixture() {
  const byType = new Map();
  const put = (recordType, body, recordId) => {
    if (!byType.has(recordType)) byType.set(recordType, []);
    byType.get(recordType).push({ ...body, recordId, recordType, clientTs: 1, deleted: false });
  };
  const writes = [];
  const records = {
    async list(recordType) { return (byType.get(recordType) || []).slice(); },
    async put(recordType, recordId, body) {
      writes.push({ recordType, recordId, body });
      const list = byType.get(recordType) || [];
      const at = list.findIndex((r) => r.recordId === recordId);
      const rec = { ...body, recordId, recordType, clientTs: 2, deleted: false };
      if (at >= 0) list[at] = rec; else put(recordType, body, recordId);
    },
  };
  return { put, writes, records };
}

const httpOk = (body, calls = []) => {
  const http = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, async text() { return body; } };
  };
  http.calls = calls;
  return http;
};

const fx = (pair, date, rate, recordId) => ({ pair, date, rate, recordId: recordId || `fx_${pair}_${date}` });

// ---------------------------------------------------------------------------
// The lookup — the half portfolio.js folds with
// ---------------------------------------------------------------------------

test('a rate is looked up at its own day, not the newest one stored', async () => {
  const rates = createFxRates([
    fx('EURUSD', '2019-06-03', 112000000),
    fx('EURUSD', '2024-01-10', 110000000),
    fx('EURUSD', '2026-07-29', 200000000),
  ]);

  assert.deepEqual(rates.rate('EUR', 'USD', '2024-01-10'), { date: '2024-01-10', rate: 110000000 });
  assert.deepEqual(rates.rate('EUR', 'USD', '2019-06-03'), { date: '2019-06-03', rate: 112000000 });
});

test('a day before the first fixing has no rate — history is not extrapolated backwards', () => {
  const rates = createFxRates([fx('EURUSD', '2024-01-10', 110000000)]);
  assert.equal(rates.rate('EUR', 'USD', '2024-01-09'), null);
});

test('the same currency needs no rate', () => {
  const rates = createFxRates([]);
  assert.deepEqual(rates.rate('EUR', 'eur', '2024-01-10'), { rate: FX_ONE, date: '2024-01-10' });
});

test('a weekend or holiday takes the last fixing before it, and says which', () => {
  // Easter 2024: the ECB's last fixing before Tuesday the 2nd is Thursday the
  // 28th. A trade dated Saturday the 30th is ordinary retail paperwork, and
  // there is no Saturday rate anywhere — the Thursday fixing IS the rate in
  // force, and the returned `date` is what makes that visible rather than
  // indistinguishable from a same-day fixing.
  const rates = createFxRates([
    fx('EURUSD', '2024-03-28', 108110000),
    fx('EURUSD', '2024-04-02', 107490000),
  ]);

  for (const day of ['2024-03-29', '2024-03-30', '2024-03-31', '2024-04-01']) {
    assert.deepEqual(rates.rate('EUR', 'USD', day), { date: '2024-03-28', rate: 108110000 },
      `${day} should carry Thursday's fixing forward`);
  }
  // And the moment a new fixing exists it wins — the carry-forward never
  // reaches past the next published day.
  assert.deepEqual(rates.rate('EUR', 'USD', '2024-04-02'), { date: '2024-04-02', rate: 107490000 });
});

test('a fixing older than the carry-forward window is a gap, not a rate', () => {
  // The bound is the whole difference between "Friday's rate applies on
  // Saturday" and "a 2019 rate applies in 2024". A hole in the series must
  // surface, not be papered over with whatever is nearest.
  const rates = createFxRates([fx('EURUSD', '2024-01-10', 110000000)]);

  const lastCovered = new Date(Date.UTC(2024, 0, 10) + FX_CARRY_FORWARD_DAYS * 86400000)
    .toISOString().slice(0, 10);
  assert.ok(rates.rate('EUR', 'USD', lastCovered), 'the window itself is covered');

  const firstUncovered = new Date(Date.UTC(2024, 0, 11) + FX_CARRY_FORWARD_DAYS * 86400000)
    .toISOString().slice(0, 10);
  assert.equal(rates.rate('EUR', 'USD', firstUncovered), null);
  assert.equal(rates.rate('EUR', 'USD', '2024-06-01'), null);
});

test('the inverse of a stored pair is used — the ECB only publishes EUR-based rates', () => {
  // The motivating case: a European reporting in EUR who holds a US-listed
  // ETF. Nothing anywhere publishes USDEUR; it is 1/EURUSD.
  const rates = createFxRates([fx('EURUSD', '2024-01-10', 110000000)]);
  const got = rates.rate('USD', 'EUR', '2024-01-10');
  assert.equal(got.date, '2024-01-10');
  // 1e16 / 1.10e8 = 90909091 (0.90909091), rounded half away from zero.
  assert.equal(got.rate, 90909091);
});

test('two EUR-based pairs cross into a rate neither of them states', () => {
  // A CHF-reporting portfolio holding dollars: the ECB series has EURUSD and
  // EURCHF and no USDCHF at all, so without the cross the whole portfolio is
  // one large gap.
  const rates = createFxRates([
    fx('EURUSD', '2024-03-28', 108110000),
    fx('EURCHF', '2024-03-28', 97660000),
  ]);
  const got = rates.rate('USD', 'CHF', '2024-03-28');
  // (CHF per EUR) / (USD per EUR) = 0.9766 / 1.0811 = 0.903339...
  assert.equal(got.rate, 90333919);
  assert.equal(got.date, '2024-03-28');
});

test('a currency with no path to the reporting one is null, never approximated', () => {
  const rates = createFxRates([fx('EURUSD', '2024-01-10', 110000000)]);
  assert.equal(rates.rate('JPY', 'EUR', '2024-01-10'), null);
  assert.equal(rates.rate('EUR', 'USD', 'not-a-day'), null);
});

test('a malformed fx record is surfaced, not silently dropped', () => {
  const seen = [];
  const rates = createFxRates([
    fx('EURUSD', '2024-01-10', 110000000),
    fx('EUR/USD', '2024-01-11', 110000000, 'fx_bad_pair'),
    fx('EURUSD', '2024-02-30', 110000000, 'fx_bad_day'),
    fx('EURUSD', '2024-01-12', 0, 'fx_zero'),
    fx('EURUSD', '2024-01-13', 1.1, 'fx_float'),
  ], (code, recordId) => seen.push([code, recordId]));

  assert.deepEqual(seen, [
    ['malformed_fx', 'fx_bad_pair'],
    ['malformed_fx', 'fx_bad_day'],
    ['malformed_fx', 'fx_zero'],
    ['malformed_fx', 'fx_float'],
  ]);
  // The one good record still works — one bad row does not cost the series.
  assert.equal(rates.rate('EUR', 'USD', '2024-01-10').rate, 110000000);
});

// ---------------------------------------------------------------------------
// The ECB fetcher
// ---------------------------------------------------------------------------

test('the ECB payload parses into fx records, base first', () => {
  const rows = parseEcbCsv(ECB_CSV);
  // CURRENCY_DENOM is the base: 1 EUR = 1.0811 USD on 2024-03-28.
  assert.deepEqual(rows[0], { pair: 'EURCHF', date: '2024-03-28', rate: 97660000 });
  assert.deepEqual(rows[3], { pair: 'EURUSD', date: '2024-03-28', rate: 108110000 });
  assert.equal(rows.length, 6);
  // The holidays are absent from the response entirely, so nothing invents a
  // row for them.
  assert.deepEqual(rows.filter((r) => r.date === '2024-03-29'), []);
});

test('a shifted or unparseable row is dropped rather than stored as a rate', () => {
  const rows = parseEcbCsv([
    'CURRENCY,CURRENCY_DENOM,TIME_PERIOD,OBS_VALUE',
    'USD,EUR,2024-01-10,1.0811',
    'USD,EUR,2024-01-11,NaN',
    'USD,EUR,2024-01-12,',
    'USD,EUR,2024-01-13,0',
    'USD,EUR,2024-02-30,1.08',
    'US dollar/Euro ECB reference exchange rate,EUR,2024-01-14,1.08',
  ].join('\n'));
  assert.deepEqual(rows, [{ pair: 'EURUSD', date: '2024-01-10', rate: 108110000 }]);
});

test('a response missing the columns we read is an error, not an empty series', () => {
  assert.throws(() => parseEcbCsv('KEY,FREQ\nEXR.D.USD.EUR.SP00.A,D'), /CURRENCY/);
});

test('refresh stores one fx record per pair-day under a deterministic id', async () => {
  const f = fixture();
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'EUR' }, 'acct_1');
  f.put('security', { name: 'Acme', currency: 'USD' }, 'sec_1');
  f.put('transaction', { type: 'buy', date: '2024-03-28', currency: 'USD', amount: 100 }, 'tx_1');

  const calls = [];
  const domain = createFxDomain({
    records: f.records,
    http: httpOk(ECB_CSV, calls),
    now: () => Date.UTC(2024, 3, 3),
  });
  const out = await domain.refresh();

  const url = new URL(calls[0].url);
  assert.equal(url.host, FX_HOSTS.ecb, 'the host must be the enumerable one, for the CSP allowlist');
  // The euro itself has no series; only the foreign leg is fetched, and the
  // range spans the transaction log up to today — reaching a carry-forward
  // window back past the first trade, see the weekend test below.
  assert.equal(url.pathname, '/service/data/EXR/D.USD.EUR.SP00.A');
  assert.equal(url.searchParams.get('startPeriod'), '2024-03-21');
  assert.equal(url.searchParams.get('endPeriod'), '2024-04-03');
  assert.equal(url.searchParams.get('format'), 'csvdata');

  assert.deepEqual(out.errors, []);
  assert.equal(out.written, 6);
  assert.deepEqual(f.writes[0], {
    recordType: 'fx',
    recordId: 'fx_EURCHF_2024-03-28',
    body: { pair: 'EURCHF', date: '2024-03-28', rate: 97660000 },
  });
});

test('the default range reaches back past a first trade dated on a weekend', async () => {
  // Found by codex review. A portfolio whose earliest trade is a Saturday has
  // no fixing on that day BY DEFINITION, so a range starting there fetches
  // everything except the one rate that day needs — and the user gets a
  // `currency_not_converted` gap immediately after a refresh that said it
  // succeeded. The carry-forward rule and the fetch range have to agree.
  const f = fixture();
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('transaction', { type: 'buy', date: '2024-03-30', currency: 'USD', amount: 100 }, 'tx_sat');

  const calls = [];
  const domain = createFxDomain({
    records: f.records, http: httpOk(ECB_CSV, calls), now: () => Date.UTC(2024, 3, 3),
  });
  await domain.refresh();

  const start = new URL(calls[0].url).searchParams.get('startPeriod');
  assert.equal(start, '2024-03-23');
  assert.ok(start < '2024-03-28', 'Thursday 03-28 is the fixing that carries onto Saturday 03-30');

  // And end to end: the Saturday trade converts, with no gap left behind.
  const rates = createFxRates(await f.records.list('fx'));
  assert.deepEqual(rates.rate('USD', 'EUR', '2024-03-30').date, '2024-03-28');
});

test('an explicit range is honoured as asked, not silently widened', async () => {
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'USD' }, 'acct_1');
  const calls = [];
  const domain = createFxDomain({
    records: f.records, http: httpOk(ECB_CSV, calls), now: () => Date.UTC(2024, 3, 3),
  });
  await domain.refresh({ from: '2024-03-28', to: '2024-04-03' });

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('startPeriod'), '2024-03-28');
  assert.equal(url.searchParams.get('endPeriod'), '2024-04-03');
});

test('a second refresh rewrites nothing that has not changed', async () => {
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'USD' }, 'acct_1');
  const domain = createFxDomain({
    records: f.records, http: httpOk(ECB_CSV), now: () => Date.UTC(2024, 3, 3),
  });

  assert.equal((await domain.refresh()).written, 6);
  const again = await domain.refresh();
  // Re-putting a decade of unchanged history would bump clientTs on every
  // record and hand §6's sync blob a full rewrite for nothing.
  assert.equal(again.written, 0);
  assert.equal(again.skipped, 6);
  assert.equal(f.writes.length, 6);
});

test('a single-currency portfolio fetches nothing at all', async () => {
  const f = fixture();
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'EUR' }, 'acct_1');
  let called = false;
  const domain = createFxDomain({
    records: f.records,
    http: async () => { called = true; throw new Error('should not be reached'); },
    now: () => Date.UTC(2024, 3, 3),
  });

  assert.deepEqual(await domain.refresh(), {
    written: 0, skipped: 0, errors: [], pairs: [], from: null, to: null,
  });
  assert.equal(called, false);
});

test('a dead provider is reported, never thrown — stale rates beat an error screen', async () => {
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'USD' }, 'acct_1');
  const domain = createFxDomain({
    records: f.records,
    http: async () => ({ ok: false, status: 429, async text() { return ''; } }),
    now: () => Date.UTC(2024, 3, 3),
  });

  const out = await domain.refresh();
  assert.equal(out.written, 0);
  assert.deepEqual(out.errors.map((e) => e.code), ['rate_limited']);
  assert.deepEqual(out.pairs, ['EURUSD']);
});

test('a transport that hangs is abandoned at the deadline', async () => {
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'USD' }, 'acct_1');
  let aborted = false;
  const domain = createFxDomain({
    records: f.records,
    now: () => Date.UTC(2024, 3, 3),
    timeoutMs: 5,
    // A half-open connection — a captive portal, not clean airplane mode.
    http: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });

  const out = await domain.refresh();
  assert.deepEqual(out.errors.map((e) => e.code), ['fetch_failed']);
  assert.equal(aborted, true, 'the socket must actually be freed, not just raced');
});

test('an http port is required rather than reached for', () => {
  assert.throws(() => createFxDomain({ records: {} }), /http port is required/);
});

test('the host list is frozen and enumerable, for the CSP connect-src allowlist', () => {
  assert.ok(Object.isFrozen(FX_HOSTS));
  assert.deepEqual(Object.values(FX_HOSTS), ['data-api.ecb.europa.eu']);
});
