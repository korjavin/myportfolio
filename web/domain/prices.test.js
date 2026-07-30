import test from 'node:test';
import assert from 'node:assert/strict';

import { createPricesDomain } from './prices.js';
import { createPortfolioDomain } from './portfolio.js';

// The same in-memory §3 port portfolio.test.js uses.
function fixture() {
  const byType = new Map();
  let n = 0;
  const put = (recordType, body, recordId) => {
    const id = recordId || `${recordType}_${++n}`;
    if (!byType.has(recordType)) byType.set(recordType, []);
    byType.get(recordType).push({ ...body, recordId: id, recordType, clientTs: 1, deleted: false });
    return id;
  };
  let reads = 0;
  const records = {
    async list(recordType) {
      reads += 1;
      return (byType.get(recordType) || []).slice();
    },
  };
  return {
    put,
    records,
    series: (securityId, range) => createPricesDomain({ records }).series(securityId, range),
    seriesFor: (ids, range) => createPricesDomain({ records }).seriesFor(ids, range),
    reads: () => reads,
    snapshot: (opts) => createPortfolioDomain({ records }).snapshot(opts),
  };
}

// §4: one price record per security-year. `closes` keys are zero-padded MM-DD,
// values are 1e8 fixed-point.
const chunk = (securityId, year, closes) => ({ securityId, year, closes });

const dates = (series) => series.map((p) => p.date);

test('merges the chunks of several years into one ascending series', async () => {
  const f = fixture();
  // Deliberately inserted newest-first and with the partial year in the middle:
  // the reader must not inherit record order.
  f.put('price', chunk('sec_1', '2024', { '01-02': 4200000000, '12-31': 4500000000 }));
  f.put('price', chunk('sec_1', '2022', { '11-04': 3900000000 }));
  f.put('price', chunk('sec_1', '2023', { '03-15': 4000000000, '01-09': 3800000000 }));
  // A partial year — the one that is still filling up. No December key.
  f.put('price', chunk('sec_1', '2025', { '02-03': 4600000000 }));

  const series = await f.series('sec_1');

  assert.deepEqual(dates(series), [
    '2022-11-04', '2023-01-09', '2023-03-15', '2024-01-02', '2024-12-31', '2025-02-03',
  ]);
  // Fixed-point integers out, exactly as stored. A float here means the domain
  // layer crossed the §5 render boundary.
  assert.deepEqual(series.map((p) => p.close), [
    3900000000, 3800000000, 4000000000, 4200000000, 4500000000, 4600000000,
  ]);
  for (const p of series) assert.ok(Number.isSafeInteger(p.close), `${p.date} close is not an integer`);
});

test('another security\'s chunks never leak into the series', async () => {
  const f = fixture();
  f.put('price', chunk('sec_1', '2024', { '01-02': 100000000 }));
  f.put('price', chunk('sec_2', '2024', { '01-03': 999000000 }));

  assert.deepEqual(await f.series('sec_1'), [{ date: '2024-01-02', close: 100000000 }]);
  assert.deepEqual(await f.series('sec_2'), [{ date: '2024-01-03', close: 999000000 }]);
});

test('{from, to} clips both ends inclusively, across chunk boundaries', async () => {
  const f = fixture();
  f.put('price', chunk('sec_1', '2023', { '06-01': 1, '12-30': 2, '12-31': 3 }));
  f.put('price', chunk('sec_1', '2024', { '01-01': 4, '01-02': 5, '09-09': 6 }));

  const clipped = await f.series('sec_1', { from: '2023-12-31', to: '2024-01-02' });
  assert.deepEqual(dates(clipped), ['2023-12-31', '2024-01-01', '2024-01-02']);
  // The bounds themselves are kept, not excluded.
  assert.deepEqual(clipped.map((p) => p.close), [3, 4, 5]);

  // One-sided windows.
  assert.deepEqual(dates(await f.series('sec_1', { from: '2024-01-02' })), ['2024-01-02', '2024-09-09']);
  assert.deepEqual(dates(await f.series('sec_1', { to: '2023-06-01' })), ['2023-06-01']);
  // A window that lands between two closes is empty, not "the nearest one".
  assert.deepEqual(await f.series('sec_1', { from: '2024-01-03', to: '2024-06-30' }), []);
});

test('a security with no price records is an empty series, not a throw', async () => {
  const f = fixture();
  f.put('price', chunk('sec_other', '2024', { '01-02': 100000000 }));

  assert.deepEqual(await f.series('sec_1'), []);
  // No price records at all, and no securityId at all.
  assert.deepEqual(await fixture().series('sec_1'), []);
  assert.deepEqual(await f.series(undefined), []);
});

test('a single close comes back as a one-point series', async () => {
  const f = fixture();
  f.put('price', chunk('sec_1', '2024', { '05-02': 4123500000 }));

  assert.deepEqual(await f.series('sec_1'), [{ date: '2024-05-02', close: 4123500000 }]);
});

