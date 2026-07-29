// Tests for the Portfolio Performance importer.
//
// FIXTURE PROVENANCE — this matters, because a fixture written from our own
// reading of the format only proves we can parse what we imagined.
// web/domain/fixtures/*.xml are copied BYTE-FOR-BYTE from Portfolio
// Performance's own test resources at
// https://github.com/portfolio-performance/portfolio, master @
// 729a58e08ce3f8bc898ce39256499bbca406c07c (2026-07-28), from
// name.abuchen.portfolio.tests/src/:
//
//   Issue4446FIFOMultipleTransfers.xml         issues/       file version 66
//   Issue4446FIFOTransferWithSameDayPurchase.xml issues/     file version 66
//   client69.xml                               fileversions/ file version 69 (current)
//   client_with_id_references.xml              fileversions/ file version 63, ID reference mode
//
// They are real PP output: written by PP's own serializer, kept in PP's repo as
// the regression corpus for its transfer and file-format code. What they are
// NOT is a big personal portfolio — they are focused test files, so they are
// thin on price history and on the long tail of account transaction types. The
// CSV fixtures below are synthetic, built from the exporter source
// (datatransfer/csv/exporter/CSVExporter.java, same commit) rather than from a
// running PP; PP's CSV output is locale-dependent and cannot be obtained
// without running the app. That is a real limitation and is called out in the
// bead report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parsePP, batches } from './ppimport.js';
import { createPortfolioDomain, CASH_SIGN } from './portfolio.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

// A records port double (ARCHITECTURE.md §3) so the imported records can be
// folded by the real engine — the acceptance criteria are about what the
// portfolio *computes*, not about the shape of the JSON.
function fakeRecords() {
  const rows = new Map();
  return {
    rows,
    async list(recordType) {
      return [...rows.values()].filter((r) => r.recordType === recordType && !r.deleted);
    },
    async put(recordType, recordId, body) {
      rows.set(recordId, { ...body, recordId, recordType, deleted: false, clientTs: 1 });
    },
    async del() {},
  };
}

async function applyAll(records, port) {
  for (const batch of batches(records, 3)) {
    for (const r of batch) {
      const { recordType, recordId, ...body } = r;
      await port.put(recordType, recordId, body);
    }
  }
}

const ofType = (records, t) => records.filter((r) => r.recordType === t);
const codes = (report) => report.entries.map((e) => e.code);

// ---------------------------------------------------------------------------
// XML — the real fixture, end to end
// ---------------------------------------------------------------------------
//
// Issue4446FIFOMultipleTransfers.xml, by hand from the source:
//   1 security (ADIDAS AG NA O.N., DE000A1EWWW0)
//   1 cash account "Konto", 4 securities accounts "Depot 1".."Depot 4"
//   5 trades: BUY 5@500.00 (09-21), BUY 5@500.00 (09-22), BUY 5@1000.00
//             (10-21), BUY 5@1000.00 (10-22), SELL 10@3000.00 (12-24)
//   3 portfolio transfers, i.e. 6 legs, which §4 cannot represent
// Every trade is written twice by PP (cash side + securities side), so the file
// holds 16 transaction elements: 5 trades x 2 + 6 transfer legs.

