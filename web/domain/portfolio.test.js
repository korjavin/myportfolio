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

// The common opening: one cash account, one securities account, one security.
// §4: `accountId` is the cash leg for every type, and a buy/sell also names
// `portfolioId` — the securities account the shares land in, which together with
// the security is what keys a position.
function basics(f, { currency = 'EUR' } = {}) {
  f.put('account', { name: 'Cash', kind: 'cash', currency }, 'acct_1');
  f.put('account', { name: 'Depot', kind: 'securities', currency }, 'pf_1');
  f.put('security', { name: 'Acme', ticker: 'ACME', currency, assetClass: 'stock' }, 'sec_1');
}

const tx = (body) => ({ accountId: 'acct_1', portfolioId: 'pf_1', currency: 'EUR', ...body });
const only = (list) => { assert.equal(list.length, 1); return list[0]; };
const codes = (snap) => snap.issues.map((i) => i.code);
// The cash account's balance. A securities account holds no cash, so this is
// the number every "what moved" assertion below means.
const cash = (snap) => snap.accounts.find((a) => a.accountId === 'acct_1').balance;

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
  assert.equal(cash(snap), 8020);
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
  assert.equal(cash(snap), -103000, 'cash moves by the full amount');
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
  assert.equal(cash(snap), 16000);
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
  assert.equal(cash(snap), -99300); // -103000 + 3700
});

// The same two lots, sold the same way, under each §4 cost-basis method. The
// two numbers below are hand-computed and deliberately different: that
// difference is the whole reason the method is a setting.
function multiLot(method) {
  const f = fixture();
  basics(f);
  if (method) f.put('settings', { costBasisMethod: method }, 'settings');
  // Lot 1: 10 shares for €1000.00. Lot 2, a month later: 10 for €2000.00.
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-02-10', shares: 1000000000, amount: 200000 }));
  // Sell 5 @ €250.00 = €1250.00.
  f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-03-10', shares: 500000000, amount: 125000 }));
  return f;
}

test('FIFO is the default, and sells the oldest lot first', async () => {
  const snap = await multiLot().snapshot();
  const p = only(snap.positions);

  assert.equal(snap.costBasisMethod, 'fifo');
  assert.equal(p.shares, 1500000000);
  // The 5 sold shares come out of the €100.00-a-share lot: basis €500.00.
  assert.equal(p.realized, 125000 - 50000);
  assert.equal(p.cost, 300000 - 50000);
  // Half of lot 1 is left, then all of lot 2 — oldest first, and no lot is
  // touched before the one in front of it is empty.
  assert.deepEqual(p.lots, [
    { date: '2024-01-10', shares: 500000000, cost: 50000 },
    { date: '2024-02-10', shares: 1000000000, cost: 200000 },
  ]);
  assert.equal(cash(snap), -175000);
});

test('moving_average reports the same sale against the blended basis', async () => {
  const snap = await multiLot('moving_average').snapshot();
  const p = only(snap.positions);

  assert.equal(snap.costBasisMethod, 'moving_average');
  assert.equal(p.shares, 1500000000);
  // 20 shares costing €3000.00 -> €150.00 each, so €750.00 leaves with the 5.
  assert.equal(p.realized, 125000 - 75000);
  assert.equal(p.cost, 300000 - 75000);
  // Lots are still tracked — that is what makes the two views agree, and it is
  // not recoverable after the fact from a moving-average fold.
  assert.deepEqual(p.lots, [
    { date: '2024-01-10', shares: 500000000, cost: 50000 },
    { date: '2024-02-10', shares: 1000000000, cost: 200000 },
  ]);
  assert.equal(cash(snap), -175000);
});

test('the two methods disagree on realized gain, and only on that', async () => {
  const [fifo, avg] = await Promise.all([multiLot().snapshot(), multiLot('moving_average').snapshot()]);

  assert.notEqual(only(fifo.positions).realized, only(avg.positions).realized);
  assert.equal(only(fifo.positions).shares, only(avg.positions).shares);
  assert.equal(cash(fifo), cash(avg));
  // Both methods split the same €3000.00 paid and €1250.00 received between
  // "basis still held" and "gain already taken", so basis less gain is the same
  // money either way — only the line between them moves.
  assert.equal(only(fifo.positions).cost - only(fifo.positions).realized, 300000 - 125000);
  assert.equal(only(avg.positions).cost - only(avg.positions).realized, 300000 - 125000);
});

