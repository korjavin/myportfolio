// The performance engine: TTWROR (true time-weighted return) and IRR (money-
// weighted, spreadsheet-XIRR-compatible), over an arbitrary date range, both
// portfolio-wide and per security. Pure logic over the ARCHITECTURE.md §3
// records port — no window, document, fetch, indexedDB, and no clock.
//
// Positions and valuations are NOT re-derived here. Every value comes from
// portfolio.js `snapshot({ asOf })`, so the two engines agree by construction
// and the §4 fee/tax semantics are honoured in exactly one place.
//
// Money stays on §5 fixed-point integers all the way to the ratio. Only the
// division that turns two integer valuations into a return factor is a float —
// returns are ratios, not money, and the scale cancels out of every one of them.
//
// ---------------------------------------------------------------------------
// Conventions. All three are load-bearing; changing one changes every number.
// ---------------------------------------------------------------------------
//
// DAYS ARE UTC CALENDAR DAYS. A date is the first 10 characters of a record's
// `date` ("YYYY-MM-DD") — the same slice portfolio.js takes — read as a UTC
// calendar day. All day arithmetic goes through Date.UTC; nothing here
// constructs a local-time Date or calls `new Date()` with no argument, so no
// result moves when the machine's timezone does. A date string that is not a
// real calendar day is rejected rather than silently rolled forward.
//
// THE RANGE [from, to] IS INCLUSIVE AT BOTH ENDS. Consequently the opening
// valuation is the close of the day *before* `from`, and a transaction dated
// `from` is inside the range, not before it. The closing valuation is the close
// of `to`. This is the reading a date filter on the transaction list gives, so
// "2024 performance" (2024-01-01..2024-12-31) contains every 2024 transaction.
//
// FLOW TIMING: MONEY IN AT THE START OF ITS DAY, MONEY OUT AT THE END. Every
// unit of capital is therefore at risk for the whole of each day it is present.
// For a sub-period ending on day d:
//
//     factor = (value(d) + outflow(d)) / (value(d-1) + inflow(d))
//
// This is the only timing convention that stays defined at both ends of a
// position's life. "All flows at the end of the day" divides by zero on the day
// a position is opened (value(d-1) = 0); "all flows at the start of the day"
// yields a negative denominator on the day one is closed out at a profit. With
// daily closes there is no more information than this to work with, so the
// choice is a convention — it is stated rather than buried.
//
// Flows are NETTED per day before that formula is applied, which is also
// ordinary daily-TWR practice: nothing in the records resolves intraday
// ordering, so a day carries one net flow. See netFlow() for why applying them
// gross gets a same-day internal transfer wrong.
//
// FLOWS ARE IN THE REPORTING CURRENCY, CONVERTED AT THE TRANSACTION'S OWN DAY.
// Valuations arrive from snapshot() already in `settings.reportingCurrency`, so
// a flow left in the transaction's own currency would put two different units in
// one fraction and TTWROR would print the difference as a return. The rule is
// portfolio.js's, not a second one: the applicable fixing for the transaction's
// date — never the newest stored rate, never today's — and where none applies
// the flow is left out entirely under the same `currency_not_converted` issue,
// because an unknown flow is not a zero one and is certainly not a foreign
// number pretending to be a local one.

import { RECORD, SETTINGS_ID } from './schema.js';
import { createPortfolioDomain } from './portfolio.js';
import { createFxRates } from './fx.js';
import { convert } from './money.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

// XIRR discounts in years of exactly 365 days regardless of leap years (ACT/365),
// and so does every spreadsheet implementation. Matching it is the point.
const DAYS_PER_YEAR = 365;

// --- Calendar --------------------------------------------------------------

// Date.UTC(2024, 1, 30) quietly rolls to March 1, which would move a
// transaction to a different sub-period. Round-tripping the string catches it.
function dayMs(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) {
    throw new RangeError(`not a YYYY-MM-DD day: ${JSON.stringify(day)}`);
  }
  const ms = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  if (new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`not a real calendar day: ${day}`);
  }
  return ms;
}

const addDays = (day, n) => new Date(dayMs(day) + n * MS_PER_DAY).toISOString().slice(0, 10);

// Same truncation portfolio.js uses, so a record with a full timestamp lands in
// the same day in both engines.
const dayOf = (date) => String(date ?? '').slice(0, 10);

// --- IRR -------------------------------------------------------------------

function npvAt(terms, x) {
  let acc = 0;
  for (const t of terms) acc += t.amount / Math.pow(x, t.years);
  return acc;
}