test('XML: a real PP file imports with every source row accounted for', () => {
  const { format, records, report } = parsePP(fixture('Issue4446FIFOMultipleTransfers.xml'));

  assert.equal(format, 'xml');
  assert.equal(report.ok, true);

  // Nothing vanishes: every element in the file is imported, merged into a
  // trade, or explicitly skipped with an entry.
  assert.deepEqual(report.counts, { sourceRows: 16, imported: 5, merged: 5, skipped: 6 });
  assert.equal(
    report.counts.sourceRows,
    report.counts.imported + report.counts.merged + report.counts.skipped,
  );

  assert.equal(ofType(records, 'security').length, 1);
  assert.equal(ofType(records, 'account').length, 5);
  assert.equal(ofType(records, 'transaction').length, 5);

  const security = ofType(records, 'security')[0];
  assert.equal(security.name, 'ADIDAS AG NA O.N.');
  assert.equal(security.isin, 'DE000A1EWWW0');
  assert.equal(security.ticker, 'ADS');
  assert.equal(security.currency, 'EUR');

  // The 4 securities accounts are reachable ONLY through XStream references
  // into objects defined inside a cross-entry five levels down. Finding all
  // four is the proof that reference resolution works.
  const names = ofType(records, 'account').map((a) => a.name).sort();
  assert.deepEqual(names, ['Depot 1', 'Depot 2', 'Depot 3', 'Depot 4', 'Konto']);
  assert.equal(ofType(records, 'account').filter((a) => a.kind === 'cash').length, 1);

  // All 6 refused rows are the security transfers, each named individually.
  const skipped = report.entries.filter((e) => e.severity === 'warning');
  assert.equal(skipped.length, 6);
  assert.ok(skipped.every((e) => e.code === 'security_transfer_unsupported'));
  assert.ok(skipped.every((e) => /myportfolio-g7e\.10/.test(e.message)));
  // The report points at a real location in the file, not just "somewhere".
  assert.ok(skipped.every((e) => /^\/client\[1\]\//.test(e.location.path)));
});

test('XML: amounts, shares and fees arrive as the file\'s own integers', () => {
  const { records } = parsePP(fixture('Issue4446FIFOMultipleTransfers.xml'));
  const trades = ofType(records, 'transaction').slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  assert.deepEqual(trades.map((t) => [t.type, t.date, t.shares, t.amount]), [
    ['buy', '2020-09-21', 500000000, 50000],
    ['buy', '2020-09-22', 500000000, 50000],
    ['buy', '2020-10-21', 500000000, 100000],
    ['buy', '2020-10-22', 500000000, 100000],
    ['sell', '2020-12-24', 1000000000, 300000],
  ]);
  // Every trade books to the one cash account, per §4's "accountId is the
  // account `amount` moves on".
  const cashId = ofType(records, 'account').find((a) => a.name === 'Konto').recordId;
  assert.ok(trades.every((t) => t.accountId === cashId));
  // …and names the securities account its shares land in as well, which is the
  // other half of §4's position key. PP's buysell cross-entry carries both, so
  // the depot is read out of the file rather than inferred.
  const depot = (name) => ofType(records, 'account').find((a) => a.name === name).recordId;
  assert.deepEqual(trades.map((t) => t.portfolioId), [
    depot('Depot 1'), depot('Depot 2'), depot('Depot 1'), depot('Depot 2'), depot('Depot 4'),
  ]);
  assert.equal(trades[4].note, 'buy-in should be 1000');
  assert.ok(trades.every((t) => Number.isSafeInteger(t.amount) && Number.isSafeInteger(t.shares)));
});

test('XML: the imported portfolio matches the source portfolio', async () => {
  const { records, report } = parsePP(fixture('Issue4446FIFOMultipleTransfers.xml'));
  const port = fakeRecords();
  await applyAll(records, port);
  const snapshot = await createPortfolioDomain({ records: port }).snapshot();

  // Per-security share total: 5 + 5 + 5 + 5 - 10 = 10 shares (1e8 scale). That
  // is the portfolio-wide view; §4 keys the holdings themselves by the depot
  // they sit in, and this file uses four.
  assert.equal(snapshot.securities.length, 1);
  assert.equal(snapshot.securities[0].shares, 10 * 1e8);

  // Cash: -500 -500 -1000 -1000 +3000 = 0.00 on "Konto", nothing anywhere else.
  const konto = snapshot.accounts.find((a) => a.name === 'Konto');
  assert.equal(konto.balance, 0);
  assert.equal(snapshot.totals.cash, 0);

  // And here is what a depot-keyed fold makes visible that a security-keyed one
  // hid: this file only balances because it moves shares between depots, and §4
  // cannot carry a cost basis across that move (myportfolio-g7e.10), so the
  // importer refuses the six transfer legs. Depot 4 therefore sells shares it
  // was never seen to receive — an oversell, said out loud, rather than a
  // plausible-looking basis silently borrowed from a different broker.
  assert.deepEqual(snapshot.positions.map((p) => [p.accountName, p.shares, p.cost, p.realized]), [
    ['Depot 1', 10 * 1e8, 150000, 0],
    ['Depot 2', 10 * 1e8, 150000, 0],
    ['Depot 4', -10 * 1e8, 0, 300000],
  ]);
  assert.deepEqual([...new Set(snapshot.issues.map((i) => i.code))], ['oversell', 'no_price']);
  assert.ok(report.entries.some((e) => e.code === 'security_transfer_unsupported'),
    'the import report already named the reason');
});

test('XML: re-importing the same file produces zero new records', async () => {
  const text = fixture('Issue4446FIFOMultipleTransfers.xml');
  const first = parsePP(text);
  const second = parsePP(text);

  assert.deepEqual(
    first.records.map((r) => r.recordId).sort(),
    second.records.map((r) => r.recordId).sort(),
  );
  // Ids are derived, not minted: no timestamp, no randomness. (`settings` is
  // §4's fixed singleton id and is the one record that is not derived.)
  assert.ok(first.records.every((r) => r.recordId === 'settings' || /_pp_[0-9a-f-]+$/.test(r.recordId)));

  const port = fakeRecords();
  await applyAll(first.records, port);
  const afterFirst = port.rows.size;
  await applyAll(second.records, port);
  assert.equal(port.rows.size, afterFirst);
  assert.equal(afterFirst, first.records.length);

  // ...and the portfolio is unchanged, which is the thing the user would
  // actually notice if idempotency were broken.
  const snapshot = await createPortfolioDomain({ records: port }).snapshot();
  assert.equal(snapshot.securities[0].shares, 10 * 1e8);
  assert.equal(snapshot.totals.cash, 0);
});

// The same corpus's bigger file: 80 transaction elements, 140 daily closes, a
// real position that ends up valued. Its expectations are derived from the raw
// text by regex — deliberately NOT from the importer's own DOM walk and
// reference resolution, so the two have to agree independently.
test('XML: a larger real file reconciles against the raw source text', async () => {
  const text = fixture('Issue4446FIFOTransferWithSameDayPurchase.xml');
  const source = {};
  for (const [, t] of text.matchAll(/<type>([A-Z_]+)<\/type>/g)) source[t] = (source[t] ?? 0) + 1;
  const rawCloses = [...text.matchAll(/<price t="/g)].length;

  assert.deepEqual(source, { BUY: 48, SELL: 4, DEPOSIT: 24, REMOVAL: 2, TRANSFER_IN: 1, TRANSFER_OUT: 1 });

  const { records, report } = parsePP(text);
  const total = Object.values(source).reduce((a, b) => a + b, 0);
  assert.equal(report.counts.sourceRows, total);
  assert.equal(report.counts.imported + report.counts.merged + report.counts.skipped, total);

  // A trade is written twice by PP, so its 2N elements become N records.
  const histogram = {};
  for (const t of ofType(records, 'transaction')) histogram[t.type] = (histogram[t.type] ?? 0) + 1;
  assert.deepEqual(histogram, {
    buy: source.BUY / 2,
    sell: source.SELL / 2,
    deposit: source.DEPOSIT,
    removal: source.REMOVAL,
  });
  assert.equal(report.counts.merged, (source.BUY + source.SELL) / 2);
  // The two security-transfer legs are refused, and nothing else is.
  assert.equal(report.counts.skipped, source.TRANSFER_IN + source.TRANSFER_OUT);

  // Every daily close survives, chunked into a handful of security-year records
  // rather than one record per day (§4 "Price series storage").
  const prices = ofType(records, 'price');
  const closes = prices.reduce((n, p) => n + Object.keys(p.closes).length, 0);
  assert.equal(closes, rawCloses);
  assert.ok(prices.length < 10, `expected chunking, got ${prices.length} price records for ${closes} closes`);

  // And the engine folds it cleanly: every account resolved, every unit an
  // integer, the holding priced. The one complaint is the same §4 gap as the
  // smaller file — this portfolio moved its shares from one depot to the other,
  // that transfer is not representable (myportfolio-g7e.10) and so was not
  // imported, and the depot that sold them is short by exactly that transfer.
  const port = fakeRecords();
  await applyAll(records, port);
  const snapshot = await createPortfolioDomain({ records: port }).snapshot();
  assert.deepEqual([...new Set(snapshot.issues.map((i) => i.code))], ['oversell']);
  assert.equal(snapshot.securities.length, 1);
  assert.equal(snapshot.positions.length, 2, 'two depots, so two holdings of the one security');
  assert.ok(snapshot.securities[0].shares > 0);
  assert.ok(snapshot.totals.marketValue > 0);
  assert.ok(Number.isSafeInteger(snapshot.totals.total));
});

test('XML: a current-version file imports a dividend with its tax unit', () => {
  const { records, report } = parsePP(fixture('client69.xml'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { sourceRows: 1, imported: 1, merged: 0, skipped: 0 });

  const [tx] = ofType(records, 'transaction');
  assert.equal(tx.type, 'dividend');
  assert.equal(tx.date, '2019-05-27');
  assert.equal(tx.amount, 1007);   // 10.07 EUR, exactly as the file states it
  assert.equal(tx.taxes, 393);     // <unit type="TAX">
  assert.equal(tx.shares, 70 * 1e8);
  assert.equal(tx.currency, 'EUR');
  assert.equal(tx.note, 'Abrechnungs-Nr. 19200128');

  // The base currency is reported, never written: `settings` is a §4 singleton
  // whose body also holds quoteProviders, and the §3 port replaces bodies
  // wholesale, so importing one would wipe the user's quote configuration.
  assert.equal(ofType(records, 'settings').length, 0);
  assert.ok(report.entries.some((e) => e.code === 'pp_base_currency' && /EUR/.test(e.message)));
  // The securities account is kept even though §4 books nothing to it.
  assert.equal(ofType(records, 'account').length, 2);
});

test('XML: ID-reference mode resolves as well as relative-path mode', () => {
  const { records, report } = parsePP(fixture('client_with_id_references.xml'));
  assert.equal(report.ok, true);
  assert.equal(ofType(records, 'security').length, 2);

  // Both securities share one <latest> element; the second reaches it through
  // reference="3". Both must end up with the same close on the same day.
  const prices = ofType(records, 'price');
  assert.equal(prices.length, 2);
  assert.ok(prices.every((p) => p.year === '2024'));
  assert.deepEqual(prices.map((p) => p.closes), [{ '08-05': 10 }, { '08-05': 10 }]);
  // §4: zero-padded MM-DD, because unpadded keys sort wrong as strings.
  assert.ok(prices.every((p) => Object.keys(p.closes).every((k) => /^\d{2}-\d{2}$/.test(k))));
});

// ---------------------------------------------------------------------------
// XML — the failure modes that must never be silent
// ---------------------------------------------------------------------------

const clientXml = (version, inner) => `<client>
  <version>${version}</version>
  <baseCurrency>EUR</baseCurrency>
  <securities/>
  <accounts>
    <account>
      <uuid>aaaaaaaa-0000-0000-0000-000000000001</uuid>
      <name>Konto</name>
      <currencyCode>EUR</currencyCode>
      <isRetired>false</isRetired>
      <transactions>${inner}</transactions>
    </account>
  </accounts>
  <portfolios/>
</client>`;

const accountTx = (type, extra = '') => `
  <account-transaction>
    <uuid>bbbbbbbb-0000-0000-0000-00000000000${type.length % 10}</uuid>
    <date>2024-03-04T00:00</date>
    <currencyCode>EUR</currencyCode>
    <amount>12345</amount>
    <shares>0</shares>${extra}
    <type>${type}</type>
  </account-transaction>`;

test('XML: an unknown transaction type is reported, not discarded', () => {
  const { records, report } = parsePP(clientXml(69, accountTx('DEPOSIT') + accountTx('QUANTUM_ENTANGLEMENT')));

  assert.equal(ofType(records, 'transaction').length, 1);
  assert.deepEqual(report.counts, { sourceRows: 2, imported: 1, merged: 0, skipped: 1 });

  const entry = report.entries.find((e) => e.code === 'pp_unmapped_transaction_type');
  assert.ok(entry, 'the unmapped row must produce a report entry');
  assert.match(entry.message, /QUANTUM_ENTANGLEMENT/);
  assert.match(entry.location.path, /account-transaction\[2\]/);
  // A skipped row is not an error — the rest of the file still imports.
  assert.equal(entry.severity, 'warning');
  assert.equal(report.ok, true);
});

test('XML: a pre-migration file version is refused rather than scaled wrong', () => {
  const { records, report } = parsePP(clientXml(29, accountTx('DEPOSIT')));
  assert.deepEqual(records, []);
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report), ['pp_version_unsupported']);
  assert.match(report.entries[0].message, /re-save/);
});

test('XML: PP\'s sign-flipped types keep the cash moving the right way', async () => {
  const { records, report } = parsePP(clientXml(69,
    accountTx('DEPOSIT') + accountTx('INTEREST_CHARGE') + accountTx('FEES_REFUND') + accountTx('TAX_REFUND')));

  const byType = Object.fromEntries(ofType(records, 'transaction').map((t) => [t.type, t.amount]));
  assert.deepEqual(byType, { deposit: 12345, interest: -12345, fee: -12345, tax: -12345 });
  // Reinterpretation is surfaced per row, not buried.
  assert.equal(report.entries.filter((e) => e.code === 'pp_type_reinterpreted').length, 3);

  const port = fakeRecords();
  await applyAll(records, port);
  const snapshot = await createPortfolioDomain({ records: port }).snapshot();
  // +123.45 deposit, -123.45 interest charge, -123.45 fee refund... which is a
  // refund, so it *adds* cash: fee has CASH_SIGN -1 and the amount is negative.
  assert.equal(snapshot.totals.cash, 12345 - 12345 + 12345 + 12345);
});

test('XML: a dangling reference is an error, not a half-read record', () => {
  const { report } = parsePP(clientXml(69, `
    <account-transaction>
      <date>2024-03-04T00:00</date>
      <currencyCode>EUR</currencyCode>
      <amount>100</amount>
      <security reference="../../../../../nowhere/at/all"/>
      <type>DIVIDENDS</type>
    </account-transaction>`));
  assert.ok(codes(report).includes('pp_unresolved_reference'));
  assert.equal(report.ok, false);
});

test('XML: malformed input is reported, never thrown at the caller', () => {
  for (const bad of ['<client><version>69</version>', 'not xml at all <', '<other><x/></other>']) {
    const { records, report } = parsePP(bad, { format: 'xml' });
    assert.deepEqual(records, []);
    assert.equal(report.ok, false);
  }
});

test('XML: two identical rows stay two records', () => {
  // No uuid, so the id falls back to a content hash — and identical content
  // must still yield two distinct ids or a real duplicate trade vanishes.
  const row = `
    <account-transaction>
      <date>2024-03-04T00:00</date>
      <currencyCode>EUR</currencyCode>
      <amount>5000</amount>
      <type>DEPOSIT</type>
    </account-transaction>`;
  const { records } = parsePP(clientXml(69, row + row));
  const ids = ofType(records, 'transaction').map((r) => r.recordId);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

test('XML: price history is chunked per security-year with padded keys', () => {
  const { records } = parsePP(`<client>
    <version>69</version><baseCurrency>EUR</baseCurrency>
    <securities><security>
      <uuid>cccccccc-0000-0000-0000-000000000001</uuid>
      <name>Test</name><currencyCode>EUR</currencyCode>
      <prices>
        <price t="2023-01-02" v="4123500000"/>
        <price t="2023-12-31" v="4200000000"/>
        <price t="2024-03-05" v="4300000000"/>
      </prices>
    </security></securities>
    <accounts/><portfolios/>
  </client>`);
  const prices = ofType(records, 'price').sort((a, b) => (a.year < b.year ? -1 : 1));
  assert.equal(prices.length, 2);
  assert.deepEqual(prices[0], {
    recordType: 'price',
    recordId: prices[0].recordId,
    securityId: prices[0].securityId,
    year: '2023',
    closes: { '01-02': 4123500000, '12-31': 4200000000 },
  });
  assert.deepEqual(prices[1].closes, { '03-05': 4300000000 });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
//
// Synthetic, but written to CSVExporter's exact shape: 15 columns in
// writeHeader's order, CRLF, quote '"', and the delimiter / number format /
// column labels / type labels all from the UI locale.

const CSV_EN_HEADER = 'Date,Type,Value,Transaction Currency,Gross Amount,Currency Gross Amount,'
  + 'Exchange Rate,Fees,Taxes,Shares,ISIN,WKN,Ticker Symbol,Security Name,Note';

const CSV_EN = [
  CSV_EN_HEADER,
  '2020-09-21T00:00,Buy,"-1,234.56",EUR,,,,5.00,1.00,10,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
  '2020-11-02T00:00,Deposit,500.00,EUR,,,,,,,,,,,pay day',
  '2021-01-15T00:00,Dividend,25.00,EUR,,,,,3.00,10,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
  '2021-02-01T00:00,Sell,"1,000.00",EUR,,,,2.00,,5,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
].join('\r\n');

test('CSV: the English export imports with no rounding', () => {
  const { format, records, report } = parsePP(CSV_EN, { accountName: 'Broker' });
  assert.equal(format, 'csv');
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { sourceRows: 4, imported: 4, merged: 0, skipped: 0 });

  const tx = ofType(records, 'transaction');
  assert.deepEqual(tx.map((t) => [t.type, t.date, t.amount, t.shares ?? 0, t.fees ?? 0, t.taxes ?? 0]), [
    ['buy', '2020-09-21', 123456, 10 * 1e8, 500, 100],
    ['deposit', '2020-11-02', 50000, 0, 0, 0],
    ['dividend', '2021-01-15', 2500, 10 * 1e8, 0, 300],
    ['sell', '2021-02-01', 100000, 5 * 1e8, 200, 0],
  ]);
  assert.equal(ofType(records, 'account')[0].name, 'Broker');
  assert.equal(ofType(records, 'security')[0].isin, 'DE000A1EWWW0');
  // The file names no account, and the user is told rather than left guessing.
  assert.ok(codes(report).includes('csv_no_account_column'));
});

test('CSV: a German export reads the same numbers', () => {
  const de = [
    'Datum;Typ;Wert;Buchungswährung;Bruttobetrag;Währung Bruttobetrag;Wechselkurs;Gebühren;Steuern;'
      + 'Stück;ISIN;WKN;Ticker-Symbol;Wertpapiername;Notiz',
    '2020-09-21T00:00;Kauf;-1.234,56;EUR;;;;5,00;1,00;10;DE000A1EWWW0;A1EWWW;ADS;ADIDAS AG NA O.N.;',
    '2020-11-02T00:00;Einlage;500,00;EUR;;;;;;;;;;;Zahltag',
  ].join('\r\n');
  const { records, report } = parsePP(de);
  assert.equal(report.ok, true);
  const tx = ofType(records, 'transaction');
  assert.deepEqual(tx.map((t) => [t.type, t.amount, t.fees ?? 0, t.taxes ?? 0]), [
    ['buy', 123456, 500, 100],
    ['deposit', 50000, 0, 0],
  ]);
  assert.equal(tx[1].note, 'Zahltag');
});

test('CSV: a securities-account export signs buys the other way and still imports', () => {
  // writePortfolioTransaction uses isLiquidation(), so a buy is POSITIVE here.
  const csv = [CSV_EN_HEADER,
    '2020-09-21T00:00,Buy,500.00,EUR,,,,,,5,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
    '2020-12-24T00:00,Sell,"-3,000.00",EUR,,,,,,10,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
  ].join('\r\n');
  const { records, report } = parsePP(csv);
  assert.equal(report.ok, true);
  assert.deepEqual(ofType(records, 'transaction').map((t) => [t.type, t.amount]),
    [['buy', 50000], ['sell', 300000]]);
  // ...and the user is told once that these rows also live in the other export.
  assert.ok(codes(report).includes('csv_trade_appears_in_two_exports'));
});

test('CSV: a EUR account buying a USD stock keeps both currencies straight', () => {
  // PP fills Gross Amount / Currency Gross Amount / Exchange Rate from the
  // GROSS_VALUE unit, whose forex leg its own CheckCurrenciesAction requires to
  // be in the *security's* currency — so the security here is USD even though
  // the cash moved in EUR.
  const csv = [CSV_EN_HEADER,
    '2024-03-04T00:00,Buy,-920.00,EUR,"1,000.00",USD,0.9200,,,10,US0378331005,865985,AAPL,Apple Inc.,',
  ].join('\r\n');
  const { records, report } = parsePP(csv, { accountName: 'Broker EUR' });
  assert.equal(report.ok, true);

  const [account] = ofType(records, 'account');
  assert.equal(account.currency, 'EUR');   // the transaction currency
  const [security] = ofType(records, 'security');
  assert.equal(security.currency, 'USD');  // the gross-amount currency
  assert.equal(security.ticker, 'AAPL');

  const [tx] = ofType(records, 'transaction');
  assert.equal(tx.amount, 92000);
  assert.equal(tx.currency, 'EUR');
  assert.equal(tx.fx, 0.92 * 1e8);
});

test('CSV: the account currency comes from the rows, not from an option', () => {
  const { records } = parsePP(CSV_EN);
  assert.equal(ofType(records, 'account')[0].currency, 'EUR');
  assert.equal(ofType(records, 'security')[0].currency, 'EUR');
});

test('CSV: an exchange rate finer than our fx scale is reported as rounded', () => {
  const csv = [CSV_EN_HEADER,
    '2024-03-04T00:00,Buy,-920.00,EUR,"1,000.00",USD,0.923456789012,,,10,US0378331005,,AAPL,Apple Inc.,',
  ].join('\r\n');
  const { records, report } = parsePP(csv);
  // 12 decimals in, 8 kept, rounded half away from zero by parseFixed — and
  // said out loud, because this is the one place the importer is not lossless.
  assert.equal(ofType(records, 'transaction')[0].fx, 92345679);
  assert.ok(codes(report).includes('pp_fx_rounded'));
});

test('CSV: security transfers and deliveries are refused, cash transfers are not', async () => {
  // PP labels a cash transfer and a share transfer identically; only the row
  // tells them apart. Importing the share one would write a record the engine
  // refuses, so the import report would claim a row it did not really import.
  const csv = [CSV_EN_HEADER,
    '2024-03-04T00:00,Transfer (Outbound),-250.00,EUR,,,,,,,,,,,to savings',
    '2024-03-05T00:00,Transfer (Inbound),1000.00,EUR,,,,,,5,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
    '2024-03-06T00:00,Delivery (Inbound),1000.00,EUR,,,,,,5,DE000A1EWWW0,A1EWWW,ADS,ADIDAS AG NA O.N.,',
  ].join('\r\n');
  const { records, report } = parsePP(csv, { accountName: 'Konto' });

  assert.deepEqual(report.counts, { sourceRows: 3, imported: 1, merged: 0, skipped: 2 });
  const refused = report.entries.filter((e) => e.code === 'security_transfer_unsupported');
  assert.equal(refused.length, 2);
  assert.ok(refused.every((e) => /myportfolio-g7e\.10/.test(e.message)));

  const tx = ofType(records, 'transaction');
  assert.deepEqual(tx.map((t) => [t.type, t.amount, t.securityId]), [['transfer_out', 25000, undefined]]);

  // And what did import is a record the engine actually books.
  const port = fakeRecords();
  await applyAll(records, port);
  const snapshot = await createPortfolioDomain({ records: port }).snapshot();
  assert.deepEqual(snapshot.issues, []);
  assert.equal(snapshot.totals.cash, -25000);
});

test('CSV: unknown types and unreadable rows are reported, not dropped', () => {
  const csv = [CSV_EN_HEADER,
    '2020-11-02T00:00,Deposit,500.00,EUR,,,,,,,,,,,',
    '2020-11-03T00:00,Teleportation,500.00,EUR,,,,,,,,,,,',
    '2020-11-04T00:00,Deposit,not-a-number,EUR,,,,,,,,,,,',
    'never,Deposit,500.00,EUR,,,,,,,,,,,',
    '2020-11-05T00:00,Deposit,500.00',
  ].join('\r\n');
  const { records, report } = parsePP(csv);

  assert.equal(ofType(records, 'transaction').length, 1);
  assert.deepEqual(report.counts, { sourceRows: 5, imported: 1, merged: 0, skipped: 4 });
  assert.deepEqual(
    report.entries.filter((e) => e.severity === 'warning').map((e) => e.code).sort(),
    ['csv_bad_date', 'csv_bad_number', 'csv_row_incomplete', 'csv_row_width',
      'pp_unmapped_transaction_type'].sort(),
  );
  // Each entry can point the user at the offending line and show it back.
  for (const e of report.entries.filter((e2) => e2.severity === 'warning')) {
    assert.equal(typeof e.location.line, 'number');
    assert.equal(typeof e.raw, 'string');
  }
});

test('CSV: re-importing the same file produces zero new records', async () => {
  const port = fakeRecords();
  await applyAll(parsePP(CSV_EN).records, port);
  const afterFirst = port.rows.size;
  await applyAll(parsePP(CSV_EN).records, port);
  assert.equal(port.rows.size, afterFirst);
});

test('CSV: an unrecognised header falls back to the export order and says so', () => {
  const csv = [CSV_EN_HEADER.split(',').map((_, i) => `col${i}`).join(','),
    '2020-11-02T00:00,Deposit,500.00,EUR,,,,,,,,,,,'].join('\r\n');
  const { records, report } = parsePP(csv);
  assert.equal(ofType(records, 'transaction').length, 1);
  assert.ok(codes(report).includes('csv_header_unrecognized'));
});

test('CSV: a file that is not a transaction export is refused with a reason', () => {
  const { records, report } = parsePP('Date,Quote\r\n2024-01-02,41.2350\r\n');
  assert.deepEqual(records, []);
  assert.equal(report.ok, false);
  assert.match(report.entries[0].message, /transaction export/);
});

test('CSV: trades land in a securities account, because §4 keys a position by one', async () => {
  const { records, report } = parsePP(CSV_EN, { accountName: 'Broker' });

  const depot = ofType(records, 'account').find((a) => a.kind === 'securities');
  assert.equal(depot.name, 'Broker (securities)', 'named after the file, since the export does not name one');
  // Every row that names a security says which securities account it sits in;
  // the cash-only rows do not invent one.
  const tx = ofType(records, 'transaction');
  assert.deepEqual(tx.map((t) => [t.type, t.portfolioId ?? null]), [
    ['buy', depot.recordId],
    ['deposit', null],
    ['dividend', depot.recordId],
    ['sell', depot.recordId],
  ]);
  // A created account is a stated fact, not a silent one.
  assert.ok(codes(report).includes('csv_no_portfolio_column'));

  // …and the engine therefore folds one attributed holding, with no complaint
  // about an unattributed trade.
  const port = fakeRecords();
  await applyAll(records, port);
  const snapshot = await createPortfolioDomain({ records: port }).snapshot();
  const position = snapshot.positions[0];
  assert.equal(snapshot.positions.length, 1);
  assert.equal(position.accountId, depot.recordId);
  assert.equal(position.shares, 5 * 1e8);
  assert.equal(position.dividends, 2500);
  assert.ok(!snapshot.issues.some((i) => i.code === 'missing_portfolio'));
});

test('CSV: the sign PP gives a row is checked against the engine\'s own CASH_SIGN', () => {
  // Not a second table: ppimport reads portfolio.js's CASH_SIGN through the §4
  // type it maps to, so the importer cannot come to book a type the other way
  // round from the engine that folds it.
  const row = (label, value) => [CSV_EN_HEADER,
    `2020-11-02T00:00,${label},"${value}",EUR,,,,,,,,,,,`].join('\r\n');
  const cases = [
    ['Deposit', 'deposit', +1], ['Withdrawal', 'removal', -1],
    ['Interest', 'interest', +1], ['Interest charge', 'interest', -1],
    ['Fees', 'fee', -1], ['Fees refund', 'fee', +1],
    ['Taxes', 'tax', -1], ['Tax refund', 'tax', +1],
  ];

  for (const [label, type, sign] of cases) {
    // PP signs the Value column by its own isDebit flag, which must be the same
    // direction CASH_SIGN gives the §4 type the row maps to.
    const agreeing = parsePP(row(label, sign > 0 ? '100.00' : '-100.00'));
    const tx = ofType(agreeing.records, 'transaction')[0];
    assert.equal(tx.type, type, label);
    assert.equal(CASH_SIGN[tx.type] * Math.sign(tx.amount), sign, `${label} moves cash the wrong way`);
    assert.ok(!codes(agreeing.report).includes('csv_sign_mismatch'), `${label} should not look mismatched`);

    // Flip PP's own sign and the disagreement is reported, not silently obeyed.
    const flipped = parsePP(row(label, sign > 0 ? '-100.00' : '100.00'));
    assert.ok(codes(flipped.report).includes('csv_sign_mismatch'), `${label} reversed should be reported`);
    assert.equal(ofType(flipped.records, 'transaction')[0].amount, tx.amount,
      `${label} is imported by type, not by sign`);
  }

  // BUY/SELL are excluded on purpose: a securities-account export signs them the
  // other way round, so their direction can only come from the type.
  const buy = parsePP(row('Buy', '500.00'));
  assert.ok(!codes(buy.report).includes('csv_sign_mismatch'));
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test('batches splits a large import into bounded writes', () => {
  const items = Array.from({ length: 1001 }, (_, i) => i);
  const chunks = [...batches(items, 250)];
  assert.deepEqual(chunks.map((c) => c.length), [250, 250, 250, 250, 1]);
  assert.deepEqual(chunks.flat(), items);
  assert.deepEqual([...batches([], 10)], []);
  assert.throws(() => [...batches(items, 0)], RangeError);
});