test('a cost basis method the engine does not know is surfaced, not read as the default', async () => {
  const f = multiLot('lifo');
  const snap = await f.snapshot();

  assert.ok(codes(snap).includes('unknown_cost_basis_method'));
  assert.equal(snap.costBasisMethod, 'fifo');
});

test('closing a position leaves zero basis dust under both methods', async () => {
  for (const method of ['fifo', 'moving_average']) {
    const f = fixture();
    basics(f);
    f.put('settings', { costBasisMethod: method }, 'settings');
    // Share counts and prices chosen so neither method divides evenly.
    f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 33333333, amount: 1237 }));
    f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-02-10', shares: 66666667, amount: 4919 }));
    // Out in two bites, the first of which splits a lot.
    f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-03-10', shares: 7000000, amount: 999 }));
    f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-04-10', shares: 93000000, amount: 9001 }));

    const p = only((await f.snapshot()).positions);

    assert.equal(p.shares, 0, method);
    assert.equal(p.cost, 0, `${method}: not one cent of basis left behind a closed position`);
    assert.deepEqual(p.lots, [], `${method}: every lot consumed`);
    // Whichever route the basis took, the gain is proceeds less what was paid.
    assert.equal(p.realized, (999 + 9001) - (1237 + 4919), method);
  }
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
  assert.equal(cash(snap), 110000, 'the cash still arrived');
});

test('a trade with non-positive shares does not corrupt the position', async () => {
  for (const shares of [-100000000, 0, undefined]) {
    const f = fixture();
    basics(f);
    f.put('transaction', tx({
      type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares, amount: 100000,
    }));

    const snap = await f.snapshot();

    assert.ok(codes(snap).includes('non_positive_shares'), `shares=${shares}`);
    // Folding it would build a plausible-looking corrupt position: a
    // negative-share buy as a short holding with a positive cost basis.
    const p = only(snap.positions);
    assert.equal(p.shares, 0, `shares=${shares}`);
    assert.equal(p.cost, 0, `shares=${shares}`);
    assert.equal(p.realized, 0, `shares=${shares}`);
    // The cash leg still stands — that money really did leave the account.
    assert.equal(cash(snap), -100000, `shares=${shares}`);
  }
});

test('a non-positive sell neither invents shares nor realizes a gain', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({ type: 'sell', securityId: 'sec_1', date: '2024-02-10', shares: -500000000, amount: 60000 }));

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.ok(codes(snap).includes('non_positive_shares'));
  assert.equal(p.shares, 1000000000, 'a negative-share sell must not add holdings');
  assert.equal(p.cost, 100000);
  assert.equal(p.realized, 0);
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
    assert.equal(cash(snap), sign * 10000, `${type} should move cash ${sign > 0 ? '+' : '-'}`);
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
  assert.equal(cash(snap), -100650);
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
  assert.equal(cash(snap), 0, 'no cash invented for a share movement');
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
  // Unpadded and out-of-range keys sort above every well-formed date too:
  // "2024-3-15" > "2024-12-31" as strings.
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '3-15': 88800000000 } });
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '99-99': 77700000000 } });
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
  assert.equal(cash(snap), -100000);
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

test('a currency with no stored rate is an explicit gap, flagged once, never summed', async () => {
  const f = fixture();
  basics(f);
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-10', amount: 10000, currency: 'USD' }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-11', amount: 10000, currency: 'USD' }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-12', amount: 10000, currency: 'EUR' }));

  const snap = await f.snapshot();

  assert.equal(snap.reportingCurrency, 'EUR');
  // One issue for the currency, not one per record: an unfetched currency
  // misses every one of its days at once and the user's fix is one action.
  assert.deepEqual(codes(snap), ['currency_not_converted']);
  assert.match(snap.issues[0].message, /no USDEUR rate applicable to 2024-01-10/);
  // $100.00 has no euro value — not zero, unknown. Only the euro deposit is in
  // the total, because it is the only amount the engine can actually state.
  assert.equal(cash(snap), 10000);
  assert.equal(snap.totals.total, 10000);
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
  assert.equal(cash(mid), -3340000);

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
  assert.equal(cash(snap), 660000);
});

