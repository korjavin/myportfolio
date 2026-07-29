// The portfolio engine: fold the transaction log into what you own and what it
// is worth. Pure logic over the ARCHITECTURE.md §3 records port — no window,
// document, fetch or indexedDB, and no live quote lookups. Valuation uses the
// stored `price` records only, so the engine works with the network unplugged.
//
// All arithmetic is on §5 fixed-point integers (amounts 1e2, shares 1e8,
// prices 1e8). Nothing here returns a currency amount as a fractional number.

import { RECORD, SETTINGS_ID, COST_BASIS_METHODS } from './schema.js';
import { marketValue, proportion, convert } from './money.js';
import { createFxRates, isCalendarDay } from './fx.js';

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
// A POSITION IS KEYED BY (accountId, securityId) — §4. The securities account is
// modelled, so the same ETF held at two brokers is two positions with a
// portfolio-wide aggregate on top (`snapshot().securities`). Because §4's
// `accountId` is the *cash* leg, a buy/sell names both accounts: `accountId` for
// the money and `portfolioId` for where the shares land, and it is the latter
// that keys the position. A trade that names only the cash account cannot be
// attributed to a securities account, so it is surfaced (`missing_portfolio`)
// and folded into an unattributed position rather than guessed onto one.
//
// Position identity is OPAQUE to callers: nothing outside this module may
// rebuild a position key from a securityId, because a securityId no longer
// identifies one position.
//
// MULTI-CURRENCY. Every money field on a position, an account and the totals is
// in `settings.reportingCurrency`. Two different rates get it there, and mixing
// them up is the classic bug in this feature:
//
//   transaction amounts (cost, realized, dividends, fees, taxes, cash) convert
//     at the rate for THE TRANSACTION'S OWN DAY. A 2019 purchase cost what it
//     cost; converting it at today's rate rewrites the portfolio's history
//     every time the market moves, and does it invisibly.
//   market value converts at the rate for the CLOSE'S day, because that is the
//     valuation date — what the holding is worth now, at the rate now.
//
// So `unrealized` is market value at the valuation rate less basis at the
// historical rates: it includes the currency effect, which is what a
// reporting-currency gain means and what Portfolio Performance reports.
//
// `position.price` and `position.currency` stay in the SECURITY's own currency:
// a price is a market fact about the security, not a portfolio amount, and the
// price a user types into the holdings screen is the one their broker shows.
//
// A missing rate is an explicit gap, never a guess. The transaction is left out
// of the fold entirely and `currency_not_converted` names the pair and day —
// the same treatment as an undated record, and for the same reason: an amount
// in a currency with no known rate has no reporting-currency value, and neither
// zero nor the unconverted number is that value. See fx.js for what a rate is
// applicable to (weekends and holidays included).
//
// LOTS ARE TRACKED ALWAYS. Each buy opens a lot (shares, cost, acquisition day)
// and each sell consumes them oldest-first, whatever `settings.costBasisMethod`
// says — the method (`fifo` | `moving_average`, default `fifo`) chooses only how
// realized gain is *reported*. Tracking unconditionally is what makes the two
// views agree, and it is not reversible: lots cannot be recovered from a
// moving-average fold after the fact. FIFO is the default because it is what
// most EU tax authorities require for declaring capital gains, and a merely
// indicative number is the wrong default in a filing context.

