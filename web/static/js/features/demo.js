// Demo mode (bd myportfolio-cnd.1) — a deterministic fixture portfolio served
// from an in-memory records port, adopted at boot when the URL carries ?demo=1.
//
// WHY THIS IS THE WHOLE FEATURE. ARCHITECTURE.md §3 makes the records port the
// only seam the domain knows about, and store.js keeps the live implementation
// behind `useRecords`. So a demo is a third implementation of those three
// methods, swapped in before the first refresh(). Nothing in web/domain/ changes
// or notices, and — because boot.js never calls startSync() in this branch —
// no vault is opened, no LDK is read, and not one IndexedDB operation happens.
// Reset is a reload: the state lives in a Map that dies with the page.
//
// WHY IT LIVES UNDER web/static/js/features AND NOT web/domain. web/embed.go
// embeds web/domain per FILE and features.embed-domain.test.js pins that list
// against sw.js's PRECACHE. A fixture is shell data, not a pure engine over the
// port, and everything under web/static is already embedded by the directory
// //go:embed — so this file ships with no embed.go edit at all.
//
// EVERY DATE IS RELATIVE TO `today`. A demo with hardcoded 2021 dates reads as
// an abandoned product within a year; evergreen costs one date helper.
//
// MONEY IS §5 FIXED-POINT, with no exceptions for fixture data: amounts/fees/
// taxes 1e2, shares 1e8, prices 1e8. A euro amount written as 1234.56 is wrong
// by 100x on every screen at once, so features.demo.test.js asserts that every
// number in every returned record is an integer.

import { RECORD, SETTINGS_ID } from '../../../domain/schema.js';

// --- Accounts --------------------------------------------------------------
//
// §4: `accountId` is the CASH leg of every transaction; a buy/sell ALSO names
// `portfolioId`, the depot the shares land in. Both are written on every trade
// here — a trade naming only the cash account raises `missing_portfolio` and
// folds into an unattributed position, which would demo a bug.

const CASH = 'account_demo_cash';
const DEPOT_TR = 'account_demo_tr';
const DEPOT_IB = 'account_demo_ib';

const ACCOUNTS = [
    { id: CASH, name: 'Everyday cash', kind: 'cash' },
    { id: DEPOT_TR, name: 'Trade Republic', kind: 'securities' },
    { id: DEPOT_IB, name: 'Interactive Brokers', kind: 'securities' },
];

// --- Securities ------------------------------------------------------------
//
// Five, all EUR: multi-currency in the demo is a separate bead blocked on B8,
// and summing unlike units would raise `currency_not_converted` today.
//
// `waypoints` are hand-picked euro prices at year offsets 0..5 from the start of
// the range — the chart's story (a drawdown in year 2, a recovery, a crypto
// spike and crash). Daily closes are interpolated between them and jittered by a
// seeded LCG; see priceSeries(). A committed table of ~9k numbers would say the
// same thing in 300 KB.
//
// `assetClass` is set on all five because it is genuinely known for all five.
// §4: absent means unclassified and the UI says so, so a blank here would be a
// claim about the data, not caution.

const SECURITIES = [
    {
        id: 'security_demo_vwce',
        name: 'Vanguard FTSE All-World UCITS ETF (Acc)',
        isin: 'IE00BK5BQT80',
        ticker: 'VWCE',
        assetClass: 'etf',
        quote: { provider: 'twelvedata', symbol: 'VWCE' },
        waypoints: [95, 108, 92, 118, 136, 152],
        noise: 0.02,
    },
    {
        id: 'security_demo_aggh',
        name: 'iShares Core Global Aggregate Bond UCITS ETF',
        isin: 'IE00BDBRDM35',
        ticker: 'AGGH',
        assetClass: 'bond',
        quote: { provider: 'twelvedata', symbol: 'AGGH' },
        waypoints: [52, 50, 46, 49, 54, 57],
        noise: 0.008,
    },
    {
        id: 'security_demo_asml',
        name: 'ASML Holding N.V.',
        isin: 'NL0010273215',
        ticker: 'ASML',
        assetClass: 'stock',
        quote: { provider: 'twelvedata', symbol: 'ASML' },
        waypoints: [420, 520, 600, 640, 720, 880],
        noise: 0.03,
    },
    {
        id: 'security_demo_sap',
        name: 'SAP SE',
        isin: 'DE0007164600',
        ticker: 'SAP',
        assetClass: 'stock',
        quote: { provider: 'twelvedata', symbol: 'SAP' },
        waypoints: [90, 105, 118, 150, 176, 205],
        noise: 0.025,
    },
    {
        id: 'security_demo_btc',
        name: 'Bitcoin',
        ticker: 'BTC',
        assetClass: 'crypto',
        quote: { provider: 'coingecko', symbol: 'bitcoin' },
        waypoints: [22000, 38000, 16000, 42000, 61000, 88000],
        noise: 0.05,
    },
];