// --- (accountId, securityId) keying ----------------------------------------

test('the same security at two brokers is two positions and one aggregate', async () => {
  const f = fixture();
  basics(f);
  f.put('account', { name: 'Depot B', kind: 'securities', currency: 'EUR' }, 'pf_2');
  // 10 shares at one broker, 5 at another, bought at different prices.
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-02-10', portfolioId: 'pf_2',
    shares: 500000000, amount: 60000,
  }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '03-01': 12000000000 } });

  const snap = await f.snapshot();

  assert.equal(snap.positions.length, 2, 'the securities account is modelled, so this is two holdings');
  const [a, b] = snap.positions;
  assert.equal(a.accountId, 'pf_1');
  assert.equal(a.accountName, 'Depot');
  assert.equal(a.shares, 1000000000);
  assert.equal(a.cost, 100000);
  assert.equal(a.marketValue, 120000);
  assert.equal(b.accountId, 'pf_2');
  assert.equal(b.shares, 500000000);
  assert.equal(b.cost, 60000);
  assert.equal(b.marketValue, 60000);

  // …and one portfolio-wide view of the security on top of them.
  const agg = only(snap.securities);
  assert.equal(agg.securityId, 'sec_1');
  assert.deepEqual(agg.accountIds, ['pf_1', 'pf_2']);
  assert.equal(agg.shares, 1500000000);
  assert.equal(agg.cost, 160000);
  assert.equal(agg.marketValue, 180000);
  assert.equal(agg.unrealized, 20000);
  assert.deepEqual(snap.issues, [], 'holding one security at two brokers is not an error');

  // The totals count each position once, not the aggregate as well.
  assert.equal(snap.totals.marketValue, 180000);
  assert.equal(snap.totals.cost, 160000);
});

test('two brokers keep their own lots, so a sale at one cannot eat the other’s basis', async () => {
  const f = fixture();
  basics(f);
  f.put('account', { name: 'Depot B', kind: 'securities', currency: 'EUR' }, 'pf_2');
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-02-10', portfolioId: 'pf_2',
    shares: 1000000000, amount: 300000,
  }));
  // Sell the whole holding at the SECOND broker. Under a security-keyed fold
  // this would have consumed the older, cheaper lot at the first one.
  f.put('transaction', tx({
    type: 'sell', securityId: 'sec_1', date: '2024-03-10', portfolioId: 'pf_2',
    shares: 1000000000, amount: 330000,
  }));

  const snap = await f.snapshot();
  const [a, b] = snap.positions;

  assert.equal(a.accountId, 'pf_1');
  assert.equal(a.shares, 1000000000);
  assert.equal(a.cost, 100000, 'untouched by the other broker’s sale');
  assert.equal(a.realized, 0);
  assert.equal(b.shares, 0);
  assert.equal(b.cost, 0);
  assert.equal(b.realized, 30000, '€3300.00 out against the €3000.00 that lot cost');
  // The two holdings share one security, so the missing close is said once.
  assert.deepEqual(codes(snap), ['no_price']);
});

test('a trade naming only the cash account is surfaced, never guessed onto a broker', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', {
    type: 'buy', accountId: 'acct_1', currency: 'EUR', securityId: 'sec_1',
    date: '2024-01-10', shares: 1000000000, amount: 100000,
  });

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.ok(codes(snap).includes('missing_portfolio'));
  assert.equal(p.accountId, null, 'held unattributed rather than assigned to the only depot there is');
  assert.equal(p.shares, 1000000000);
  assert.equal(p.cost, 100000);
  // The cash leg is not in doubt, so it still stands.
  assert.equal(cash(snap), -100000);
});