// Bisect a known sign-change bracket in x = 1 + r down to one ulp. ~50-60
// iterations in practice; the loop bound is only a backstop.
function bisect(terms, lo, hi) {
  let flo = npvAt(terms, lo);
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi) break;
    const fm = npvAt(terms, mid);
    if (fm === 0) return mid;
    if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}

// The scan runs over x = 1 + r, geometrically, so the grid is as fine near
// r = -99.9999% as it is at r = +100000000%. The top end has to be absurd: a
// two-day holding period that gains 1% annualises past 500000%.
const SCAN_LO_X = 1e-6;
const SCAN_HI_X = 1e9;
const SCAN_STEPS = 2000;

// xirr — money-weighted return of a dated cash-flow series.
//
// `flows` is [{ date: "YYYY-MM-DD", amount }] with a spreadsheet's XIRR sign
// convention: money leaving your pocket is negative, money arriving is
// positive. `amount` may be §5 fixed-point units — the scale cancels, because
// the root of the NPV is scale-invariant.
//
// Returns { ok: true, value } where `value` is the annual rate (0.0734 = 7.34%),
// or { ok: false, reason, ... } — NEVER NaN, never a clamped or arbitrarily
// chosen number. Reasons:
//   not_enough_flows  fewer than two non-zero flows
//   no_time_span      every flow falls on the same day, so no rate is defined
//   no_sign_change    all flows share a sign; NPV has no root
//   multiple_roots    NPV crosses zero more than once — `roots` lists them, and
//                     picking one would be a coin flip presented as an answer
//   not_bracketed     NPV never crosses zero within the scanned range
//
// Deliberately NOT Newton-Raphson. Newton on a sign-alternating series can walk
// to a spurious root, diverge, or land past r = -1, and each of those returns a
// confident wrong number; the fix in every case is a bracket, which is what the
// fallback would have to build anyway. So: scan for sign changes, refuse when
// there is not exactly one, bisect the one. Fewer lines than Newton plus a
// fallback, and no silent-garbage mode.
export function xirr(flows) {
  const dated = [];
  for (const f of flows) {
    const amount = Number(f.amount);
    if (!Number.isFinite(amount)) throw new RangeError(`xirr: non-finite amount ${f.amount}`);
    if (amount === 0) continue;
    dated.push({ ms: dayMs(f.date), amount });
  }
  if (dated.length < 2) return { ok: false, reason: 'not_enough_flows' };

  let t0 = dated[0].ms;
  for (const f of dated) if (f.ms < t0) t0 = f.ms;
  const terms = dated.map((f) => ({ amount: f.amount, years: (f.ms - t0) / MS_PER_DAY / DAYS_PER_YEAR }));

  if (terms.every((t) => t.years === terms[0].years)) return { ok: false, reason: 'no_time_span' };
  if (!terms.some((t) => t.amount > 0) || !terms.some((t) => t.amount < 0)) {
    return { ok: false, reason: 'no_sign_change' };
  }

  const step = Math.pow(SCAN_HI_X / SCAN_LO_X, 1 / SCAN_STEPS);
  const found = [];
  let prevX = SCAN_LO_X;
  let prevF = npvAt(terms, prevX);
  if (prevF === 0) found.push(prevX);
  for (let i = 1; i <= SCAN_STEPS; i += 1) {
    const x = SCAN_LO_X * Math.pow(step, i);
    const f = npvAt(terms, x);
    // A very long range overflows the discount factor at the extremes of the
    // scan. Such a point carries no sign information, so it brackets nothing.
    if (Number.isFinite(f)) {
      if (f === 0) found.push(x);
      else if (Number.isFinite(prevF) && prevF !== 0 && (f < 0) !== (prevF < 0)) {
        found.push(bisect(terms, prevX, x));
      }
    }
    prevX = x;
    prevF = f;
  }

  if (found.length === 0) return { ok: false, reason: 'not_bracketed' };

  // Two adjacent grid cells can bracket what is really one root (a near-tangent
  // touch). Collapse those before calling it ambiguous.
  const roots = [];
  for (const x of found.map((x) => x - 1).sort((a, b) => a - b)) {
    const last = roots[roots.length - 1];
    if (last === undefined || Math.abs(x - last) > 1e-9 * Math.max(1, Math.abs(x))) roots.push(x);
  }
  if (roots.length > 1) return { ok: false, reason: 'multiple_roots', roots };
  return { ok: true, value: roots[0] };
}

