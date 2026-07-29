import test from 'node:test';
import assert from 'node:assert/strict';

import { createPerformanceDomain, xirr } from './perf.js';

// An in-memory stand-in for the §3 records port, same shape as portfolio.test.js.
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
  return { put, performance: (opts) => createPerformanceDomain({ records }).performance(opts) };
}

function basics(f, { currency = 'EUR' } = {}) {
  f.put('account', { name: 'Cash', kind: 'cash', currency }, 'acct_1');
  // §4 keys a position by (accountId, securityId) where that accountId is the
  // SECURITIES account — so a trade names the depot as well as the cash account
  // it settles on. Nothing else in this file depends on it: a securities account
  // holds no cash, so every balance and total below is unchanged.
  f.put('account', { name: 'Depot', kind: 'securities', currency }, 'pf_1');
  f.put('security', { name: 'Acme', ticker: 'ACME', currency, assetClass: 'stock' }, 'sec_1');
}

const tx = (body) => ({ accountId: 'acct_1', portfolioId: 'pf_1', currency: 'EUR', ...body });
const eur = (x) => Math.round(x * 100);              // €        -> 1e2 units
const sh = (x) => Math.round(x * 1e8);               // shares   -> 1e8 units
const px = (x) => Math.round(x * 1e8);               // price    -> 1e8 units
const bySecurity = (res, id) => res.securities.find((s) => s.securityId === id);

// An independent NPV, written from the XIRR definition rather than reused from
// perf.js: ACT/365 discounting of each flow from the earliest date. Used to
// confirm a returned rate really is a root, not merely a plausible number.
function npvIndependent(flows, rate) {
  const ms = (d) => Date.parse(`${d}T00:00:00Z`);
  const t0 = Math.min(...flows.map((f) => ms(f.date)));
  return flows.reduce(
    (acc, f) => acc + f.amount / (1 + rate) ** ((ms(f.date) - t0) / 86400000 / 365),
    0,
  );
}

// --- TTWROR ----------------------------------------------------------------

test('TTWROR: a mid-period deposit does not move the number', async () => {
  const f = fixture();
  basics(f);
  // €100,000 in, all of it invested at €100/share on day one.
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(100000) }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-01',
    shares: sh(1000), amount: eur(100000),
  }));
  // A further €10,000 deposited mid-year and left in cash.
  f.put('transaction', tx({ type: 'deposit', date: '2024-06-30', amount: eur(10000) }));
  f.put('price', {
    securityId: 'sec_1',
    year: 2024,
    closes: { '01-01': px(100), '06-29': px(120), '06-30': px(120), '12-31': px(130) },
  });

  const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });

  // Textbook chain-linking, computed here from the sub-period end values alone
  // and nothing else: €100,000 -> €120,000 before the deposit, then €130,000 ->
  // €140,000 after it. TTWROR = (120/100) x (140/130) - 1 = 29.2307...%.
  const expected = (120000 / 100000) * (140000 / 130000) - 1;
  assert.equal(res.portfolio.ttwror.ok, true);
  assert.ok(Math.abs(res.portfolio.ttwror.value - expected) < 1e-12,
    `${res.portfolio.ttwror.value} != ${expected}`);

  // The failure mode this test exists for: folding the deposit into the opening
  // capital of the whole first sub-period gives 27.27%, which is what a
  // TTWROR that is really a money-weighted return in disguise reports.
  const distorted = (130000 / 110000) * (140000 / 130000) - 1;
  assert.ok(Math.abs(res.portfolio.ttwror.value - distorted) > 0.01);

  assert.equal(res.openDate, '2023-12-31', 'the range is inclusive, so it opens the day before `from`');
  assert.equal(res.portfolio.openValue, 0);
  assert.equal(res.portfolio.closeValue, eur(140000));
  assert.equal(res.portfolio.flowIn, eur(110000));
  assert.deepEqual(res.issues, []);
});