test('a dividend lands on the holding it can only have come from', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  // §4 gives a dividend a cash account and a security, and PP's own model has no
  // depot on one either. One position holds the security, so there is nothing to
  // choose between.
  f.put('transaction', {
    type: 'dividend', accountId: 'acct_1', currency: 'EUR', securityId: 'sec_1',
    date: '2024-03-01', amount: 3700,
  });

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.equal(p.accountId, 'pf_1');
  assert.equal(p.dividends, 3700);
  assert.equal(snap.totals.dividends, 3700);
});

test('a dividend on a security held at two brokers is not split by a rule nobody chose', async () => {
  const f = fixture();
  basics(f);
  f.put('account', { name: 'Depot B', kind: 'securities', currency: 'EUR' }, 'pf_2');
  f.put('transaction', tx({ type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000 }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-11', portfolioId: 'pf_2',
    shares: 1000000000, amount: 100000,
  }));
  f.put('transaction', {
    type: 'dividend', accountId: 'acct_1', currency: 'EUR', securityId: 'sec_1',
    date: '2024-03-01', amount: 3700,
  });

  const snap = await f.snapshot();

  assert.equal(snap.positions.length, 3, 'the two holdings, plus where the unattributable income sits');
  const unattributed = snap.positions.find((p) => p.accountId === null);
  assert.equal(unattributed.dividends, 3700);
  assert.equal(unattributed.shares, 0, 'income never invents a holding');
  // It is still the security's income, so the portfolio-wide view has all of it.
  assert.equal(only(snap.securities).dividends, 3700);
  assert.equal(snap.totals.dividends, 3700);
});

// --- dates -----------------------------------------------------------------

test('an undated transaction is surfaced and folded nowhere at all', async () => {
  for (const date of [undefined, '', 'yesterday', '2024-1-5', '2024-02-30', '2024-13-01']) {
    const f = fixture();
    basics(f);
    f.put('transaction', tx({
      type: 'buy', securityId: 'sec_1', date, shares: 1000000000, amount: 100000,
    }));

    const snap = await f.snapshot();

    assert.ok(codes(snap).includes('undated_transaction'), `date=${date}`);
    assert.deepEqual(snap.positions, [], `date=${date}: no position`);
    assert.equal(cash(snap), 0, `date=${date}: no cash moved`);
    assert.equal(snap.totals.total, 0, `date=${date}`);
  }
});

test('an undated transaction does not contaminate the opening valuation', async () => {
  const f = fixture();
  basics(f);
  // The failure this pins: an undated record used to slice to '', which sorts
  // before every real date, so it landed in EVERY snapshot — including the
  // opening one, the day before the portfolio existed.
  f.put('transaction', tx({ type: 'deposit', date: undefined, amount: 5000000 }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-02', amount: 1000000 }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-02', shares: 1000000000, amount: 100000,
  }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '01-02': 10000000000 } });

  const opening = await f.snapshot({ asOf: '2024-01-01' });
  assert.equal(opening.totals.total, 0, 'the portfolio was empty the day before it opened');
  assert.deepEqual(opening.positions, []);
  assert.ok(codes(opening).includes('undated_transaction'), 'and the bad record is still reported');

  const after = await f.snapshot({ asOf: '2024-01-02' });
  assert.equal(after.totals.cash, 1000000 - 100000, 'the €50,000 that has no date is in neither snapshot');
  assert.equal(after.totals.total, (1000000 - 100000) + 100000);
});

// --- multi-currency (§4 `fx`, §5 scale 1e8) ---------------------------------