// --- Flow classification ---------------------------------------------------

// The portfolio's boundary encloses every account and every position, so the
// only external flows are money entering or leaving that whole set. Buys,
// sells, dividends, interest, fees and taxes all stay inside it: they move
// value between cash and securities, or they ARE the return (dividends,
// interest) or the drag on it (fees, taxes). Netting a fee out as an "outflow"
// would credit it back in the numerator and make it invisible — which is the
// single most common way a performance number flatters itself.
//
// Transfers ARE counted, and they have to be. §4 books each leg independently
// against its own account and never from its counterparty, so while a transfer
// is in flight — legs on different days, or a leg whose counter account this
// portfolio does not track at all — the total genuinely drops. Treating the leg
// as a flow is what cancels that; dropping it, as "transfers are internal"
// suggests, reports a phantom loss of the transferred amount. Two legs landing
// on the same day cancel in netFlow() below, so the internal case costs nothing.
//
// The residual cost is that flowIn/flowOut count both sides of an internal
// round-trip. Netting them would mean deciding a transfer is internal from
// `counterAccountId` naming a tracked account — but §4 warns that a UI may
// write only one leg, and guessing wrong there reintroduces the phantom loss
// into the return itself. Overstated flow totals are the cheaper error.
const PORTFOLIO_FLOW = { deposit: 'in', transfer_in: 'in', removal: 'out', transfer_out: 'out' };

// One position's boundary encloses the shares only. An inflow is cash the
// investor puts into that position; an outflow is cash the position hands back.
// A dividend is an outflow by that definition and, because outflows land in the
// numerator, it is credited as return rather than treated as a withdrawal —
// which is exactly right. A standalone fee or tax booked against a security is
// an inflow, so it drags the position's return down.
const SECURITY_FLOW = { buy: 'in', sell: 'out', dividend: 'out', fee: 'in', tax: 'in' };

// --- Engine ----------------------------------------------------------------

// snapshot() re-reads the whole record set, and this engine calls it at every
// sub-period boundary. One cache per performance() call keeps that to a single
// read per record type, and being per-call means a later call still sees writes
// made in between.
function cacheLists(records) {
  const cache = new Map();
  return {
    list(recordType) {
      if (!cache.has(recordType)) cache.set(recordType, records.list(recordType));
      return cache.get(recordType);
    },
    put: (...args) => records.put(...args),
    del: (...args) => records.del(...args),
  };
}

// The value of each entity at one snapshot, in §5 amount units, or null where
// it is genuinely unknown. `marketValue` is null when portfolio.js found no
// price on or before that day; with shares outstanding that is unknowable, and
// snapshot.totals would silently count it as zero. Returning null instead is
// what stops this engine reporting a return computed off an understated total.
//
// It reads `snap.securities`, NOT `snap.positions`: §4 keys a position by
// (accountId, securityId), so the same security at two brokers is two positions,
// while a security's flows here are portfolio-wide. Folding the positions back
// together locally would be a second definition of that aggregate, free to drift
// from portfolio.js's — and a per-security return computed against one depot's
// value and both depots' flows is confidently wrong (10 shares at each of two
// depots, €100 -> €120, reports -40% for a +20% holding).
//
// UNKNOWN IS STICKY across depots: portfolio.js resolves a quote per security,
// so `marketValue` is null for every position holding it or for none, and the
// aggregate is null exactly when the security is unpriced. A total summed from
// only the depots that do have a value understates the holding, which is the
// same class of error as counting an unpriced position as zero.
function valuesOf(snap) {
  const securities = new Map();
  let total = snap.totals.cash;
  let known = true;
  for (const s of snap.securities) {
    // Flat means worth zero at any price, so an unpriced but closed-out holding
    // is known, not unknown — otherwise a sold-out security would poison every
    // later valuation of the whole portfolio.
    const v = s.marketValue === null ? (s.shares === 0 ? 0 : null) : s.marketValue;
    securities.set(s.securityId, v);
    if (v === null) known = false;
    else total += v;
  }
  return { portfolio: known ? total : null, securities };
}

