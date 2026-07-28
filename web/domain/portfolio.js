// The portfolio engine: fold the transaction log into what you own and what it
// is worth. Pure logic over the ARCHITECTURE.md §3 records port — no window,
// document, fetch or indexedDB, and no live quote lookups. Valuation uses the
// stored `price` records only, so the engine works with the network unplugged.
//
// All arithmetic is on §5 fixed-point integers (amounts 1e2, shares 1e8,
// prices 1e8). Nothing here returns a currency amount as a fractional number.

import { RECORD, SETTINGS_ID } from './schema.js';
import { marketValue, proportion } from './money.js';

// --- Semantics -------------------------------------------------------------
//
// `amount` is the cash that moves, matching Portfolio Performance so an import
// round-trips: on a buy it is gross + fees + taxes (what left the account), on
// a sell it is gross - fees - taxes (what arrived).
//
// Fees and taxes then diverge, which is the whole point of tracking them apart:
//
//   fees  are a cost of acquiring/disposing the asset. They are capitalised into
//         the cost basis on a buy and deducted from proceeds on a sell, so they
//         reduce the gain.
//   taxes are an expense levied on the transaction, not part of what the asset
//         cost. They leave cash but never touch the basis, and are reported as
//         their own total.
//
// Hence, per security:  cost += amount - taxes      (buy)  == gross + fees
//                       proceeds = amount + taxes   (sell) == gross - fees
// while cash always moves by the full `amount`.
//
// Cost basis is moving-average (the bead's "average/moving" basis), matching
// PP's moving-average purchase price. FIFO lot tracking is deferred; it changes
// only the costRemoved computation below.
// ponytail: moving-average basis only. Jurisdictions that require FIFO/LIFO for
// realized gains need lot tracking — swap `proportion(...)` for a lot queue.

// Which way `amount` moves the account balance, for every §4 transaction type.
const CASH_SIGN = {
  buy: -1,
  sell: +1,
  dividend: +1,
  deposit: +1,
  removal: -1,
  interest: +1,
  fee: -1,
  tax: -1,
  transfer_in: +1,
  transfer_out: -1,
};

const dayOf = (date) => String(date ?? '').slice(0, 10);

