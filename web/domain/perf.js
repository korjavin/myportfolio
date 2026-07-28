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

import { RECORD } from './schema.js';
import { createPortfolioDomain } from './portfolio.js';

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
function valuesOf(snap) {
  const securities = new Map();
  let total = snap.totals.cash;
  let known = true;
  for (const p of snap.positions) {
    const v = p.marketValue === null ? (p.shares === 0 ? 0 : null) : p.marketValue;
    securities.set(p.securityId, v);
    if (v === null) known = false;
    else total += v;
  }
  return { portfolio: known ? total : null, securities };
}

const NO_FLOW = { in: 0, out: 0 };

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
    const flow = flowsByDate.get(dates[i]) || NO_FLOW;
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
  for (const [date, flow] of flowsByDate) {
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
    const txRecs = await port.list(RECORD.transaction);

    const issues = [];
    const issue = (code, recordId, message) => issues.push({ code, recordId, message });

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
      const amount = Number.isSafeInteger(tx.amount) ? tx.amount : 0;
      if (amount === 0) continue;
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

    const meta = new Map((lastSnap?.positions ?? []).map((p) => [p.securityId, p]));
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