// One net flow per day, then routed by its sign into the start-of-day /
// end-of-day convention.
//
// Applying a day's flows gross instead dilutes every day that carries both
// directions, because the inflow inflates the denominator and the outflow the
// numerator: a €100 transfer between two tracked accounts, on a day a €1,000
// holding rises to €1,100, comes out as (1100+100)/(1000+100) = 9.09% rather
// than 10%. Nothing external happened, so nothing should have moved. Same-day
// internal transfers are common enough (moving cash between your own accounts)
// that this would quietly bias the headline number.
//
// ponytail: a same-day round trip within one security — buy and sell of equal
// value — nets to zero, so that security's TTWROR shows nothing for the day.
// Accepted: the "return" there is over a zero-length holding period, it is an
// artifact of daily granularity either way, and the realized gain still shows
// in portfolio.js. Fixing it needs intraday timestamps, which §4 records do
// not carry.
function netFlow(flow) {
  const net = flow ? flow.in - flow.out : 0;
  return net >= 0 ? { in: net, out: 0 } : { in: 0, out: -net };
}

// Chain-link the sub-period returns. `dates` is ascending and contains, for
// every day carrying a flow, the day before it as well — that is what keeps a
// mid-period deposit from distorting the result: the quiet stretch before the
// flow is measured on its own, and only the flow day itself is flow-adjusted.
function chainLink(dates, valueAt, flowsByDate) {
  let product = 1;
  let anyCapital = false;
  for (let i = 1; i < dates.length; i += 1) {
    const prevV = valueAt(dates[i - 1]);
    const curV = valueAt(dates[i]);
    if (prevV === null || curV === null) {
      return { ok: false, reason: 'incomplete_valuation', date: prevV === null ? dates[i - 1] : dates[i] };
    }
    const flow = netFlow(flowsByDate.get(dates[i]));
    const den = prevV + flow.in;
    const num = curV + flow.out;
    if (den > 0) {
      product *= num / den;
      anyCapital = true;
    } else if (den !== 0 || num !== 0) {
      // Nothing invested but value appeared, or capital was negative (an
      // overdrawn account). A time-weighted return has no meaning on either.
      return { ok: false, reason: 'undefined_sub_period', date: dates[i] };
    }
    // den === 0 && num === 0: nothing was invested, so the period contributes
    // a factor of 1 rather than a return.
  }
  if (!anyCapital) return { ok: false, reason: 'no_capital' };
  return { ok: true, value: product - 1 };
}

function irrOf(openDate, openValue, toDate, closeValue, flowsByDate) {
  if (openValue === null || closeValue === null) return { ok: false, reason: 'incomplete_valuation' };
  const flows = [];
  // Opening value is money the investor already had committed at the start of
  // the range, and the closing value is what walking away would hand back.
  if (openValue !== 0) flows.push({ date: openDate, amount: -openValue });
  // Netted like the TTWROR chain. Two same-date flows of opposite sign cancel
  // exactly in the NPV anyway, so this changes no rate — it just keeps the two
  // engines fed from one definition of "the flow on day d".
  for (const [date, gross] of flowsByDate) {
    const flow = netFlow(gross);
    if (flow.in !== 0) flows.push({ date, amount: -flow.in });
    if (flow.out !== 0) flows.push({ date, amount: flow.out });
  }
  if (closeValue !== 0) flows.push({ date: toDate, amount: closeValue });
  return xirr(flows);
}

