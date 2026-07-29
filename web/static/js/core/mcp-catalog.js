// The read-only operation catalog the AI connector answers from
// (ARCHITECTURE.md §11, bd myportfolio-ybp.4).
//
// HAND-WRITTEN AND SHORT, deliberately. The sibling generates 2691 lines from a
// 106-operation Go registry (cmd/genmcpcatalog); our whole domain surface is six
// small modules in web/domain/, so porting the generator would be building a
// machine to write ten lines. The drift test in core/tests/mcp-catalog.test.mjs
// is what keeps this list honest instead: it builds every domain named in a
// `source` below and fails here — not at the agent — if the export vanished.
//
// v1 IS READ-ONLY, and that is structural rather than a convention: createRunner
// hands the domain factories a port with ONLY `list` on it, so no operation in
// this file can reach `put` or `del` even by accident. A write path is a separate
// bead with its own consent surface — "the model misread the units and booked a
// sell" is not a failure mode worth shipping to be first.
//
// ---------------------------------------------------------------------------
// HOW MONEY IS PRESENTED. Decided once, here, and repeated in the operation
// descriptions because the description is the only part a model reads.
// ---------------------------------------------------------------------------
//
// Everything in web/domain/ is §5 fixed-point: an amount of €1234.56 is the
// integer 123456, a price is scaled 1e8, a share count is scaled 1e8. A model
// shown `123456` with no scale will tell the user they hold 123,456 euros, and
// it will do it confidently. So every money-ish field crosses this boundary as
// TWO fields:
//
//     "marketValue": "1234.56"      <- AUTHORITATIVE. Exact decimal, as a string.
//     "marketValueUnits": 123456    <- the same value as a §5 scaled integer.
//
// The plain name carries the human number, so a model that reads nothing but the
// field name is right rather than wrong by four orders of magnitude. The `Units`
// suffix carries the integer for anything that needs exact arithmetic. The
// string is produced by money.js formatFixed, which is exact — it is not a
// float, and nothing here ever calls toFloat.

import { RECORD } from '../../../domain/schema.js';
import { DECIMALS, formatFixed } from '../../../domain/money.js';
import { createPortfolioDomain } from '../../../domain/portfolio.js';
import { createPerformanceDomain } from '../../../domain/perf.js';
import { createPricesDomain } from '../../../domain/prices.js';

// --- The money boundary -----------------------------------------------------

// Field name -> §5 scale. A Map rather than an object literal so a field called
// "constructor" or "toString" misses instead of resolving an inherited member.
//
// Adding a field to a domain module's output without adding it here ships a bare
// integer to a model. mcp-catalog.test.mjs walks every operation's real output
// and fails on any number whose key is neither listed here nor in its own
// explicit not-money list, which is what makes that omission loud.
const MONEY_DECIMALS = new Map([
    // Currency amounts, scale 1e2.
    ['amount', DECIMALS.amount],
    ['cost', DECIMALS.amount],
    ['realized', DECIMALS.amount],
    ['dividends', DECIMALS.amount],
    ['fees', DECIMALS.amount],
    ['taxes', DECIMALS.amount],
    ['marketValue', DECIMALS.amount],
    ['unrealized', DECIMALS.amount],
    ['balance', DECIMALS.amount],
    ['cash', DECIMALS.amount],
    ['total', DECIMALS.amount],
    ['openValue', DECIMALS.amount],
    ['closeValue', DECIMALS.amount],
    ['flowIn', DECIMALS.amount],
    ['flowOut', DECIMALS.amount],
    // Share counts, scale 1e8.
    ['shares', DECIMALS.shares],
    // Prices, scale 1e8.
    ['price', DECIMALS.price],
    ['close', DECIMALS.price],
]);

/**
 * Rewrite every §5 integer in a result tree into the two-field form described in
 * the header. Recursive, keyed by field NAME — a return ratio called `value`
 * inside `{ok, value}` is not money and is left alone, which is the whole reason
 * this is a name table and not "every integer".
 */
