import test from 'node:test';
import assert from 'node:assert/strict';

import { createPortfolioDomain } from './portfolio.js';

// An in-memory stand-in for the §3 records port. The engine is pure over this
// port, which is the whole point of the seam: Track A swaps the implementation
// and none of the arithmetic below changes.
function fixture() {
  const byType = new Map();
  let n = 0;
  const put = (recordType, body, recordId) => {
    const id = recordId || `${recordType}_${++n}`;
    if (!byType.has(recordType)) byType.set(recordType, []);
    byType.get(recordType).push({ ...body, recordId: id, recordType, clientTs: 1, deleted: false });
    return id;
  };
  const records = { async list(recordType) { return (byType.get(recordType) || []).slice(); } };
  return {
    put,
    snapshot: (opts) => createPortfolioDomain({ records }).snapshot(opts),
  };
}

// The common opening: one cash account, one security.
function basics(f, { currency = 'EUR' } = {}) {
  f.put('account', { name: 'Cash', kind: 'cash', currency }, 'acct_1');
  f.put('security', { name: 'Acme', ticker: 'ACME', currency, assetClass: 'stock' }, 'sec_1');
}

const tx = (body) => ({ accountId: 'acct_1', currency: 'EUR', ...body });
const only = (list) => { assert.equal(list.length, 1); return list[0]; };
const codes = (snap) => snap.issues.map((i) => i.code);

test('buy then full sell, with fees on both legs', async () => {
  const f = fixture();
  basics(f);
  // 10 shares @ €100.00 = €1000.00 gross, €9.90 fee -> €1009.90 leaves the account.
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10',
    shares: 1000000000, amount: 100990, fees: 990,
  }));
  // 10 shares @ €110.00 = €1100.00 gross, €9.90 fee -> €1090.10 arrives.
  f.put('transaction', tx({
    type: 'sell', securityId: 'sec_1', date: '2024-02-10',
    shares: 1000000000, amount: 109010, fees: 990,
  }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.shares, 0);
  assert.equal(p.cost, 0, 'a full exit leaves no cost dust');
  // €100.00 gross gain less both €9.90 fees = €80.20.
  assert.equal(p.realized, 8020);
  assert.equal(p.fees, 1980);
  assert.equal(p.taxes, 0);
  assert.equal(only(snap.accounts).balance, 8020);
  assert.deepEqual(snap.issues, []);
});

test('a partial sell realizes only the sold shares’ share of the basis', async () => {
  const f = fixture();
  basics(f);
  // 10 @ €100.00 + €10.00 fee -> cost €1010.00.
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10',
    shares: 1000000000, amount: 101000, fees: 1000,
  }));
  // 4 @ €150.00 = €600.00 gross less €5.00 fee -> €595.00 arrives.
  f.put('transaction', tx({
    type: 'sell', securityId: 'sec_1', date: '2024-02-10',
    shares: 400000000, amount: 59500, fees: 500,
  }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '03-01': 16000000000 } });

  const p = only((await f.snapshot()).positions);

  assert.equal(p.shares, 600000000);
  // 40% of €1010.00 basis leaves with the 4 shares.
  assert.equal(p.cost, 60600);
  assert.equal(p.realized, 19100); // €595.00 - €404.00
  assert.equal(p.fees, 1500);
  // 6 shares @ €160.00 = €960.00, against a €606.00 basis.
  assert.equal(p.marketValue, 96000);
  assert.equal(p.unrealized, 35400);
});

test('fees are capitalised into the basis, taxes are not — both leave cash', async () => {
  const f = fixture();
  basics(f);
  // 10 @ €100.00 gross, €10.00 fee, €20.00 tax -> €1030.00 leaves the account.
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10',
    shares: 1000000000, amount: 103000, fees: 1000, taxes: 2000,
  }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.cost, 101000, 'basis is gross + fees, excluding tax');
  assert.equal(only(snap.accounts).balance, -103000, 'cash moves by the full amount');
  assert.equal(p.fees, 1000);
  assert.equal(p.taxes, 2000);
});