// --- Calendar --------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function dayMs(day) {
    const ms = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
    if (dayOf(ms) !== day) throw new RangeError(`demo: not a real calendar day: ${day}`);
    return ms;
}

// Shift by whole months, then days, all in UTC. The day-of-month is clamped to
// the target month's length, so `today` = 29 February still yields a real day
// five years earlier — Date.UTC would silently roll it forward to 1 March, and
// a fixture that only breaks one day in 1461 is worse than one that never works.
function shift(day, { months = 0, days = 0 } = {}) {
    const y = Number(day.slice(0, 4));
    const total = y * 12 + (Number(day.slice(5, 7)) - 1) + months;
    const ty = Math.floor(total / 12);
    const tm = total - ty * 12;
    const lastOfMonth = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    const dom = Math.min(Number(day.slice(8, 10)), lastOfMonth);
    return dayOf(Date.UTC(ty, tm, dom) + days * MS_PER_DAY);
}

// --- Money (§5) ------------------------------------------------------------

const EUR = (euros) => Math.round(euros * 100);        // amounts   1e2
const SHARES = (n) => Math.round(n * 1e8);             // shares    1e8
const PRICE = (euros) => Math.round(euros * 1e8);      // prices    1e8

// Gross cash for a trade, in 1e2 units, from 1e8 shares at a 1e8 price. The two
// scales are divided out before multiplying: shares x price is ~1e19 and would
// leave the safe-integer range, which is the arithmetic bug this whole
// fixed-point convention exists to make visible rather than silent.
const gross = (sharesUnits, closeUnits) => Math.round((sharesUnits / 1e8) * (closeUnits / 1e8) * 100);

// --- Prices ----------------------------------------------------------------

// A seeded LCG, so the same `today` in gives byte-identical records out.
// Math.random() would break that, and a per-security seed keeps one security's
// series from shifting when another's waypoints are edited.
function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function seedOf(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i += 1) {
        h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
    }
    return h;
}

/**
 * One security's closes for EVERY calendar day in [start, today], as a Map of
 * "YYYY-MM-DD" -> 1e8 integer. Every calendar day rather than weekdays only:
 * it costs nothing and removes every "what happens on a gap" question from
 * perf.js, which values at arbitrary sub-period boundaries.
 */
function priceSeries(security, start, today) {
    const anchors = security.waypoints.map((eur, i) => ({
        ms: dayMs(shift(start, { months: i * 12 })),
        units: PRICE(eur),
    }));
    // Force the last anchor onto `today`: shift() clamps a 29 February, so
    // start + 5y can land a day short and leave the tail uncovered.
    anchors[anchors.length - 1].ms = dayMs(today);

    const rnd = lcg(seedOf(security.id));
    const closes = new Map();
    const endMs = dayMs(today);
    let seg = 0;
    for (let ms = dayMs(start); ms <= endMs; ms += MS_PER_DAY) {
        while (seg < anchors.length - 2 && ms >= anchors[seg + 1].ms) seg += 1;
        const a = anchors[seg];
        const b = anchors[seg + 1];
        const t = b.ms === a.ms ? 0 : Math.min(1, (ms - a.ms) / (b.ms - a.ms));
        const trend = a.units + (b.units - a.units) * t;
        // Independent daily jitter, not a cumulative walk: a walk drifts away
        // from the hand-picked waypoints and loses the story they encode.
        closes.set(dayOf(ms), Math.round(trend * (1 + (rnd() - 0.5) * security.noise)));
    }
    return closes;
}

// --- The trade plan --------------------------------------------------------
//
// Offsets are months/days from `start` (= today - 5 years). What this has to
// exercise, and why each one is here rather than a flat three-trade line:
//
//   • the SAME ETF IN BOTH DEPOTS (VWCE at Trade Republic and at Interactive
//     Brokers) — positions are keyed by (accountId, securityId) with a
//     portfolio-wide aggregate on top, which is the most Portfolio-Performance-
//     like thing this app does and nothing else in the repo shows it;
//   • ONE FULLY CLOSED POSITION with a realized gain (SAP, bought at the start
//     and entirely sold at month 36) — realized gain is a headline number with
//     nothing to display it otherwise;
//   • NON-ZERO FEES AND TAXES on both sides — §4 pins that fees capitalise into
//     basis and taxes do not, and a fixture full of zeros stops testing the one
//     arithmetic rule most likely to regress;
//   • DEPOSITS SPREAD OVER TIME, which is the entire reason a money-weighted
//     (IRR) and a time-weighted (TTWROR) return differ at all.

const FEE_TR = EUR(1);
const FEE_IB = EUR(3.5);