test('TTWROR: the same portfolio IRR is money-weighted, and is a real root', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(100000) }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-01',
    shares: sh(1000), amount: eur(100000),
  }));
  f.put('transaction', tx({ type: 'deposit', date: '2024-06-30', amount: eur(10000) }));
  f.put('price', {
    securityId: 'sec_1',
    year: 2024,
    closes: { '01-01': px(100), '06-29': px(120), '06-30': px(120), '12-31': px(130) },
  });

  const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });
  assert.equal(res.portfolio.irr.ok, true);

  // Independent check: the flows a spreadsheet would be given, discounted by a
  // separately written NPV, must vanish at the reported rate.
  const flows = [
    { date: '2024-01-01', amount: -100000 },
    { date: '2024-06-30', amount: -10000 },
    { date: '2024-12-31', amount: 140000 },
  ];
  assert.ok(Math.abs(npvIndependent(flows, res.portfolio.irr.value)) < 1e-6,
    `NPV at ${res.portfolio.irr.value} is ${npvIndependent(flows, res.portfolio.irr.value)}`);
  // And the two must disagree in the right direction. The €10,000 deposited in
  // June sat in cash earning nothing for half a year, so the money-weighted
  // return (28.65%) is dragged below the time-weighted one (29.23%) — a
  // TTWROR that merely echoed the IRR would fail here.
  assert.ok(Math.abs(res.portfolio.irr.value - 0.2864602934766) < 1e-9, `${res.portfolio.irr.value}`);
  assert.ok(res.portfolio.irr.value < res.portfolio.ttwror.value);
});

test('TTWROR: per security, a dividend is return and not a withdrawal', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(1000) }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-10', shares: sh(10), amount: eur(1000),
  }));
  // Flat price all year, so every basis point of return has to come from the
  // €50 dividend on a €1,000 position: exactly 5%.
  f.put('transaction', tx({ type: 'dividend', securityId: 'sec_1', date: '2024-06-10', amount: eur(50) }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '01-10': px(100), '12-31': px(100) } });

  const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });
  const s = bySecurity(res, 'sec_1');

  assert.equal(s.ttwror.ok, true);
  assert.ok(Math.abs(s.ttwror.value - 0.05) < 1e-12, `${s.ttwror.value}`);
  assert.equal(s.flowIn, eur(1000));
  assert.equal(s.flowOut, eur(50));
});

test('TTWROR: a position opened and fully closed inside the range', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(1000) }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-03-01', shares: sh(10), amount: eur(1000),
  }));
  f.put('transaction', tx({
    type: 'sell', securityId: 'sec_1', date: '2024-06-01', shares: sh(10), amount: eur(1200),
  }));
  f.put('price', { securityId: 'sec_1', year: 2024, closes: { '03-01': px(100), '06-01': px(120) } });

  const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });
  const s = bySecurity(res, 'sec_1');

  // Bought at €100, sold at €120: 20%, whether or not the position is flat at
  // both ends of the range.
  assert.equal(s.ttwror.ok, true);
  assert.ok(Math.abs(s.ttwror.value - 0.2) < 1e-12, `${s.ttwror.value}`);
  assert.equal(s.openValue, 0);
  assert.equal(s.closeValue, 0);

  // Two flows 92 days apart, so the money-weighted rate has a closed form.
  const expected = 1.2 ** (365 / 92) - 1;
  assert.equal(s.irr.ok, true);
  assert.ok(Math.abs(s.irr.value - expected) < 1e-9, `${s.irr.value} != ${expected}`);

  // The cash sat idle before and after, so the portfolio earned the same 20%
  // over the whole range but only through the one sub-period that held it.
  assert.equal(res.portfolio.ttwror.ok, true);
  assert.ok(Math.abs(res.portfolio.ttwror.value - 0.2) < 1e-12);
});

test('TTWROR: an unpriced holding refuses to report, rather than valuing it at zero', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(1000) }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-03-01', shares: sh(10), amount: eur(1000),
  }));
  // No price record at all: the position's value after the buy is unknowable.

  const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });

  assert.equal(res.portfolio.ttwror.ok, false);
  assert.equal(res.portfolio.ttwror.reason, 'incomplete_valuation');
  assert.equal(res.portfolio.irr.ok, false);
  assert.equal(res.portfolio.irr.reason, 'incomplete_valuation');
  assert.equal(res.portfolio.closeValue, null);
  assert.ok(res.issues.some((i) => i.code === 'no_price'));
});