test('selling: the tax comes out of cash but not out of the gain', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10',
    shares: 1000000000, amount: 100000,
  }));
  // €1200.00 gross, €10.00 fee, €30.00 tax -> €1160.00 arrives.
  f.put('transaction', tx({
    type: 'sell', securityId: 'sec_1', date: '2024-02-10',
    shares: 1000000000, amount: 116000, fees: 1000, taxes: 3000,
  }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  // Gain is gross - fees - basis = 1200 - 10 - 1000 = €190.00; the tax is not
  // netted into it, it is reported on its own.
  assert.equal(p.realized, 19000);
  assert.equal(p.taxes, 3000);
  // Cash still sees every cent: -1000.00 + 1160.00.
  assert.equal(only(snap.accounts).balance, 16000);
});

test('a dividend moves cash and income, never the cost basis', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10',
    shares: 1000000000, amount: 103000, fees: 1000, taxes: 2000,
  }));
  // €50.00 gross dividend less €13.00 withholding -> €37.00 arrives.
  f.put('transaction', tx({
    type: 'dividend', securityId: 'sec_1', date: '2024-03-01', amount: 3700, taxes: 1300,
  }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.cost, 101000, 'unchanged by the dividend');
  assert.equal(p.shares, 1000000000, 'unchanged by the dividend');
  assert.equal(p.dividends, 3700);
  assert.equal(p.taxes, 3300); // 2000 on the buy + 1300 withheld
  assert.equal(only(snap.accounts).balance, -99300); // -103000 + 3700
});

test('a multi-lot position sells at the moving-average basis', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-02-10', shares: 1000000000, amount: 200000 }));
  // 20 shares costing €3000.00 -> €150.00 each. Sell 5 @ €250.00.
  f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-03-10', shares: 500000000, amount: 125000 }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.shares, 1500000000);
  assert.equal(p.cost, 225000);
  assert.equal(p.realized, 50000); // 5 x (250.00 - 150.00)
  assert.equal(only(snap.accounts).balance, -175000);
});

test('selling more than is held is surfaced, not clamped', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 500000000, amount: 50000 }));
  f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-02-10', shares: 1000000000, amount: 110000 }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.ok(codes(snap).includes('oversell'));
  assert.equal(p.shares, -500000000, 'the books stay self-consistent rather than flooring at zero');
  assert.equal(p.cost, 0);
  assert.equal(p.realized, 60000);
});

test('selling with nothing held at all is surfaced', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-02-10', shares: 1000000000, amount: 110000 }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.ok(codes(snap).includes('oversell'));
  assert.equal(p.shares, -1000000000);
  assert.equal(p.realized, 110000);
  assert.equal(only(snap.accounts).balance, 110000, 'the cash still arrived');
});

test('every §4 transaction type moves cash the documented way', async () => {
  const cases = [
    ['buy', -1, { securityId: 'sec_1', shares: 100000000 }],
    ['sell', +1, { securityId: 'sec_1', shares: 100000000 }],
    ['dividend', +1, { securityId: 'sec_1' }],
    ['deposit', +1, {}],
    ['removal', -1, {}],
    ['interest', +1, {}],
    ['fee', -1, {}],
    ['tax', -1, {}],
    ['transfer_in', +1, { counterAccountId: 'acct_2' }],
    ['transfer_out', -1, { counterAccountId: 'acct_2' }],
  ];
  for (const [type, sign, extra] of cases) {
    const f = fixture();
    basics(f);
    f.put('transaction', tx({ type, date: '2024-01-10', amount: 10000, ...extra }));
    const snap = await f.snapshot();
    assert.equal(only(snap.accounts).balance, sign * 10000, `${type} should move cash ${sign > 0 ? '+' : '-'}`);
  }
});

test('standalone fee and tax records are expenses, never basis', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({ type: 'fee', securityId: 'sec_1', date: '2024-02-01', amount: 250 }));
  f.put('transaction', tx({ type: 'tax', securityId: 'sec_1', date: '2024-02-02', amount: 400 }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.cost, 100000, 'a custody fee does not raise what the shares cost');
  assert.equal(p.fees, 250);
  assert.equal(p.taxes, 400);
  assert.equal(only(snap.accounts).balance, -100650);
});