const DEPOSITS = [
    { months: 0, amount: EUR(25000) },
    ...[6, 12, 18, 24, 30, 36, 42, 48, 54].map((months) => ({ months, amount: EUR(2000) })),
];

const BUYS = [
    { id: 'tx_demo_buy_vwce_1', at: { days: 2 }, security: 'security_demo_vwce', depot: DEPOT_TR, shares: SHARES(60), fees: FEE_TR, taxes: 0 },
    { id: 'tx_demo_buy_aggh_1', at: { days: 3 }, security: 'security_demo_aggh', depot: DEPOT_TR, shares: SHARES(80), fees: FEE_TR, taxes: 0 },
    { id: 'tx_demo_buy_sap_1', at: { days: 5 }, security: 'security_demo_sap', depot: DEPOT_IB, shares: SHARES(40), fees: FEE_IB, taxes: 0 },
    { id: 'tx_demo_buy_btc_1', at: { days: 7 }, security: 'security_demo_btc', depot: DEPOT_TR, shares: SHARES(0.15), fees: FEE_TR, taxes: 0 },
    { id: 'tx_demo_buy_vwce_2', at: { months: 12, days: 10 }, security: 'security_demo_vwce', depot: DEPOT_IB, shares: SHARES(25), fees: FEE_IB, taxes: 0 },
    // A financial-transaction tax on the buy side: §4 keeps it OUT of the cost
    // basis (cost += amount - taxes) while cash still moves by the full amount.
    { id: 'tx_demo_buy_asml_1', at: { months: 24, days: 15 }, security: 'security_demo_asml', depot: DEPOT_IB, shares: SHARES(8), fees: FEE_IB, taxes: EUR(12.5) },
    { id: 'tx_demo_buy_vwce_3', at: { months: 36, days: 20 }, security: 'security_demo_vwce', depot: DEPOT_TR, shares: SHARES(15), fees: FEE_TR, taxes: 0 },
    { id: 'tx_demo_buy_aggh_2', at: { months: 48, days: 5 }, security: 'security_demo_aggh', depot: DEPOT_TR, shares: SHARES(30), fees: FEE_TR, taxes: 0 },
    { id: 'tx_demo_buy_btc_2', at: { months: 54, days: 3 }, security: 'security_demo_btc', depot: DEPOT_TR, shares: SHARES(0.05), fees: FEE_TR, taxes: 0 },
    { id: 'tx_demo_buy_vwce_4', at: { months: 57 }, security: 'security_demo_vwce', depot: DEPOT_IB, shares: SHARES(10), fees: FEE_IB, taxes: 0 },
];

const SELLS = [
    // The full exit: 40 SAP bought around €90 leave around €150.
    { id: 'tx_demo_sell_sap_1', at: { months: 36 }, security: 'security_demo_sap', depot: DEPOT_IB, shares: SHARES(40), fees: FEE_IB, taxes: EUR(620) },
    { id: 'tx_demo_sell_vwce_1', at: { months: 51 }, security: 'security_demo_vwce', depot: DEPOT_TR, shares: SHARES(10), fees: FEE_TR, taxes: EUR(120) },
];

// `amount` is what actually lands in the account, i.e. net of withholding tax;
// `taxes` is the withholding. VWCE is accumulating and bitcoin pays nothing, so
// neither appears here — a distributing bond ETF and two dividend stocks do.
const DIVIDENDS = [
    ...[3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57].map((months) => ({
        id: `tx_demo_div_aggh_${months}`, at: { months }, security: 'security_demo_aggh', depot: DEPOT_TR,
        amount: EUR(26), taxes: EUR(9),
    })),
    ...[27, 33, 39, 45, 51, 57].map((months) => ({
        id: `tx_demo_div_asml_${months}`, at: { months }, security: 'security_demo_asml', depot: DEPOT_IB,
        amount: EUR(15), taxes: EUR(5),
    })),
    // Only while the position is open — it is fully sold at month 36.
    ...[6, 12, 18, 24, 30].map((months) => ({
        id: `tx_demo_div_sap_${months}`, at: { months }, security: 'security_demo_sap', depot: DEPOT_IB,
        amount: EUR(68), taxes: EUR(22),
    })),
];

// --- The seed --------------------------------------------------------------

/**
 * The fixture portfolio as a flat array of records in STORED shape (§3:
 * `{ recordId, recordType, clientTs, deleted: false, ...body }`).
 *
 * Pure — no `new Date()` without an argument, no window, no fetch. `today` is a
 * "YYYY-MM-DD" string the caller supplies, so the test can pin it and two calls
 * with the same `today` deep-equal.
 *
 * recordIds are stable literals. newRecordId() is deliberately NOT used: it
 * embeds Math.random() and would break that determinism. §4 forbids parsing or
 * ordering by a recordId, and nothing here does — only equality is used.
 */