test('TTWROR: a transfer in flight is neutral, not a loss', async () => {
  // §4 books each transfer leg against its own account only, so between the two
  // legs the tracked total genuinely falls by the transferred amount. Counting
  // the leg as a flow is what makes that neutral. The tempting "transfers are
  // internal, skip them" simplification reports -40% for both cases below.
  const inFlight = fixture();
  inFlight.put('account', { name: 'A', kind: 'cash', currency: 'EUR' }, 'a');
  inFlight.put('account', { name: 'B', kind: 'cash', currency: 'EUR' }, 'b');
  inFlight.put('transaction', { type: 'deposit', accountId: 'a', currency: 'EUR', date: '2024-01-01', amount: eur(1000) });
  inFlight.put('transaction', { type: 'transfer_out', accountId: 'a', counterAccountId: 'b', currency: 'EUR', date: '2024-03-10', amount: eur(400) });
  inFlight.put('transaction', { type: 'transfer_in', accountId: 'b', counterAccountId: 'a', currency: 'EUR', date: '2024-03-12', amount: eur(400) });

  // A range that ends while the money is between the two accounts.
  const mid = await inFlight.performance({ from: '2024-01-01', to: '2024-03-11' });
  assert.deepEqual(mid.portfolio.ttwror, { ok: true, value: 0 });
  assert.equal(mid.portfolio.closeValue, eur(600), 'the tracked total really has dropped');

  // And one that spans both legs.
  const whole = await inFlight.performance({ from: '2024-01-01', to: '2024-06-01' });
  assert.deepEqual(whole.portfolio.ttwror, { ok: true, value: 0 });

  // A single leg whose counterparty this portfolio does not track at all: a
  // real external withdrawal, and the only reading under which the money is
  // gone for good rather than in flight.
  const external = fixture();
  external.put('account', { name: 'A', kind: 'cash', currency: 'EUR' }, 'a');
  external.put('transaction', { type: 'deposit', accountId: 'a', currency: 'EUR', date: '2024-01-01', amount: eur(1000) });
  external.put('transaction', { type: 'transfer_out', accountId: 'a', counterAccountId: 'bank', currency: 'EUR', date: '2024-03-10', amount: eur(400) });
  const res = await external.performance({ from: '2024-01-01', to: '2024-06-01' });
  assert.deepEqual(res.portfolio.ttwror, { ok: true, value: 0 });
  assert.equal(res.portfolio.flowOut, eur(400));
});

test('TTWROR: a same-day internal transfer does not dilute a day that moved', async () => {
  const f = fixture();
  basics(f);
  f.put('account', { name: 'B', kind: 'cash', currency: 'EUR' }, 'acct_2');
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(1000) }));
  f.put('transaction', tx({
    type: 'buy', securityId: 'sec_1', date: '2024-01-01', shares: sh(10), amount: eur(1000),
  }));
  // Both legs on 2024-06-30 — and the holding gains 10% that same day.
  f.put('transaction', tx({ type: 'transfer_out', counterAccountId: 'acct_2', date: '2024-06-30', amount: eur(100) }));
  f.put('transaction', { type: 'transfer_in', accountId: 'acct_2', counterAccountId: 'acct_1', currency: 'EUR', date: '2024-06-30', amount: eur(100) });
  f.put('price', {
    securityId: 'sec_1',
    year: 2024,
    closes: { '01-01': px(100), '06-29': px(100), '06-30': px(110), '12-31': px(110) },
  });

  const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });

  // Nothing external happened, so the whole return is the 10% price move.
  // Applying the two legs gross rather than netting them gives 9.09%:
  // (1100 + 100) / (1000 + 100).
  assert.equal(res.portfolio.ttwror.ok, true);
  assert.ok(Math.abs(res.portfolio.ttwror.value - 0.1) < 1e-12, `${res.portfolio.ttwror.value}`);
});