test('a EUR purchase in a USD-reporting portfolio uses the trade date’s rate, and the close’s own rate to value it', async () => {
  // THE test for this feature. Two rates are stored, five months apart and
  // deliberately far apart in value, and the snapshot has to use a different
  // one for the basis than for the valuation:
  //
  //   cost        at the TRADE date's rate — €1000 in January cost what it
  //               cost, and re-converting it at today's rate would rewrite the
  //               portfolio's history every time the market moved.
  //   marketValue at the CLOSE's rate — what the holding is worth now is worth
  //               it at the rate now.
  //
  // Swap the two and every number below changes, which is the point.
  const f = fixture();
  basics(f);
  f.put('settings', { reportingCurrency: 'USD' }, 'settings');
  f.put('fx', { pair: 'EURUSD', date: '2024-01-10', rate: 110000000 }, 'fx_jan');
  f.put('fx', { pair: 'EURUSD', date: '2024-06-10', rate: 200000000 }, 'fx_jun');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-10', amount: 200000 }), 'tx_dep');
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10',
    shares: 1000000000, amount: 100000, fees: 1000,
  }), 'tx_buy');
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '06-10': 12000000000 } });

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.deepEqual(snap.issues, []);
  // €1000.00 at €1 = $1.10 is $1100.00. At the June rate it would be $2000.00.
  assert.equal(p.cost, 110000);
  assert.equal(p.fees, 1100);
  // 10 shares at the €120.00 close is €1200.00, at the JUNE rate: $2400.00.
  // At the January rate it would be $1320.00.
  assert.equal(p.marketValue, 240000);
  // The price itself stays in the security's own currency — it is a market
  // fact about the security, and it is what the user's broker shows.
  assert.equal(p.price, 12000000000);
  assert.equal(p.currency, 'EUR');
  // Gain includes the currency effect, which is what a reporting-currency gain
  // means: $2400.00 valued now less $1100.00 paid then.
  assert.equal(p.unrealized, 130000);
  // Cash moved twice, each leg at its own day's rate: (€2000 - €1000) x 1.10.
  assert.equal(cash(snap), 110000);
  assert.equal(snap.totals.total, 110000 + 240000);
});

test('a EUR-reporting portfolio holding a US ETF converts through the inverse rate', async () => {
  // The common case this feature exists for: a European holding a US-listed
  // ETF. Nothing publishes USDEUR — it is 1/EURUSD, and without the inverse
  // this user sees a gap where their portfolio should be.
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'EUR' }, 'acct_1');
  f.put('account', { name: 'Depot', kind: 'securities', currency: 'EUR' }, 'pf_1');
  f.put('security', { name: 'VOO', ticker: 'VOO', currency: 'USD', assetClass: 'etf' }, 'sec_1');
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('fx', { pair: 'EURUSD', date: '2024-03-28', rate: 108110000 }, 'fx_1');
  f.put('transaction', {
    type: 'buy', accountId: 'acct_1', portfolioId: 'pf_1', securityId: 'sec_1',
    date: '2024-03-28', shares: 200000000, amount: 100000, currency: 'USD',
  }, 'tx_buy');
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '03-28': 55000000000 } });

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.deepEqual(snap.issues, []);
  // $1000.00 / 1.0811 = €925.09 (rate inverted to 0.92498381, then applied).
  assert.equal(p.cost, 92498);
  // 2 shares at the $550.00 close = $1100.00 -> €1017.48.
  assert.equal(p.marketValue, 101748);
  assert.equal(p.currency, 'USD', 'the security is still a dollar security');
  assert.equal(snap.totals.marketValue, 101748);
});

test('a Saturday trade converts at Friday’s fixing — there is no Saturday rate anywhere', async () => {
  // Easter 2024: the ECB's last fixing before Tuesday 04-02 is Thursday 03-28.
  // A trade dated over that gap is ordinary settlement paperwork, not an edge
  // case, and refusing it would leave most retail portfolios full of holes.
  const f = fixture();
  basics(f);
  f.put('settings', { reportingCurrency: 'USD' }, 'settings');
  f.put('fx', { pair: 'EURUSD', date: '2024-03-28', rate: 108110000 }, 'fx_thu');
  f.put('fx', { pair: 'EURUSD', date: '2024-04-02', rate: 107490000 }, 'fx_tue');
  f.put('transaction', tx({ type: 'deposit', date: '2024-03-30', amount: 100000 }), 'tx_sat');

  const snap = await f.snapshot();

  assert.deepEqual(snap.issues, []);
  // €1000.00 at Thursday's 1.0811, NOT Tuesday's 1.0749 ($1074.90) and not a gap.
  assert.equal(cash(snap), 108110);
});