export function demoRecords({ today }) {
    if (typeof today !== 'string' || !DAY_RE.test(today)) {
        throw new RangeError(`demo: today must be a YYYY-MM-DD day, got ${JSON.stringify(today)}`);
    }
    dayMs(today);
    const start = shift(today, { months: -60 });
    const day = (at) => shift(start, at);

    const series = new Map(SECURITIES.map((s) => [s.id, priceSeries(s, start, today)]));
    const closeOn = (securityId, d) => {
        const close = series.get(securityId).get(d);
        if (close === undefined) throw new RangeError(`demo: no generated close for ${securityId} on ${d}`);
        return close;
    };

    const bodies = [];
    const add = (recordType, recordId, body) => bodies.push({ recordType, recordId, body });

    add(RECORD.settings, SETTINGS_ID, { reportingCurrency: 'EUR', costBasisMethod: 'fifo' });

    for (const a of ACCOUNTS) {
        add(RECORD.account, a.id, { name: a.name, kind: a.kind, currency: 'EUR', closed: false });
    }

    for (const s of SECURITIES) {
        add(RECORD.security, s.id, {
            name: s.name, isin: s.isin, ticker: s.ticker, currency: 'EUR',
            assetClass: s.assetClass, quote: s.quote,
        });
    }

    DEPOSITS.forEach(({ months, amount }) => {
        add(RECORD.transaction, `tx_demo_deposit_${months}`, {
            type: 'deposit', accountId: CASH, date: day({ months }), amount, currency: 'EUR',
        });
    });

    for (const b of BUYS) {
        const d = day(b.at);
        // §4: `amount` is the cash that moved — gross + fees + taxes on a buy.
        const amount = gross(b.shares, closeOn(b.security, d)) + b.fees + b.taxes;
        add(RECORD.transaction, b.id, {
            type: 'buy', accountId: CASH, portfolioId: b.depot, securityId: b.security,
            date: d, shares: b.shares, amount, fees: b.fees, taxes: b.taxes, currency: 'EUR',
        });
    }

    for (const s of SELLS) {
        const d = day(s.at);
        // …and gross - fees - taxes on a sell, which is what arrived.
        const amount = gross(s.shares, closeOn(s.security, d)) - s.fees - s.taxes;
        add(RECORD.transaction, s.id, {
            type: 'sell', accountId: CASH, portfolioId: s.depot, securityId: s.security,
            date: d, shares: s.shares, amount, fees: s.fees, taxes: s.taxes, currency: 'EUR',
        });
    }

    for (const dv of DIVIDENDS) {
        add(RECORD.transaction, dv.id, {
            type: 'dividend', accountId: CASH, portfolioId: dv.depot, securityId: dv.security,
            date: day(dv.at), amount: dv.amount, fees: 0, taxes: dv.taxes, currency: 'EUR',
        });
    }

    // §4 "Price series storage": one record per security-year, MM-DD keys
    // zero-padded. Unpadded keys sort wrong ("2024-3-15" > "2024-12-31") and
    // lose the latest-close race, so they are sliced out of the ISO day rather
    // than rebuilt from numbers.
    for (const s of SECURITIES) {
        const byYear = new Map();
        for (const [d, close] of series.get(s.id)) {
            const year = d.slice(0, 4);
            if (!byYear.has(year)) byYear.set(year, {});
            byYear.get(year)[d.slice(5)] = close;
        }
        for (const [year, closes] of byYear) {
            add(RECORD.price, `price_${s.id}_${year}`, { securityId: s.id, year, closes });
        }
    }

    // clientTs is an index, not a clock: §3 treats it purely as a merge token
    // and demo records are never merged with anything, while a real clock here
    // would make two calls with the same `today` differ.
    return bodies.map(({ recordType, recordId, body }, i) => ({
        ...body, recordId, recordType, clientTs: i + 1, deleted: false,
    }));
}

// --- The port --------------------------------------------------------------

/**
 * The §3 records port over a Map, seeded with `seed`. Same three methods, same
 * field ownership (the port stamps recordId/recordType/clientTs/deleted, bodies
 * never carry them), same tombstone-instead-of-delete rule.
 *
 * Writes are accepted and visible, so a visitor can add a trade and watch the
 * numbers move — and it evaporates on reload, because this Map dies with the
 * page. `now` is injected for the same reason createLocalRecords injects it.
 */
export function createDemoRecords(seed, { now = Date.now } = {}) {
    const rows = new Map(seed.map((r) => [r.recordId, r]));
    return {
        async list(recordType) {
            return [...rows.values()].filter((r) => r.recordType === recordType && r.deleted !== true);
        },
        async put(recordType, recordId, body) {
            rows.set(recordId, { ...body, recordId, recordType, clientTs: now(), deleted: false });
        },
        async del(recordType, recordId) {
            rows.set(recordId, { recordId, recordType, clientTs: now(), deleted: true });
        },
    };
}