// --- Degenerate ranges -----------------------------------------------------

test('a range entirely before any transaction reports no capital, not 0%', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(1000) }));

  const res = await f.performance({ from: '2020-01-01', to: '2020-12-31' });

  assert.equal(res.portfolio.ttwror.ok, false);
  assert.equal(res.portfolio.ttwror.reason, 'no_capital');
  assert.equal(res.portfolio.irr.ok, false);
  assert.equal(res.portfolio.irr.reason, 'not_enough_flows');
  assert.deepEqual(res.securities, []);
});

test('an empty record set has nothing to measure and no window to measure it in', async () => {
  const f = fixture();
  const res = await f.performance();
  assert.equal(res.from, null);
  assert.equal(res.portfolio, null);
  assert.deepEqual(res.securities, []);
});

test('a single deposit is a 0% time-weighted return and an undefined IRR', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-05-05', amount: eur(1000) }));

  const res = await f.performance();

  assert.equal(res.from, '2024-05-05');
  assert.equal(res.to, '2024-05-05');
  assert.equal(res.portfolio.ttwror.ok, true);
  assert.equal(res.portfolio.ttwror.value, 0, 'depositing money is not a return');
  // Every flow lands on one day, so there is no elapsed time to earn a rate over.
  assert.equal(res.portfolio.irr.ok, false);
  assert.equal(res.portfolio.irr.reason, 'no_time_span');
});

test('an inverted range is rejected outright', async () => {
  const f = fixture();
  basics(f);
  f.put('transaction', tx({ type: 'deposit', date: '2024-05-05', amount: eur(1000) }));
  await assert.rejects(() => f.performance({ from: '2024-06-01', to: '2024-05-01' }), RangeError);
  await assert.rejects(() => f.performance({ from: '2024-02-30', to: '2024-05-01' }), RangeError);
  await assert.rejects(() => f.performance({ from: 'yesterday', to: '2024-05-01' }), RangeError);
});

// --- IRR / xirr ------------------------------------------------------------

test('xirr matches the worked example in the Excel XIRR documentation', async () => {
  // Microsoft's own XIRR example: -10,000 invested 2008-01-01 with four
  // returns, documented result 0.373362535. Matching it pins the ACT/365 day
  // count and the discounting convention against an outside source.
  const flows = [
    { date: '2008-01-01', amount: -10000 },
    { date: '2008-03-01', amount: 2750 },
    { date: '2008-10-30', amount: 4250 },
    { date: '2009-02-15', amount: 3250 },
    { date: '2009-04-01', amount: 2750 },
  ];
  const res = xirr(flows);
  assert.equal(res.ok, true);

  // We land on 0.3733625335..., which differs from the published 0.373362535
  // in the 9th decimal — 4e-9 relative. That gap is Excel's, not ours, and it
  // is measurable: NPV at the published figure is -8.6e-6, while NPV at our
  // root is -6.8e-13, i.e. zero to double precision. Excel's XIRR is an
  // iterative solver documented to stop at 1e-8 relative accuracy, so the two
  // agree as closely as the reference can be trusted, and ours is the exact
  // root of the two. The tolerance below is Excel's accuracy, not ours; the
  // exact-root assertion after it is ours.
  assert.ok(Math.abs(res.value - 0.373362535) < 1e-8, `${res.value} != 0.373362535`);
  assert.ok(Math.abs(npvIndependent(flows, res.value)) < 1e-9, 'the returned rate must be an actual root');
  assert.ok(Math.abs(npvIndependent(flows, 0.373362535)) > 1e-6,
    'the published figure is a rounded approximation, so it is not itself a root');
});

test('xirr is scale invariant, so fixed-point units feed it directly', () => {
  const cents = [
    { date: '2008-01-01', amount: -1000000 },
    { date: '2008-03-01', amount: 275000 },
    { date: '2008-10-30', amount: 425000 },
    { date: '2009-02-15', amount: 325000 },
    { date: '2009-04-01', amount: 275000 },
  ];
  assert.equal(xirr(cents).value, xirr(cents.map((f) => ({ ...f, amount: f.amount / 100 }))).value);
  assert.ok(Math.abs(xirr(cents).value - 0.373362535) < 1e-8);
});