test('a hole in the rate series is a gap, not the nearest rate carried across it', async () => {
  // The bound on carry-forward is the difference between "Friday's rate applies
  // on Saturday" and "a January rate applies in June". A total that quietly
  // uses the wrong rate is worse than one that says which part it could not
  // compute.
  const f = fixture();
  basics(f);
  f.put('settings', { reportingCurrency: 'USD' }, 'settings');
  f.put('fx', { pair: 'EURUSD', date: '2024-01-10', rate: 110000000 }, 'fx_jan');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-13', amount: 100000 }), 'tx_covered');
  f.put('transaction', tx({ type: 'deposit', date: '2024-06-13', amount: 500000 }), 'tx_orphan');

  const snap = await f.snapshot();

  assert.deepEqual(codes(snap), ['currency_not_converted']);
  assert.match(snap.issues[0].message, /no EURUSD rate applicable to 2024-06-13/);
  // Only the deposit inside the window is in the total.
  assert.equal(cash(snap), 110000);
});

test('an unpriceable currency leaves market value null rather than counting it as zero', async () => {
  // Same treatment as no_price, and for the same reason: a value that cannot
  // be computed is null, so the totals leave it out instead of pretending the
  // holding is worthless.
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'EUR' }, 'acct_1');
  f.put('account', { name: 'Depot', kind: 'securities', currency: 'EUR' }, 'pf_1');
  f.put('security', { name: 'VOO', currency: 'USD', assetClass: 'etf' }, 'sec_1');
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  // A rate for the trade, none anywhere near the close.
  f.put('fx', { pair: 'EURUSD', date: '2024-03-28', rate: 108110000 }, 'fx_1');
  f.put('transaction', {
    type: 'buy', accountId: 'acct_1', portfolioId: 'pf_1', securityId: 'sec_1',
    date: '2024-03-28', shares: 200000000, amount: 100000, currency: 'USD',
  }, 'tx_buy');
  f.put('price', { securityId: 'sec_1', year: 2025, closes: { '11-14': 55000000000 } });

  const snap = await f.snapshot();
  const p = only(snap.positions);

  assert.deepEqual(codes(snap), ['currency_not_converted']);
  assert.equal(p.cost, 92498, 'the basis still converted — its own day had a rate');
  assert.equal(p.marketValue, null);
  assert.equal(p.unrealized, null);
  assert.equal(snap.totals.marketValue, 0);
  assert.equal(only(snap.securities).marketValue, null);
});

test('a CHF-reporting portfolio crosses two EUR pairs into a rate neither states', async () => {
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'CHF' }, 'acct_1');
  f.put('settings', { reportingCurrency: 'CHF' }, 'settings');
  f.put('fx', { pair: 'EURUSD', date: '2024-03-28', rate: 108110000 }, 'fx_usd');
  f.put('fx', { pair: 'EURCHF', date: '2024-03-28', rate: 97660000 }, 'fx_chf');
  f.put('transaction', {
    type: 'deposit', accountId: 'acct_1', date: '2024-03-28', amount: 100000, currency: 'USD',
  }, 'tx_dep');

  const snap = await f.snapshot();

  assert.deepEqual(snap.issues, []);
  // $1000.00 x (0.9766 / 1.0811) = CHF 903.34.
  assert.equal(cash(snap), 90334);
});