test('transfers are one record per leg; the counter account is not double-booked', async () => {
  const f = fixture();
  basics(f);
  f.put('account', { name: 'Savings', kind: 'cash', currency: 'EUR' }, 'acct_2');
  f.put('transaction', tx({ type: 'transfer_out', date: '2024-01-10', amount: 50000, counterAccountId: 'acct_2' }));
  f.put('transaction', {
    type: 'transfer_in', accountId: 'acct_2', currency: 'EUR',
    date: '2024-01-10', amount: 50000, counterAccountId: 'acct_1',
  });

  const snap = await f.snapshot();
  const balances = Object.fromEntries(snap.accounts.map((a) => [a.accountId, a.balance]));

  assert.equal(balances.acct_1, -50000);
  assert.equal(balances.acct_2, 50000);
});

test('a securities transfer is refused rather than mis-booked as cash', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({
    type: 'transfer_in', securityId: 'sec_1', date: '2024-01-10', shares: 100000000, amount: 10000,
  }));

  const snap = await f.snapshot();

  assert.deepEqual(codes(snap), ['security_transfer_unsupported']);
  assert.equal(only(snap.accounts).balance, 0, 'no cash invented for a share movement');
  assert.deepEqual(snap.positions, []);
});

test('valuation uses the newest chunked close, per §4 price storage', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-01', shares: 1000000000, amount: 100000 }));
  f.put('price', { securityId: 'sec_1', year: 2023, closes: { '12-29': 9000000000 } });
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '01-02': 10000000000, '03-15': 12000000000 } });

  const p = only((await f.snapshot()).positions);

  assert.equal(p.priceDate, '2024-03-15');
  assert.equal(p.price, 12000000000);
  assert.equal(p.marketValue, 120000); // 10 shares @ €120.00
  assert.equal(p.unrealized, 20000);
});

test('a malformed price record cannot hijack the valuation', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-01', shares: 1000000000, amount: 100000 }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '03-15': 12000000000 } });
  // No year: naive string building would make this "undefined-03-15", which
  // sorts above every real date and would win the latest-close race.
  f.put('price', { securityId: 'sec_1', closes: { '03-15': 99900000000 } });
  // A float close is a leaked float, not a price.
  f.put('price', { securityId: 'sec_1', year: 2025, closes: { '01-01': 1.5 } });

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.priceDate, '2024-03-15');
  assert.equal(p.marketValue, 120000);
  assert.ok(codes(snap).includes('price_not_chunked'));
  assert.ok(codes(snap).includes('non_integer_units'));
});

test('asOf rewinds both the transaction fold and the price lookup', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-01', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-03-20', shares: 1000000000, amount: 300000 }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '01-02': 10000000000, '03-15': 12000000000 } });

  const snap = await f.snapshot({ asOf: '2024-02-01' });
  const p = only(snap.positions);

  assert.equal(snap.asOf, '2024-02-01');
  assert.equal(p.shares, 1000000000, 'the March buy has not happened yet');
  assert.equal(p.cost, 100000);
  assert.equal(p.price, 10000000000, 'the March close has not happened yet');
  assert.equal(p.marketValue, 100000);
  assert.equal(only(snap.accounts).balance, -100000);
});

test('transactions fold in date order however they come back from the port', async () => {
  const f = fixture();
  basics(f);
  // Sell inserted first, dated second.
  f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-02-10', shares: 1000000000, amount: 110000 }));
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));

  const snap = await f.snapshot();

  assert.deepEqual(snap.issues, [], 'must not read as an oversell');
  assert.equal(only(snap.positions).realized, 10000);
});

test('an unpriced holding reports null value rather than a bogus zero', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.price, null);
  assert.equal(p.marketValue, null);
  assert.equal(p.unrealized, null);
  assert.ok(codes(snap).includes('no_price'));
  assert.equal(snap.totals.unrealized, 0);
  assert.equal(snap.totals.cost, 100000);
});