export function createPerformanceDomain({ records }) {
  // performance({ from, to }) — TTWROR and IRR over [from, to] inclusive, for
  // the whole portfolio and for each security that was held or traded in it.
  // Both default to the span of the transaction log.
  async function performance({ from, to } = {}) {
    const port = cacheLists(records);
    const { snapshot } = createPortfolioDomain({ records: port });

    const issues = [];
    const issue = (code, recordId, message) => issues.push({ code, recordId, message });

    // Read through the same cache snapshot() uses, so this costs no extra port
    // reads. Settings and rates are needed BEFORE the first snapshot because the
    // flow fold below runs first.
    const [txRecs, fxRecs, settingsRecs] = await Promise.all([
      port.list(RECORD.transaction),
      port.list(RECORD.fx),
      port.list(RECORD.settings),
    ]);

    const settings = settingsRecs.find((r) => r.recordId === SETTINGS_ID) || {};
    const reportingCurrency = settings.reportingCurrency || null;
    // Case-insensitive for portfolio.js's reason: "eur" and "EUR" are one
    // currency, and treating them as two invents a conversion.
    const reportingCcy = reportingCurrency ? String(reportingCurrency).toUpperCase() : null;
    const fxRates = createFxRates(fxRecs, issue);

    // Once per pair, not per transaction — an unfetched currency misses every
    // one of its days at once and the user's fix is one action. Same wording as
    // portfolio.js so the two engines report one gap, not two dialects of it;
    // duplicated rather than exported, since portfolio.js is not ours to change.
    const missingRates = new Set();
    const fxGap = (from, day, recordId) => {
      const pair = `${from}${reportingCcy}`;
      if (missingRates.has(pair)) return;
      missingRates.add(pair);
      issue('currency_not_converted', recordId,
        `no ${pair} rate applicable to ${day}; ${from} amounts are left out of the `
        + `${reportingCurrency} totals until one is stored`);
    };

    const txDays = txRecs.map((tx) => dayOf(tx.date)).filter((d) => DAY_RE.test(d)).sort();
    const rangeTo = to ?? txDays[txDays.length - 1] ?? null;
    const rangeFrom = from ?? txDays[0] ?? rangeTo;
    if (rangeFrom === null || rangeTo === null) {
      // No dated transactions and no explicit range: there is nothing to
      // measure and no window to measure it over.
      return {
        from: null, to: null, openDate: null, reportingCurrency: null,
        portfolio: null, securities: [], issues,
      };
    }
    dayMs(rangeFrom);
    dayMs(rangeTo);
    if (rangeFrom > rangeTo) throw new RangeError(`performance: from ${rangeFrom} is after to ${rangeTo}`);

    const openDate = addDays(rangeFrom, -1);

    // Sub-period boundaries: the opening valuation, the closing valuation, and
    // for every day in range that carries a transaction, both that day and the
    // day before it. Extra boundaries on days without flows are harmless —
    // consecutive factors telescope — so taking the union across all entities
    // and reusing it for each is exact as well as simpler.
    const boundaries = new Set([openDate, rangeTo]);
    for (const d of txDays) {
      if (d >= rangeFrom && d <= rangeTo) {
        boundaries.add(d);
        boundaries.add(addDays(d, -1));
      }
    }
    const dates = [...boundaries].sort();

    const portfolioFlows = new Map();       // date -> { in, out }
    const securityFlows = new Map();        // securityId -> Map(date -> { in, out })
    const bump = (map, date, dir, amount) => {
      let e = map.get(date);
      if (!e) map.set(date, (e = { in: 0, out: 0 }));
      e[dir] += amount;
    };
    const flowsFor = (securityId) => {
      let m = securityFlows.get(securityId);
      if (!m) securityFlows.set(securityId, (m = new Map()));
      return m;
    };

    for (const tx of txRecs) {
      const day = dayOf(tx.date);
      if (!DAY_RE.test(day)) {
        // portfolio.js has no date validation, so an undated record lands in
        // every snapshot including the opening one. Its value effect is
        // therefore counted, but it cannot be placed in time as a flow.
        issue('undated_transaction', tx.recordId, `transaction date ${JSON.stringify(tx.date)} is not a YYYY-MM-DD day`);
        continue;
      }
      if (day < rangeFrom || day > rangeTo) continue;
      // A non-integer amount is a §5 violation; portfolio.js books it as 0 and
      // raises non_integer_units, so this must agree or the two disagree on
      // what moved.
      const raw = Number.isSafeInteger(tx.amount) ? tx.amount : 0;
      if (raw === 0) continue;

      // A type neither map classifies can never become a flow here, so don't ask
      // for a rate on its behalf: portfolio.js rejects an unknown type BEFORE its
      // own FX lookup, and a gap raised here would be one it never raises —
      // sending the user to fetch a rate for a record that is ignored either way.
      // Own properties only, so a type of "toString" is not read off the
      // prototype as a classification. Found by codex review.
      // (`interest` is valid but internal to the portfolio boundary, so it is
      // skipped here too; portfolio.js still converts it for cash, and its gap
      // reaches this result through the merged snapshot issues below.)
      if (!Object.hasOwn(PORTFOLIO_FLOW, tx.type) && !Object.hasOwn(SECURITY_FLOW, tx.type)) continue;

      // THE RATE IS THE ONE FOR `day`, THE TRANSACTION'S OWN DATE — see the
      // header. `convert` on the same raw integer portfolio.js converts, so both
      // engines round once, identically, and agree to the cent.
      const txCcy = tx.currency ? String(tx.currency).toUpperCase() : null;
      let amount = raw;
      if (reportingCcy && txCcy && txCcy !== reportingCcy) {
        const applicable = fxRates.rate(txCcy, reportingCcy, day);
        if (!applicable) {
          // No rate, so no reporting-currency flow — unknown, not zero. Left out
          // of every flow total rather than netted against a valuation it shares
          // no unit with, which is what portfolio.js does to the cash leg.
          fxGap(txCcy, day, tx.recordId);
          continue;
        }
        amount = convert(raw, applicable.rate);
        if (amount === 0) continue;
      }
      // portfolio.js refuses a securities transfer outright — neither cash nor
      // shares move — so it is not a flow either.
      if ((tx.type === 'transfer_in' || tx.type === 'transfer_out') && tx.securityId) continue;

      const portfolioDir = PORTFOLIO_FLOW[tx.type];
      if (portfolioDir) bump(portfolioFlows, day, portfolioDir, amount);

      const securityDir = tx.securityId ? SECURITY_FLOW[tx.type] : undefined;
      if (!securityDir) continue;
      // A buy or sell whose share leg portfolio.js rejects moves cash but leaves
      // the position untouched, so no capital entered or left that position.
      if ((tx.type === 'buy' || tx.type === 'sell')
          && !(Number.isSafeInteger(tx.shares) && tx.shares > 0)) continue;
      bump(flowsFor(tx.securityId), day, securityDir, amount);
    }

    // ponytail: one full snapshot() per boundary date, each of which re-folds
    // the entire transaction log and price set — O(boundaries x records). Fine
    // for a personal portfolio (hundreds of transactions), not for tens of
    // thousands. Upgrade path is a streaming portfolio.js API that yields
    // positions at a sorted list of dates in one pass; it needs a change in
    // portfolio.js, so it is deliberately not done from here.
    const valuesByDate = new Map();
    let lastSnap = null;
    for (const d of dates) {
      const snap = await snapshot({ asOf: d });
      valuesByDate.set(d, valuesOf(snap));
      lastSnap = snap;
      for (const i of snap.issues) {
        if (!issues.some((seen) => seen.code === i.code && seen.recordId === i.recordId)) issues.push(i);
      }
    }

    const portfolioValueAt = (d) => valuesByDate.get(d).portfolio;
    const securityValueAt = (securityId) => (d) => {
      const v = valuesByDate.get(d).securities;
      // Absent from the snapshot means the security had not been traded yet.
      return v.has(securityId) ? v.get(securityId) : 0;
    };

    const openValues = valuesByDate.get(openDate);
    const closeValues = valuesByDate.get(rangeTo);

    const portfolio = {
      openValue: openValues.portfolio,
      closeValue: closeValues.portfolio,
      flowIn: [...portfolioFlows.values()].reduce((a, f) => a + f.in, 0),
      flowOut: [...portfolioFlows.values()].reduce((a, f) => a + f.out, 0),
      ttwror: chainLink(dates, portfolioValueAt, portfolioFlows),
      irr: irrOf(openDate, openValues.portfolio, rangeTo, closeValues.portfolio, portfolioFlows),
    };

    const securityIds = new Set([...securityFlows.keys()]);
    for (const v of valuesByDate.values()) for (const id of v.securities.keys()) securityIds.add(id);

    // Same aggregate valuesOf() reads, so two depots holding one security cannot
    // give the row a name from whichever position happened to fold last.
    const meta = new Map((lastSnap?.securities ?? []).map((s) => [s.securityId, s]));
    const securities = [];
    for (const securityId of securityIds) {
      const flows = securityFlows.get(securityId) || new Map();
      const openValue = securityValueAt(securityId)(openDate);
      const closeValue = securityValueAt(securityId)(rangeTo);
      // Held at neither end and untraded in between: nothing happened to it in
      // this range, so reporting a row for it is noise.
      if (openValue === 0 && closeValue === 0 && flows.size === 0) continue;
      const p = meta.get(securityId);
      securities.push({
        securityId,
        name: p?.name ?? null,
        ticker: p?.ticker ?? null,
        openValue,
        closeValue,
        flowIn: [...flows.values()].reduce((a, f) => a + f.in, 0),
        flowOut: [...flows.values()].reduce((a, f) => a + f.out, 0),
        ttwror: chainLink(dates, securityValueAt(securityId), flows),
        irr: irrOf(openDate, openValue, rangeTo, closeValue, flows),
      });
    }
    securities.sort((a, b) => String(a.name ?? a.securityId).localeCompare(String(b.name ?? b.securityId)));

    return {
      from: rangeFrom,
      to: rangeTo,
      openDate,
      reportingCurrency: lastSnap?.reportingCurrency ?? null,
      portfolio,
      securities,
      issues,
    };
  }

  return { performance };
}