function byDateThenId(a, b) {
  const da = dayOf(a.date);
  const dbb = dayOf(b.date);
  if (da !== dbb) return da < dbb ? -1 : 1;
  // Stable tiebreak so two same-day trades fold in a deterministic order.
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

export function createPortfolioDomain({ records }) {
  // snapshot folds the whole log into positions, account balances and totals.
  //   asOf — optional "YYYY-MM-DD"; transactions after it and prices after it
  //          are ignored, so the same call serves historical valuation.
  async function snapshot({ asOf } = {}) {
    const [accountRecs, securityRecs, txRecs, priceRecs, settingsRecs] = await Promise.all([
      records.list(RECORD.account),
      records.list(RECORD.security),
      records.list(RECORD.transaction),
      records.list(RECORD.price),
      records.list(RECORD.settings),
    ]);

    const issues = [];
    const issue = (code, recordId, message) => issues.push({ code, recordId, message });

    const settings = settingsRecs.find((r) => r.recordId === SETTINGS_ID) || {};
    const reportingCurrency = settings.reportingCurrency || null;

    const securities = new Map(securityRecs.map((s) => [s.recordId, s]));

    const accounts = new Map(accountRecs.map((a) => [a.recordId, {
      accountId: a.recordId,
      name: a.name ?? null,
      kind: a.kind ?? null,
      currency: a.currency ?? null,
      closed: a.closed === true,
      balance: 0,
    }]));

    const positions = new Map();
    const position = (securityId) => {
      let p = positions.get(securityId);
      if (!p) {
        const sec = securities.get(securityId);
        if (!sec) issue('unknown_security', securityId, `no security record ${securityId}`);
        p = {
          securityId,
          name: sec?.name ?? null,
          ticker: sec?.ticker ?? null,
          isin: sec?.isin ?? null,
          currency: sec?.currency ?? null,
          assetClass: sec?.assetClass ?? null,
          shares: 0,      // 1e8
          cost: 0,        // 1e2 — moving-average basis of the shares still held
          realized: 0,    // 1e2
          dividends: 0,   // 1e2
          fees: 0,        // 1e2
          taxes: 0,       // 1e2
        };
        positions.set(securityId, p);
      }
      return p;
    };

    // A fractional amount reaching the engine means a float leaked into a money
    // path upstream (§5). Surface it rather than rounding it away silently.
    const units = (tx, field) => {
      const v = tx[field];
      if (v === undefined || v === null) return 0;
      if (!Number.isSafeInteger(v)) {
        issue('non_integer_units', tx.recordId, `${field} is not a fixed-point integer: ${v}`);
        return 0;
      }
      return v;
    };

    const mixedCurrencies = new Set();

    for (const tx of txRecs.slice().sort(byDateThenId)) {
      if (asOf && dayOf(tx.date) > asOf) continue;

      const sign = CASH_SIGN[tx.type];
      if (sign === undefined) {
        issue('unknown_transaction_type', tx.recordId, `unknown transaction type ${tx.type}`);
        continue;
      }

      // Multi-currency conversion is B8. Until then a portfolio whose records are
      // not all in the reporting currency would be summing unlike units, so say
      // so instead of quietly adding dollars to euros. One issue per currency.
      if (reportingCurrency && tx.currency && tx.currency !== reportingCurrency
          && !mixedCurrencies.has(tx.currency)) {
        mixedCurrencies.add(tx.currency);
        issue('currency_not_converted', tx.recordId,
          `${tx.currency} amounts are summed as ${reportingCurrency} until FX conversion lands`);
      }

      const amount = units(tx, 'amount');
      const fees = units(tx, 'fees');
      const taxes = units(tx, 'taxes');

      // §4 gives transfer_in/transfer_out a cash body (accountId + counterAccountId).
      // A security leg would need a carried-over cost basis that the record shape
      // cannot express, so refuse to guess rather than mis-book the shares.
      if ((tx.type === 'transfer_in' || tx.type === 'transfer_out') && tx.securityId) {
        issue('security_transfer_unsupported', tx.recordId,
          'transfer of securities between accounts is not supported in v1; use it for cash only');
        continue;
      }

      // Cash. Every type moves its account by the full `amount`; transfers are one
      // record per leg (that is why §4 has both transfer_in and transfer_out), so
      // counterAccountId links the pair and is not booked here — booking it would
      // double-count against the paired record.
      const account = accounts.get(tx.accountId);
      if (!account) issue('unknown_account', tx.recordId, `no account record ${tx.accountId}`);
      else account.balance += sign * amount;

      if (tx.type === 'buy' || tx.type === 'sell') {
        if (!tx.securityId) {
          issue('missing_security', tx.recordId, `${tx.type} has no securityId`);
          continue;
        }
        const p = position(tx.securityId);
        const shares = units(tx, 'shares');
        if (shares <= 0) issue('non_positive_shares', tx.recordId, `${tx.type} has shares ${shares}`);

        if (tx.type === 'buy') {
          p.shares += shares;
          p.cost += amount - taxes; // gross + fees
        } else {
          const proceeds = amount + taxes; // gross - fees
          let costRemoved;
          if (p.shares <= 0) {
            // Selling shares we have no record of buying. Surfaced, not clamped:
            // the shares go negative so the books stay self-consistent and the
            // error is visible in the position, not hidden by a floor.
            issue('oversell', tx.recordId,
              `sell of ${shares} with ${p.shares} held for ${tx.securityId}`);
            costRemoved = 0;
          } else if (shares > p.shares) {
            issue('oversell', tx.recordId,
              `sell of ${shares} exceeds ${p.shares} held for ${tx.securityId}`);
            costRemoved = p.cost;
          } else {
            // Moving average. proportion(cost, shares, held) === cost when the
            // whole position goes, so a full exit leaves no rounding dust.
            costRemoved = proportion(p.cost, shares, p.shares);
          }
          p.shares -= shares;
          p.cost -= costRemoved;
          p.realized += proceeds - costRemoved;
        }
        p.fees += fees;
        p.taxes += taxes;
        continue;
      }

      if (tx.type === 'dividend') {
        // Cash and income only. A dividend never touches the cost basis — the
        // shares cost what they cost.
        if (!tx.securityId) {
          issue('missing_security', tx.recordId, 'dividend has no securityId');
          continue;
        }
        const p = position(tx.securityId);
        p.dividends += amount;
        p.fees += fees;
        p.taxes += taxes;
        continue;
      }

      // Standalone fee/tax records: the whole `amount` is the fee or the tax.
      // Attributed to a security when one is named, so a custody fee on a holding
      // shows up against it, but never capitalised into the basis.
      if (tx.type === 'fee' || tx.type === 'tax') {
        const p = tx.securityId ? position(tx.securityId) : null;
        if (p) p[tx.type === 'fee' ? 'fees' : 'taxes'] += amount;
        continue;
      }

      // deposit / removal / interest / transfer_*: cash only, already applied.
      // Any fees or taxes broken out on them are still reported.
      if (tx.securityId) {
        const p = position(tx.securityId);
        p.fees += fees;
        p.taxes += taxes;
      }
    }

    const quotes = latestCloses(priceRecs, asOf, issue);

    for (const p of positions.values()) {
      const quote = quotes.get(p.securityId);
      if (!quote) {
        if (p.shares !== 0) {
          issue('no_price', p.securityId, `no price record for ${p.securityId}${asOf ? ` on or before ${asOf}` : ''}`);
        }
        p.price = null;
        p.priceDate = null;
        p.marketValue = null;
        p.unrealized = null;
        continue;
      }
      p.price = quote.close;
      p.priceDate = quote.date;
      p.marketValue = marketValue(p.shares, quote.close);
      p.unrealized = p.marketValue - p.cost;
    }

    const positionList = [...positions.values()]
      .sort((a, b) => String(a.name ?? a.securityId).localeCompare(String(b.name ?? b.securityId)));
    const accountList = [...accounts.values()]
      .sort((a, b) => String(a.name ?? a.accountId).localeCompare(String(b.name ?? b.accountId)));

    const sum = (list, key) => list.reduce((acc, x) => acc + (x[key] ?? 0), 0);
    const cash = sum(accountList, 'balance');
    const value = sum(positionList, 'marketValue');

    return {
      asOf: asOf ?? null,
      reportingCurrency,
      positions: positionList,
      accounts: accountList,
      issues,
      totals: {
        cash,
        marketValue: value,
        // Excludes unpriced positions, whose unrealized is null and which are
        // called out by a `no_price` issue — so this is not marketValue - cost.
        cost: sum(positionList, 'cost'),
        unrealized: sum(positionList, 'unrealized'),
        realized: sum(positionList, 'realized'),
        dividends: sum(positionList, 'dividends'),
        fees: sum(positionList, 'fees'),
        taxes: sum(positionList, 'taxes'),
        total: cash + value,
      },
    };
  }

  return { snapshot };
}

// §4 "Price series storage": one `price` record per security-year, body
// { securityId, year, closes: { "MM-DD": close } }, close at 1e8. Returns the
// newest close per security on or before `asOf`.
function latestCloses(priceRecs, asOf, issue) {
  const best = new Map();
  for (const rec of priceRecs) {
    // A missing year would build "undefined-03-15", which sorts above every real
    // date and would then win the latest-close race for that security.
    if (!rec.closes || typeof rec.closes !== 'object' || !/^\d{4}$/.test(String(rec.year))) {
      issue('price_not_chunked', rec.recordId,
        'price record needs a 4-digit `year` and a `closes` map; §4 stores prices chunked per security-year');
      continue;
    }
    for (const [monthDay, close] of Object.entries(rec.closes)) {
      if (!Number.isSafeInteger(close)) {
        issue('non_integer_units', rec.recordId, `close ${rec.year}-${monthDay} is not a fixed-point integer: ${close}`);
        continue;
      }
      const date = `${rec.year}-${monthDay}`;
      if (asOf && date > asOf) continue;
      const current = best.get(rec.securityId);
      if (!current || date > current.date) best.set(rec.securityId, { date, close });
    }
  }
  return best;
}