export function presentMoney(value) {
    if (Array.isArray(value)) return value.map(presentMoney);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        const decimals = MONEY_DECIMALS.get(key);
        if (decimals === undefined) {
            out[key] = presentMoney(raw);
            continue;
        }
        // A null money field means "not computable" (an unpriced position, an
        // unconvertible currency) and is NOT zero — portfolio.js is careful about
        // that distinction and flattening it here would throw it away.
        if (raw === null || raw === undefined) {
            out[key] = null;
            out[`${key}Units`] = null;
            continue;
        }
        // A non-integer reaching here is a §5 violation upstream; pass it through
        // untouched rather than crashing the whole answer, and let the snapshot's
        // own `non_integer_units` issue (portfolio.issues) explain it.
        if (!Number.isSafeInteger(raw)) {
            out[key] = raw;
            continue;
        }
        out[key] = formatFixed(raw, decimals);
        out[`${key}Units`] = raw;
    }
    return out;
}

// --- Shared wording ---------------------------------------------------------

// Repeated verbatim in every operation that returns reporting-currency money.
// The model reads descriptions, not this file's header.
const MONEY_NOTE = 'Money: each amount appears twice — the plain field is the '
    + 'AUTHORITATIVE exact decimal string (e.g. "1234.56"), and <field>Units is the '
    + 'same value as a fixed-point integer (amounts x100, shares x1e8, prices x1e8). '
    + 'Never read a *Units number as a plain amount. null means "not computable" '
    + '(unpriced holding, missing FX rate), which is not the same as zero — see '
    + 'portfolio.issues.';

const REPORTING_NOTE = 'Amounts are in the portfolio\'s reporting currency '
    + '(reportingCurrency); a position\'s `price` and `currency` stay in the '
    + 'security\'s own currency, because a price is a market fact about the security.';

const AS_OF = 'optional "YYYY-MM-DD" — value the portfolio as of that day instead of today. '
    + 'Transactions and prices after it are ignored.';

// --- The operations ---------------------------------------------------------
//
// `source` is what the drift test pins: the domain module, its factory export,
// and the method this operation calls. An operation whose function disappears
// fails there rather than at the agent.
//
// ponytail: operations 1-5 each run one full portfolio.snapshot(), which folds
// the whole transaction log. A model asking three questions folds it three
// times. Fine for a personal portfolio (hundreds of records) and the same cost
// store.refresh() already pays per write; if it ever matters, memoise per frame.

const PORTFOLIO_SOURCE = { module: 'portfolio.js', factory: 'createPortfolioDomain', method: 'snapshot' };