test('bad records are surfaced, not silently absorbed', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'teleport', date: '2024-01-10', amount: 100 }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-10', amount: 12.34 }));
  f.put('transaction', { type: 'deposit', accountId: 'ghost', currency: 'EUR', date: '2024-01-10', amount: 100 });
  f.put('transaction', tx({ type: 'buy', securityId: 'ghost', date: '2024-01-10', shares: 1, amount: 100 }));
  f.put('transaction', tx({ type: 'buy', date: '2024-01-10', shares: 1, amount: 100 }));
  f.put('price', { securityId: 'sec_1', date: '2024-01-02', close: 10000000000 });
  f.put('price', { securityId: 'sec_1', closes: { '03-15': 99900000000 } });

  const snap = await f.snapshot();
  const seen = codes(snap);

  assert.ok(seen.includes('unknown_transaction_type'));
  // A float in a money field means one leaked upstream; it must not be rounded away.
  assert.ok(seen.includes('non_integer_units'));
  assert.ok(seen.includes('unknown_account'));
  assert.ok(seen.includes('unknown_security'));
  assert.ok(seen.includes('missing_security'));
  // §4 stores prices chunked per security-year; a flat {date, close} is not read.
  assert.ok(seen.includes('price_not_chunked'));
});

test('mixed currencies are flagged once each rather than summed in silence', async () => {
  const f = fixture();
  basics(f);
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-10', amount: 10000, currency: 'USD' }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-11', amount: 10000, currency: 'USD' }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-12', amount: 10000, currency: 'EUR' }));

  const snap = await f.snapshot();

  assert.equal(snap.reportingCurrency, 'EUR');
  assert.deepEqual(codes(snap), ['currency_not_converted']);
});

test('totals aggregate positions and accounts', async () => {
  const f = fixture();
  basics(f);
  f.put('account', { name: 'Savings', kind: 'cash', currency: 'EUR' }, 'acct_2');
  f.put('security', { name: 'Beta', ticker: 'BETA', currency: 'EUR', assetClass: 'etf' }, 'sec_2');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: 1000000 }));
  f.put('transaction', { type: 'deposit', accountId: 'acct_2', currency: 'EUR', date: '2024-01-01', amount: 500000 });
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000, fees: 1000 }));
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_2', date: '2024-01-10', shares: 1000000000, amount: 200000, taxes: 500 }));
  f.put('transaction', tx({ type: 'dividend', securityId: 'sec_1', date: '2024-02-01', amount: 2500 }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '03-01': 11000000000 } });
  f.put('price', { securityId: 'sec_2', year: 2024, closes: { '03-01': 25000000000 } });

  const snap = await f.snapshot();

  assert.deepEqual(snap.positions.map((p) => p.name), ['Acme', 'Beta']);
  assert.equal(snap.totals.cash, 1000000 + 500000 - 100000 - 200000 + 2500);
  // 10 @ €110.00 + 10 @ €250.00
  assert.equal(snap.totals.marketValue, 110000 + 250000);
  assert.equal(snap.totals.cost, 100000 + (200000 - 500));
  assert.equal(snap.totals.unrealized, (110000 - 100000) + (250000 - 199500));
  assert.equal(snap.totals.dividends, 2500);
  assert.equal(snap.totals.fees, 1000);
  assert.equal(snap.totals.taxes, 500);
  assert.equal(snap.totals.total, snap.totals.cash + snap.totals.marketValue);
});

test('a thousand transactions leave no rounding drift', async () => {
  const f = fixture();
  basics(f);
  // 1000 buys of 1 share @ €33.33 with a €0.07 fee -> €33.40 each.
  for (let i = 0; i < 1000; i += 1) {
    f.put('transaction', tx({
      type: 'buy', securityId: 'sec_1', date: '2024-01-10',
      shares: 100000000, amount: 3340, fees: 7,
    }));
  }

  const mid = await f.snapshot();
  const held = only(mid.positions);
  assert.equal(held.shares, 100000000000);
  assert.equal(held.cost, 3340000, 'exact to the cent after 1000 buys');
  assert.equal(held.fees, 7000);
  assert.equal(only(mid.accounts).balance, -3340000);

  // Now exit the whole position at €40.00.
  f.put('transaction', tx({
    type: 'sell', securityId: 'sec_1', date: '2024-06-01',
    shares: 100000000000, amount: 4000000,
  }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.shares, 0);
  assert.equal(p.cost, 0, 'not one cent of dust after 1001 transactions');
  assert.equal(p.realized, 660000);
  assert.equal(only(snap.accounts).balance, 660000);
});