test('totals reconcile against the per-position and per-account conversions', async () => {
  const f = fixture();
  f.put('account', { name: 'Cash', kind: 'cash', currency: 'EUR' }, 'acct_1');
  f.put('account', { name: 'Depot', kind: 'securities', currency: 'EUR' }, 'pf_1');
  f.put('security', { name: 'Acme', currency: 'EUR', assetClass: 'stock' }, 'sec_1');
  f.put('security', { name: 'VOO', currency: 'USD', assetClass: 'etf' }, 'sec_2');
  f.put('settings', { reportingCurrency: 'USD' }, 'settings');
  f.put('fx', { pair: 'EURUSD', date: '2024-01-10', rate: 110000000 }, 'fx_jan');
  f.put('fx', { pair: 'EURUSD', date: '2024-06-10', rate: 200000000 }, 'fx_jun');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-10', amount: 1000000 }), 'tx_dep');
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: 1000000000, amount: 100000,
  }), 'tx_buy_eur');
  f.put('transaction', {
    type: 'buy', accountId: 'acct_1', portfolioId: 'pf_1', securityId: 'sec_2',
    date: '2024-06-10', shares: 200000000, amount: 110000, currency: 'USD',
  }, 'tx_buy_usd');
  f.put('transaction', tx({ type: 'dividend', securityId: 'sec_1', date: '2024-06-10', amount: 2500 }), 'tx_div');
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '06-10': 12000000000 } });
  f.put('price', { securityId: 'sec_2', year: 2024, closes: { '06-10': 55000000000 } });

  const snap = await f.snapshot();

  assert.deepEqual(snap.issues, []);
  // Every total is exactly the sum of what the parts report — no total is
  // computed on a second, differently-converted path.
  const sum = (list, key) => list.reduce((acc, x) => acc + (x[key] ?? 0), 0);
  for (const key of ['cost', 'realized', 'dividends', 'fees', 'taxes', 'unrealized']) {
    assert.equal(snap.totals[key], sum(snap.positions, key), key);
  }
  assert.equal(snap.totals.marketValue, sum(snap.positions, 'marketValue'));
  assert.equal(snap.totals.cash, sum(snap.accounts, 'balance'));
  assert.equal(snap.totals.total, snap.totals.cash + snap.totals.marketValue);
  // And the parts are the hand-converted numbers, so "reconciles" is not two
  // wrongs agreeing: the EUR trade at 1.10, the USD trade untouched, the
  // dividend at 2.00.
  const byName = Object.fromEntries(snap.positions.map((p) => [p.name, p]));
  assert.equal(byName.Acme.cost, 110000);
  assert.equal(byName.Acme.dividends, 5000);
  assert.equal(byName.VOO.cost, 110000);
  assert.equal(byName.Acme.marketValue, 240000);
  assert.equal(byName.VOO.marketValue, 110000);
});

test('a single-currency portfolio is byte-identical with the FX machinery in play', async () => {
  // Most users have one currency and must see no change at all — not a
  // rounding difference, not a reordered issue, nothing.
  const build = (withFx) => {
    const f = fixture();
    basics(f);
    if (withFx) {
      f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
      f.put('fx', { pair: 'EURUSD', date: '2024-01-10', rate: 110000000 }, 'fx_1');
      f.put('fx', { pair: 'EURUSD', date: '2024-06-10', rate: 200000000 }, 'fx_2');
    }
    f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: 1000000 }), 'tx_1');
    f.put('transaction', tx({
      type: 'buy', securityId: 'sec_1', date: '2024-01-10',
      shares: 1000000000, amount: 100990, fees: 990,
    }), 'tx_2');
    f.put('transaction', tx({
      type: 'sell', securityId: 'sec_1', date: '2024-02-10',
      shares: 400000000, amount: 43604, fees: 396, taxes: 500,
    }), 'tx_3');
    f.put('transaction', tx({ type: 'dividend', securityId: 'sec_1', date: '2024-03-01', amount: 2500 }), 'tx_4');
    f.put('price', { securityId: 'sec_1', year: 2024, closes: { '06-10': 11500000000 } });
    return f.snapshot();
  };

  const [plain, converted] = await Promise.all([build(false), build(true)]);

  assert.equal(converted.reportingCurrency, 'EUR');
  assert.equal(plain.reportingCurrency, null);
  assert.deepEqual({ ...converted, reportingCurrency: null }, plain);
});

test('case is not a currency difference', async () => {
  const f = fixture();
  basics(f);
  f.put('settings', { reportingCurrency: 'EUR' }, 'settings');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-10', amount: 100000, currency: 'eur' }), 'tx_1');

  const snap = await f.snapshot();

  assert.deepEqual(snap.issues, []);
  assert.equal(cash(snap), 100000);
  assert.equal(snap.reportingCurrency, 'EUR', 'and the stored setting is echoed back verbatim');
});