export const CATALOG = [
    {
        id: 'portfolio.summary',
        topic: 'portfolio',
        description: 'The whole portfolio in one small answer: reporting currency, cost-basis '
            + 'method, total value (cash + holdings), cost, unrealized and realized gain, '
            + 'dividends, fees, taxes, and how many holdings/accounts/data issues there are. '
            + 'START HERE — it is the cheapest call and tells you what to ask next. '
            + MONEY_NOTE + ' ' + REPORTING_NOTE,
        params: { asOf: AS_OF },
        source: PORTFOLIO_SOURCE,
        async run({ asOf }, d) {
            const snap = await d.portfolio.snapshot({ asOf: day(asOf) });
            return {
                asOf: snap.asOf,
                reportingCurrency: snap.reportingCurrency,
                costBasisMethod: snap.costBasisMethod,
                totals: snap.totals,
                positionCount: snap.positions.length,
                securityCount: snap.securities.length,
                accountCount: snap.accounts.length,
                issueCount: snap.issues.length,
            };
        },
    },
    {
        id: 'portfolio.holdings',
        topic: 'portfolio',
        description: 'Every open and closed position, one row per (securities account, security) '
            + 'pair — the same ETF held at two brokers is two rows. Carries shares, cost basis, '
            + 'latest stored close and its date, market value, unrealized and realized gain, '
            + 'dividends, fees and taxes. Use portfolio.securities for the portfolio-wide '
            + 'aggregate per security instead. ' + MONEY_NOTE + ' ' + REPORTING_NOTE,
        params: { asOf: AS_OF },
        source: PORTFOLIO_SOURCE,
        async run({ asOf }, d) {
            const snap = await d.portfolio.snapshot({ asOf: day(asOf) });
            return {
                asOf: snap.asOf,
                reportingCurrency: snap.reportingCurrency,
                // `lots` is dropped: it is an internal acquisition queue, it is the
                // largest field in a position, and no question a model asks is
                // answered by it that cost + shares does not answer better.
                positions: snap.positions.map(({ lots, ...p }) => p),
                totals: snap.totals,
            };
        },
    },
    {
        id: 'portfolio.securities',
        topic: 'portfolio',
        description: 'One row per security held across the whole portfolio, with the brokers '
            + '(accountIds) it is held at. This is where securityId comes from for '
            + 'prices.series and for filtering transactions.list. ' + MONEY_NOTE + ' ' + REPORTING_NOTE,
        params: { asOf: AS_OF },
        source: PORTFOLIO_SOURCE,
        async run({ asOf }, d) {
            const snap = await d.portfolio.snapshot({ asOf: day(asOf) });
            return { asOf: snap.asOf, reportingCurrency: snap.reportingCurrency, securities: snap.securities };
        },
    },
    {
        id: 'portfolio.accounts',
        topic: 'portfolio',
        description: 'Cash and securities accounts with their computed balances. A balance is '
            + 'derived from the transaction log, not stored. ' + MONEY_NOTE + ' ' + REPORTING_NOTE,
        params: { asOf: AS_OF },
        source: PORTFOLIO_SOURCE,
        async run({ asOf }, d) {
            const snap = await d.portfolio.snapshot({ asOf: day(asOf) });
            return {
                asOf: snap.asOf,
                reportingCurrency: snap.reportingCurrency,
                accounts: snap.accounts,
                cash: snap.totals.cash,
            };
        },
    },
    {
        id: 'portfolio.issues',
        topic: 'portfolio',
        description: 'Everything the portfolio engine could NOT compute, and why: '
            + 'currency_not_converted (no FX rate, so those amounts are left out of the totals '
            + 'entirely), no_price (a holding with no stored close, so its market value is null), '
            + 'missing_portfolio (a trade that names no securities account), undated_transaction, '
            + 'oversell, unknown_security, non_integer_units. READ THIS BEFORE ADVISING: a total '
            + 'with an unconverted currency behind it is not the portfolio\'s value, and the user '
            + 'cannot tell from the number alone.',
        params: { asOf: AS_OF },
        source: PORTFOLIO_SOURCE,
        async run({ asOf }, d) {
            const snap = await d.portfolio.snapshot({ asOf: day(asOf) });
            return { asOf: snap.asOf, issues: snap.issues, issueCount: snap.issues.length };
        },
    },
    {
        id: 'performance.summary',
        topic: 'performance',
        description: 'TTWROR (true time-weighted return) and IRR (money-weighted, '
            + 'spreadsheet-XIRR-compatible) over an inclusive date range, for the whole portfolio '
            + 'and per security. Both rates are returned as {ok: true, value} where value is a '
            + 'FRACTION, not a percent: 0.0734 means 7.34%. A rate that is not defined comes back '
            + 'as {ok: false, reason} — for example no_capital, incomplete_valuation, '
            + 'multiple_roots — and must be reported as undefined, never as zero. openValue, '
            + 'closeValue, flowIn and flowOut are money. ' + MONEY_NOTE,
        params: {
            from: 'optional "YYYY-MM-DD" start of the range, inclusive. Defaults to the first transaction.',
            to: 'optional "YYYY-MM-DD" end of the range, inclusive. Defaults to the last transaction.',
        },
        source: { module: 'perf.js', factory: 'createPerformanceDomain', method: 'performance' },
        run({ from, to }, d) {
            return d.performance.performance({ from: day(from), to: day(to) });
        },
    },
    {
        id: 'prices.series',
        topic: 'prices',
        description: 'One security\'s stored daily closes, oldest first. These are the closes the '
            + 'portfolio is valued from — there is no live quote here and nothing is fetched. '
            + 'Get securityId from portfolio.securities. Each close is in the security\'s own '
            + 'currency. ' + MONEY_NOTE,
        params: {
            securityId: 'REQUIRED — the security\'s id, from portfolio.securities.',
            from: 'optional "YYYY-MM-DD" lower bound, inclusive.',
            to: 'optional "YYYY-MM-DD" upper bound, inclusive.',
            limit: 'optional max number of points to return, newest kept. Default 500.',
        },
        source: { module: 'prices.js', factory: 'createPricesDomain', method: 'series' },
        async run({ securityId, from, to, limit }, d) {
            if (!securityId) throw new RangeError('prices.series needs a securityId — get one from portfolio.securities');
            const all = await d.prices.series(String(securityId), { from: day(from), to: day(to) });
            const max = capped(limit, 500);
            // Newest kept, because "what has it done lately" is the question a
            // truncated series is asked; the dropped count says so explicitly
            // rather than letting a model read a clipped history as the whole one.
            const points = all.length > max ? all.slice(all.length - max) : all;
            return {
                securityId: String(securityId),
                count: points.length,
                omitted: all.length - points.length,
                points,
            };
        },
    },
    {
        id: 'transactions.list',
        topic: 'transactions',
        description: 'The raw transaction log, newest first, filterable. IMPORTANT: a '
            + 'transaction\'s amount, fees and taxes are in the TRANSACTION\'S OWN currency '
            + '(the `currency` field), not in the reporting currency — unlike every other '
            + 'operation here. `amount` is the cash that moved: on a buy it is gross + fees + '
            + 'taxes, on a sell it is gross - fees - taxes. `accountId` is always the cash leg; '
            + '`portfolioId` is the securities account a buy/sell\'s shares land in. ' + MONEY_NOTE,
        params: {
            from: 'optional "YYYY-MM-DD" lower bound on date, inclusive.',
            to: 'optional "YYYY-MM-DD" upper bound on date, inclusive.',
            type: 'optional transaction type: buy, sell, dividend, deposit, removal, interest, fee, tax, transfer_in, transfer_out.',
            securityId: 'optional — only transactions naming this security.',
            accountId: 'optional — only transactions whose cash leg is this account.',
            limit: 'optional max rows, newest first. Default 200.',
        },
        source: { module: 'schema.js', factory: null, method: null, records: 'transaction' },
        async run({ from, to, type, securityId, accountId, limit }, d) {
            const rows = await d.records.list(RECORD.transaction);
            const matched = rows
                .filter((r) => {
                    const date = String(r.date ?? '').slice(0, 10);
                    if (from && date < day(from)) return false;
                    if (to && date > day(to)) return false;
                    if (type && r.type !== type) return false;
                    if (securityId && r.securityId !== securityId) return false;
                    if (accountId && r.accountId !== accountId) return false;
                    return true;
                })
                .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
            const max = capped(limit, 200);
            return {
                count: Math.min(matched.length, max),
                matched: matched.length,
                omitted: Math.max(0, matched.length - max),
                transactions: matched.slice(0, max).map((r) => ({
                    id: r.recordId,
                    date: r.date ?? null,
                    type: r.type ?? null,
                    accountId: r.accountId ?? null,
                    portfolioId: r.portfolioId ?? null,
                    securityId: r.securityId ?? null,
                    currency: r.currency ?? null,
                    shares: r.shares ?? null,
                    amount: r.amount ?? null,
                    fees: r.fees ?? null,
                    taxes: r.taxes ?? null,
                    note: r.note ?? null,
                })),
            };
        },
    },
];