// Which way `amount` moves the account balance, for every §4 transaction type.
// Exported because it is the single definition of "which way does this type move
// cash": ppimport.js reads it to check PP's own sign against ours. A second copy
// drifts into the importer booking the opposite sign from the engine.
export const CASH_SIGN = {
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

// `isCalendarDay` is imported from fx.js — the third caller the old ponytail
// note here said to fold on. Same rule perf.js's dayMs() enforces: a string
// that is not a real UTC calendar day is rejected, never rolled forward.
// Date.UTC(2024, 1, 30) quietly becomes March 1, so round-tripping the string is
// what catches it. An undated record used to slice to '' — sorting before every
// real date and landing in EVERY snapshot including the opening valuation —
// which made the portfolio wrong everywhere at once with nothing looking broken.
// ponytail: perf.js still carries its own copy; fold it onto fx.js's next time
// that file is open.

// Consume `shares` oldest-first out of `lots`, returning the cost that left with
// them. Partial consumption uses proportion(), which rounds once, so what leaves
// and what stays still add up to the lot's cost exactly — and emptying the queue
// removes every cent of basis, leaving no dust behind a closed position.
function consumeLots(lots, shares) {
  let want = shares;
  let cost = 0;
  while (want > 0 && lots.length > 0) {
    const lot = lots[0];
    if (lot.shares <= want) {
      cost += lot.cost;
      want -= lot.shares;
      lots.shift();
    } else {
      const take = proportion(lot.cost, want, lot.shares);
      cost += take;
      lot.cost -= take;
      lot.shares -= want;
      want = 0;
    }
  }
  return cost;
}

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
    const [accountRecs, securityRecs, txRecs, priceRecs, fxRecs, settingsRecs] = await Promise.all([
      records.list(RECORD.account),
      records.list(RECORD.security),
      records.list(RECORD.transaction),
      records.list(RECORD.price),
      records.list(RECORD.fx),
      records.list(RECORD.settings),
    ]);

    const issues = [];
    const issue = (code, recordId, message) => issues.push({ code, recordId, message });

    const settings = settingsRecs.find((r) => r.recordId === SETTINGS_ID) || {};
    const reportingCurrency = settings.reportingCurrency || null;
    // Compared case-insensitively: "eur" and "EUR" are the same currency, and
    // treating them as two is a mixed-currency portfolio that is not one. The
    // value returned to the caller stays exactly as the user stored it.
    const reportingCcy = reportingCurrency ? String(reportingCurrency).toUpperCase() : null;

    const fxRates = createFxRates(fxRecs, issue);
    // A gap is reported once per pair, not once per transaction: an unfetched
    // currency misses hundreds of days at once and the user's fix is the same
    // single action for all of them. The named day is the first one that hit it.
    const missingRates = new Set();
    const fxGap = (from, day, recordId) => {
      const pair = `${from}${reportingCcy}`;
      if (missingRates.has(pair)) return;
      missingRates.add(pair);
      issue('currency_not_converted', recordId,
        `no ${pair} rate applicable to ${day}; ${from} amounts are left out of the `
        + `${reportingCurrency} totals until one is stored`);
    };

    // §4: the method chooses only how realized gain is reported. An unknown one
    // is surfaced rather than silently read as the default, because the two
    // methods give different gain numbers on the same records.
    let costBasisMethod = settings.costBasisMethod ?? COST_BASIS_METHODS[0];
    if (!COST_BASIS_METHODS.includes(costBasisMethod)) {
      issue('unknown_cost_basis_method', SETTINGS_ID,
        `costBasisMethod ${JSON.stringify(settings.costBasisMethod)} is not one of ${COST_BASIS_METHODS.join(', ')}; reporting ${COST_BASIS_METHODS[0]}`);
      costBasisMethod = COST_BASIS_METHODS[0];
    }

    const securities = new Map(securityRecs.map((s) => [s.recordId, s]));

    const accounts = new Map(accountRecs.map((a) => [a.recordId, {
      accountId: a.recordId,
      name: a.name ?? null,
      kind: a.kind ?? null,
      currency: a.currency ?? null,
      closed: a.closed === true,
      balance: 0,
    }]));

    // Keyed by (accountId, securityId), where accountId is the SECURITIES
    // account the shares live in (a transaction's `portfolioId`) and null means
    // "no securities account was named". The key is built here and nowhere else;
    // callers read `positions` as a list.
    const positions = new Map();
    // NUL separates the two ids because both are opaque strings (§4): any
    // printable separator could occur inside one, and then "a|b" + "c" and "a" +
    // "b|c" would collide into a single holding.
    const positionKey = (accountId, securityId) => `${accountId ?? ''}\u0000${securityId}`;
    const position = (accountId, securityId) => {
      const key = positionKey(accountId, securityId);
      let p = positions.get(key);
      if (!p) {
        const sec = securities.get(securityId);
        if (!sec) issue('unknown_security', securityId, `no security record ${securityId}`);
        const acct = accountId === null ? null : accounts.get(accountId);
        if (accountId !== null && !acct) issue('unknown_account', accountId, `no account record ${accountId}`);
        p = {
          accountId: accountId ?? null,
          accountName: acct?.name ?? null,
          securityId,
          name: sec?.name ?? null,
          ticker: sec?.ticker ?? null,
          isin: sec?.isin ?? null,
          currency: sec?.currency ?? null,
          assetClass: sec?.assetClass ?? null,
          shares: 0,      // 1e8
          cost: 0,        // 1e2 — basis of the shares still held, per costBasisMethod
          realized: 0,    // 1e2
          dividends: 0,   // 1e2
          fees: 0,        // 1e2
          taxes: 0,       // 1e2
          // Acquisition lots, oldest first: { date, shares (1e8), cost (1e2) }.
          // Tracked whatever the reporting method is — see the header.
          lots: [],
        };
        positions.set(key, p);
      }
      return p;
    };

    // A dividend, or a fee or tax booked against a security, names the cash
    // account it settled on — Portfolio Performance's own model has no depot on
    // one either. So it cannot be keyed to a securities account up front, and
    // guessing one mid-fold would depend on record order. Collected here and
    // attributed after the fold, where the security's positions are all known:
    // if exactly one position holds it there is no ambiguity, and if there are
    // several the extras land in the unattributed position rather than being
    // split by a rule nobody chose.
    const unattributed = [];
    const add = (p, { dividends = 0, fees = 0, taxes = 0 }) => {
      p.dividends += dividends;
      p.fees += fees;
      p.taxes += taxes;
    };
    const attribute = (tx, extras) => {
      if (tx.portfolioId) add(position(tx.portfolioId, tx.securityId), extras);
      else unattributed.push({ securityId: tx.securityId, extras });
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

    for (const tx of txRecs.slice().sort(byDateThenId)) {
      const day = dayOf(tx.date);
      // Nothing without a real calendar day is folded at all — not into cash,
      // not into a position, not into any snapshot. It cannot be placed in time,
      // and an unplaceable record that is folded anyway lands in every snapshot
      // including the opening valuation. Same code perf.js already raises.
      if (!isCalendarDay(day)) {
        issue('undated_transaction', tx.recordId,
          `transaction date ${JSON.stringify(tx.date)} is not a YYYY-MM-DD day`);
        continue;
      }
      if (asOf && day > asOf) continue;

      const sign = CASH_SIGN[tx.type];
      if (sign === undefined) {
        issue('unknown_transaction_type', tx.recordId, `unknown transaction type ${tx.type}`);
        continue;
      }

      // THE RATE IS THE ONE FOR `day`, THE TRANSACTION'S OWN DATE. Not the
      // newest stored rate, not today's: see the header. Looked up once per
      // record because all three amounts moved together, in one currency, on
      // one day.
      const txCcy = tx.currency ? String(tx.currency).toUpperCase() : null;
      let rate = null;
      if (reportingCcy && txCcy && txCcy !== reportingCcy) {
        const applicable = fxRates.rate(txCcy, reportingCcy, day);
        if (!applicable) {
          // No rate, so no reporting-currency value — not zero, unknown. The
          // record is left out of cash, position and totals alike rather than
          // folded at a number that would look like knowledge.
          fxGap(txCcy, day, tx.recordId);
          continue;
        }
        rate = applicable.rate;
      }
      // Each amount converts on its own, so what is stored rounds once at 1e2
      // rather than compounding through a subtotal.
      const money = (field) => {
        const raw = units(tx, field);
        return rate === null ? raw : convert(raw, rate);
      };

      const amount = money('amount');
      const fees = money('fees');
      const taxes = money('taxes');

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
        // §4: a buy/sell names both accounts. Without `portfolioId` the shares
        // cannot be attributed to a securities account, and picking one would
        // invent a holding at a broker the record never mentions — so it is
        // surfaced and the position is held unattributed (accountId null). The
        // cash leg above still stands: that money really did move.
        if (!tx.portfolioId) {
          issue('missing_portfolio', tx.recordId,
            `${tx.type} names no portfolioId, so the securities account its shares land in is unknown`);
        }
        const p = position(tx.portfolioId ?? null, tx.securityId);
        const shares = units(tx, 'shares');
        if (shares <= 0) {
          // Direction comes from the type, so `shares` is always a positive
          // magnitude; missing/zero/negative is malformed. Folding it anyway
          // would build a plausible-looking corrupt position (a negative-share
          // buy becomes a short holding with a positive basis), so the security
          // leg is skipped. The cash leg above still stands: `amount` is
          // validated on its own and is what really left the account.
          issue('non_positive_shares', tx.recordId, `${tx.type} has shares ${shares}`);
          continue;
        }

        if (tx.type === 'buy') {
          const lotCost = amount - taxes; // gross + fees
          p.shares += shares;
          p.cost += lotCost;
          p.lots.push({ date: day, shares, cost: lotCost });
        } else {
          const proceeds = amount + taxes; // gross - fees
          // Lots are consumed oldest-first under both methods; only the number
          // reported as removed basis differs.
          const lotCost = consumeLots(p.lots, shares);
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
          } else if (costBasisMethod === 'fifo') {
            // The oldest lots' own cost, so a full exit removes exactly what the
            // lots carried and leaves no dust.
            costRemoved = lotCost;
          } else {
            // Moving average. proportion(cost, shares, held) === cost when the
            // whole position goes, so a full exit leaves no rounding dust here
            // either.
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
        attribute(tx, { dividends: amount, fees, taxes });
        continue;
      }

      // Standalone fee/tax records: the whole `amount` is the fee or the tax.
      // Attributed to a security when one is named, so a custody fee on a holding
      // shows up against it, but never capitalised into the basis.
      if (tx.type === 'fee' || tx.type === 'tax') {
        if (tx.securityId) {
          attribute(tx, tx.type === 'fee' ? { fees: amount } : { taxes: amount });
        }
        continue;
      }

      // deposit / removal / interest / transfer_*: cash only, already applied.
      // Any fees or taxes broken out on them are still reported.
      if (tx.securityId) attribute(tx, { fees, taxes });
    }

    for (const { securityId, extras } of unattributed) {
      const held = [...positions.values()].filter((p) => p.securityId === securityId);
      // One position holding the security is not a guess — it is the only place
      // the income can have come from. Several, and the record does not say
      // which, so it goes to the unattributed position of that security.
      add(held.length === 1 ? held[0] : position(null, securityId), extras);
    }

    const quotes = latestCloses(priceRecs, asOf, issue);

    // A close belongs to the security, so it is missing for every position
    // holding it at once — said once rather than once per broker.
    const unpriced = new Set();
    for (const p of positions.values()) {
      const quote = quotes.get(p.securityId);
      if (!quote) {
        if (p.shares !== 0 && !unpriced.has(p.securityId)) {
          unpriced.add(p.securityId);
          issue('no_price', p.securityId, `no price record for ${p.securityId}${asOf ? ` on or before ${asOf}` : ''}`);
        }
        p.price = null;
        p.priceDate = null;
        p.marketValue = null;
        p.unrealized = null;
        continue;
      }
      // `price` stays in the security's own currency (`p.currency`) — it is a
      // market fact about the security, and the holdings screen labels it with
      // that currency. Only the VALUE crosses into the reporting currency.
      p.price = quote.close;
      p.priceDate = quote.date;

      let value = marketValue(p.shares, quote.close);
      const secCcy = p.currency ? String(p.currency).toUpperCase() : null;
      // Zero is zero in every currency, so a closed position needs no rate.
      // Found by codex review: without this, a fully-sold foreign holding whose
      // security still has a stored close manufactures a `currency_not_converted`
      // gap and a null market value over a number that was never in doubt —
      // and a fully-sold holding is the most ordinary thing in a portfolio.
      if (value !== 0 && reportingCcy && secCcy && secCcy !== reportingCcy) {
        // At the CLOSE's day, not the trade dates: this is what the holding is
        // worth as of the valuation, so it takes the rate as of the valuation.
        const applicable = fxRates.rate(secCcy, reportingCcy, quote.date);
        if (!applicable) {
          // Same treatment as no_price, and for the same reason: a value that
          // cannot be computed is null, so the totals leave it out instead of
          // counting it as zero.
          fxGap(secCcy, quote.date, p.securityId);
          p.marketValue = null;
          p.unrealized = null;
          continue;
        }
        value = convert(value, applicable.rate);
      }
      p.marketValue = value;
      p.unrealized = value - p.cost;
    }

    const label = (p) => String(p.name ?? p.securityId);
    const positionList = [...positions.values()].sort((a, b) => (
      label(a).localeCompare(label(b))
      // Two brokers holding the same security are adjacent and in a stable
      // order, rather than in whichever order their first trade folded.
      || String(a.accountName ?? a.accountId ?? '').localeCompare(String(b.accountName ?? b.accountId ?? ''))
    ));
    const accountList = [...accounts.values()]
      .sort((a, b) => String(a.name ?? a.accountId).localeCompare(String(b.name ?? b.accountId)));

    const sum = (list, key) => list.reduce((acc, x) => acc + (x[key] ?? 0), 0);
    const cash = sum(accountList, 'balance');
    const value = sum(positionList, 'marketValue');

    // The portfolio-wide view of a security: the same ETF at two brokers is two
    // positions and one of these. Shares, basis and gains add up; the quote is
    // the security's own, so `marketValue` is null exactly when every position
    // holding it is unvalued.
    const securityList = [];
    const bySecurity = new Map();
    for (const p of positionList) {
      let s = bySecurity.get(p.securityId);
      if (!s) {
        s = {
          securityId: p.securityId,
          name: p.name,
          ticker: p.ticker,
          isin: p.isin,
          currency: p.currency,
          assetClass: p.assetClass,
          accountIds: [],
          shares: 0,
          cost: 0,
          realized: 0,
          dividends: 0,
          fees: 0,
          taxes: 0,
          price: p.price,
          priceDate: p.priceDate,
          marketValue: p.marketValue === null ? null : 0,
          unrealized: p.unrealized === null ? null : 0,
        };
        bySecurity.set(p.securityId, s);
        securityList.push(s);
      }
      s.accountIds.push(p.accountId);
      for (const k of ['shares', 'cost', 'realized', 'dividends', 'fees', 'taxes']) s[k] += p[k];
      if (s.marketValue !== null) {
        s.marketValue += p.marketValue;
        s.unrealized += p.unrealized;
      }
    }

    return {
      asOf: asOf ?? null,
      reportingCurrency,
      costBasisMethod,
      positions: positionList,
      securities: securityList,
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

const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

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
      // Dates are compared as strings, so an unpadded or out-of-range key sorts
      // above every well-formed one ("2024-3-15" > "2024-12-31") and would
      // become the security's latest quote.
      if (!MONTH_DAY_RE.test(monthDay)) {
        issue('price_not_chunked', rec.recordId, `close key ${JSON.stringify(monthDay)} is not a zero-padded MM-DD`);
        continue;
      }
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