test('xirr refuses a multi-root series instead of picking one', () => {
  // The textbook non-conventional cash flow: -1000, +2500, -1540 at one-year
  // spacing has roots at exactly 10% and 40%, because
  // -1000x^2 + 2500x - 1540 = 0 factorises at x = 1.1 and x = 1.4.
  // Non-leap years throughout, so ACT/365 gives whole-year exponents.
  const res = xirr([
    { date: '2021-01-01', amount: -1000 },
    { date: '2022-01-01', amount: 2500 },
    { date: '2023-01-01', amount: -1540 },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'multiple_roots');
  assert.equal(res.roots.length, 2);
  assert.ok(Math.abs(res.roots[0] - 0.10) < 1e-9, `${res.roots[0]}`);
  assert.ok(Math.abs(res.roots[1] - 0.40) < 1e-9, `${res.roots[1]}`);
  assert.equal(res.value, undefined, 'a non-convergent result must not carry a number');
});

test('xirr refuses the degenerate series rather than returning NaN', () => {
  assert.deepEqual(xirr([]), { ok: false, reason: 'not_enough_flows' });
  assert.deepEqual(
    xirr([{ date: '2024-01-01', amount: -100 }]),
    { ok: false, reason: 'not_enough_flows' },
  );
  // Zero-amount flows carry no information and are not counted towards the two.
  assert.deepEqual(
    xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-06-01', amount: 0 }]),
    { ok: false, reason: 'not_enough_flows' },
  );
  assert.deepEqual(
    xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-01-01', amount: 150 }]),
    { ok: false, reason: 'no_time_span' },
  );
  // Money that only ever goes one way has no rate of return.
  assert.deepEqual(
    xirr([{ date: '2024-01-01', amount: 100 }, { date: '2024-06-01', amount: 150 }]),
    { ok: false, reason: 'no_sign_change' },
  );
  assert.throws(() => xirr([{ date: '2024-01-01', amount: NaN }]), RangeError);
  assert.throws(() => xirr([{ date: '2024-1-1', amount: -100 }]), RangeError);
});

test('xirr recovers a large negative rate without walking past r = -1', () => {
  // Losing 90% in a year. Newton from a positive guess is exactly the case that
  // steps below -1 and produces a complex power / NaN.
  const flows = [
    { date: '2024-01-01', amount: -100000 },
    { date: '2024-12-31', amount: 10000 },
  ];
  // 2024-01-01 to 2024-12-31 is 365 days even in a leap year, so the annual
  // rate is exactly the period rate: -90%.
  const res = xirr(flows);
  assert.equal(res.ok, true);
  assert.ok(Math.abs(res.value - -0.9) < 1e-9, `${res.value} != -0.9`);
});

// --- Day handling ----------------------------------------------------------

test('days are UTC calendar days, unaffected by the machine timezone', async () => {
  const before = process.env.TZ;
  const run = async () => {
    const f = fixture();
    basics(f);
    f.put('transaction', tx({ type: 'deposit', date: '2024-01-01', amount: eur(1000) }));
    f.put('transaction', tx({
      type: 'buy', securityId: 'sec_1', date: '2024-01-01', shares: sh(10), amount: eur(1000),
    }));
    f.put('price', { securityId: 'sec_1', year: 2024, closes: { '01-01': px(100), '12-31': px(110) } });
    const res = await f.performance({ from: '2024-01-01', to: '2024-12-31' });
    return [res.openDate, res.portfolio.ttwror.value];
  };

  process.env.TZ = 'Pacific/Kiritimati';   // UTC+14
  const east = await run();
  process.env.TZ = 'Pacific/Midway';       // UTC-11
  const west = await run();
  process.env.TZ = before;

  assert.deepEqual(east, west);
  assert.equal(east[0], '2023-12-31');
  assert.ok(Math.abs(east[1] - 0.1) < 1e-12);
});