// --- Runner -----------------------------------------------------------------

const day = (v) => (v == null || v === '' ? undefined : String(v));

// A limit a model passes as "50" (a string, which agents do constantly) has to
// work; a limit of 0, -1 or "lots" falls back to the default rather than
// returning an empty answer the model reads as "you own nothing".
function capped(limit, fallback) {
    const n = Number(limit);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

const BY_ID = new Map(CATALOG.map((op) => [op.id, op]));

/** The catalog entry for an id, or undefined. Prototype-free lookup by Map. */
export const operation = (id) => BY_ID.get(String(id ?? ''));

/** Sorted list of the topics mcp_help can filter on. */
export const TOPICS = [...new Set(CATALOG.map((op) => op.topic))].sort();

/**
 * Bind the catalog to a records port.
 *
 * THE PORT IS NARROWED TO `list` HERE, and that is the read-only guarantee: the
 * domain engines below never see `put` or `del`, so no operation in this file can
 * write even if someone adds one that tries. It is structural rather than a rule
 * in a comment, which is why mcp-catalog.test.mjs can prove it by running every
 * operation against a port whose put/del throw.
 */
export function createRunner({ records }) {
    const readOnly = { list: (recordType) => records.list(recordType) };
    const domains = {
        records: readOnly,
        portfolio: createPortfolioDomain({ records: readOnly }),
        performance: createPerformanceDomain({ records: readOnly }),
        prices: createPricesDomain({ records: readOnly }),
    };
    return async function run(opId, params) {
        const op = operation(opId);
        if (!op) throw new RangeError(`unknown operation "${opId}"`);
        return presentMoney(await op.run(params || {}, domains));
    };
}