test('a malformed chunk or key is skipped, and cannot become the newest close', async () => {
  const f = fixture();
  f.put('price', chunk('sec_1', '2024', { '01-02': 100000000 }));
  // Unpadded: "2024-3-15" > "2024-12-31" as a string, so accepting it would put
  // it at the end of the series and report it as the latest quote.
  f.put('price', chunk('sec_1', '2024', { '3-15': 200000000 }));
  // Out of range, non-integer close, and a chunk with no year at all.
  // (Month 13 is rejected; "02-30" is NOT — the key is validated for shape, not
  // for calendar existence, exactly as portfolio.js validates it. Sorting and
  // clipping only need the padding, and a stricter rule here would be a second
  // rule, which is the drift this file exists to prevent.)
  f.put('price', chunk('sec_1', '2024', { '13-01': 300000000 }));
  f.put('price', chunk('sec_1', '2024', { '04-01': 1.5 }));
  f.put('price', { securityId: 'sec_1', closes: { '06-01': 400000000 } });

  assert.deepEqual(await f.series('sec_1'), [{ date: '2024-01-02', close: 100000000 }]);
});

test('the last point agrees with the quote portfolio.js values the position at', async () => {
  // The anti-drift pin. portfolio.js carries its own copy of this chunk
  // validation (private latestCloses) and reads the same records; if the two
  // parsers ever disagree — about padding, about range, about what an integer
  // is — the chart and the holdings row show different "latest" prices off one
  // record. Asserted over the malformed keys, which is where they would drift.
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'EUR' }, 'acct_1');
  f.put('account', { name: 'Depot', kind: 'securities', currency: 'EUR' }, 'pf_1');
  f.put('security', { name: 'Acme', ticker: 'ACME', currency: 'EUR' }, 'sec_1');
  f.put('transaction', {
    type: 'buy', accountId: 'acct_1', portfolioId: 'pf_1', securityId: 'sec_1',
    date: '2023-01-01', shares: 100000000, amount: 100000, currency: 'EUR',
  });
  f.put('price', chunk('sec_1', '2023', { '01-09': 3800000000, '03-15': 4000000000 }));
  f.put('price', chunk('sec_1', '2024', { '01-02': 4200000000, '3-15': 9900000000, '13-01': 9900000000 }));

  const series = await f.series('sec_1');
  const snap = await f.snapshot();
  const position = snap.positions[0];

  const last = series[series.length - 1];
  assert.equal(last.date, position.priceDate);
  assert.equal(last.close, position.price);
  assert.equal(last.close, 4200000000, 'a malformed key must not win the latest-close race in either reader');

  // Two chunks for the same security-year, disagreeing about one day. This is
  // reachable: ppimport.js mints price_<hash> for a security-year and
  // store.putPrice mints price_<securityId>_<year>, so importing a PP file and
  // then typing a close by hand leaves both behind (quotes.js carries its own
  // tiebreak for exactly this). The chart must not draw two points on one date,
  // and the one it treats as the latest must be the one the holdings row is
  // valued at.
  f.put('price', chunk('sec_1', '2024', { '01-02': 7777000000 }), 'price_pp_deadbeef');
  const merged = await f.series('sec_1');
  const mergedSnap = await f.snapshot();
  assert.deepEqual(
    merged.map((p) => p.date).filter((d) => d === '2024-01-02'),
    ['2024-01-02'],
    'a duplicated date must collapse to one point'
  );
  assert.equal(merged[merged.length - 1].close, mergedSnap.positions[0].price);
  assert.equal(merged[merged.length - 1].date, mergedSnap.positions[0].priceDate);

  // And under a window: asOf and `to` must select the same close.
  const asOf = '2023-06-30';
  const clipped = await f.series('sec_1', { to: asOf });
  const historical = (await f.snapshot({ asOf })).positions[0];
  assert.equal(clipped[clipped.length - 1].date, historical.priceDate);
  assert.equal(clipped[clipped.length - 1].close, historical.price);
});

test('seriesFor reads the price store once for the whole holdings list', async () => {
  // What the Holdings sparklines need: one read, not one per row. Called
  // per-security instead, a twenty-position list structured-clones every price
  // chunk in the database twenty times on every render.
  const f = fixture();
  f.put('price', chunk('sec_1', '2024', { '01-02': 100000000, '02-02': 120000000 }));
  f.put('price', chunk('sec_2', '2024', { '01-03': 999000000 }));

  const before = f.reads();
  const got = await f.seriesFor(['sec_1', 'sec_2', 'sec_none']);
  assert.equal(f.reads() - before, 1);

  // Every id asked for gets an entry, including the one with no closes — a row
  // with no history must render its empty slot, not fall off the map.
  assert.deepEqual([...got.keys()], ['sec_1', 'sec_2', 'sec_none']);
  assert.deepEqual(got.get('sec_1'), [
    { date: '2024-01-02', close: 100000000 },
    { date: '2024-02-02', close: 120000000 },
  ]);
  assert.deepEqual(got.get('sec_2'), [{ date: '2024-01-03', close: 999000000 }]);
  assert.deepEqual(got.get('sec_none'), []);
  assert.deepEqual(await f.seriesFor([]), new Map());
});

test('seriesFor agrees with series() point for point — one reader, not two', async () => {
  // series() is now a one-security call into seriesFor, and this is what pins
  // it: the dedupe, the clipping and the ordering have a single implementation.
  const f = fixture();
  f.put('price', chunk('sec_1', '2024', { '01-02': 100000000, '3-15': 200000000 }));
  f.put('price', chunk('sec_1', '2024', { '01-02': 555000000, '06-01': 300000000 }));
  f.put('price', chunk('sec_1', '2023', { '12-31': 90000000 }));

  const range = { from: '2023-12-31', to: '2024-01-31' };
  assert.deepEqual((await f.seriesFor(['sec_1'])).get('sec_1'), await f.series('sec_1'));
  assert.deepEqual((await f.seriesFor(['sec_1'], range)).get('sec_1'), await f.series('sec_1', range));
});
