// A security's own close series, read straight off the §4 price chunks.
//
// Deliberately NOT built on portfolio.js's snapshot(). A portfolio-wide time
// series needs a valuation at every sampled date — one full fold per point. One
// security's price history needs no fold at all: it is that security's own
// chunks, merged and sorted, O(years). Anything here that reaches for a
// snapshot has misread the problem.
//
// Closes stay §5 fixed-point integers at scale 1e8. Nothing in this file
// converts to a float — the render boundary is web/static/js/features/fmt.js
// and it is one-way.
//
// Pure module over the §3 records port: no window/document/fetch/indexedDB.

import { RECORD } from './schema.js';

// §4 chunk keys are zero-padded MM-DD. Dates are compared and sorted as
// strings, so an unpadded or out-of-range key ("2024-3-15") sorts above every
// well-formed one and would land at the END of the series — reported as the
// newest close. That bug has been shipped twice in this repo.
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * THE reader of the §4 per-security-year chunk shape
 * `{ securityId, year, closes: { "MM-DD": close } }`. Walks a list of `price`
 * records and yields `{ securityId, recordId, date: "YYYY-MM-DD", close }` for
 * every well-formed close, in record order — the caller decides what to do with
 * the order.
 *
 * `issue(code, recordId, message)` is called for every chunk or key that is
 * rejected, matching portfolio.js's issue signature exactly. That is not a
 * coincidence: portfolio.js's private `latestCloses()` is a second copy of this
 * validation, and two readers of one record shape drift. It should be reduced
 * to a consumer of this generator — see the note in the bead report; that edit
 * was out of scope for the branch that introduced this file, and
 * prices.test.js pins the two against each other until it lands.
 */
export function* eachClose(priceRecs, issue = () => {}) {
  for (const rec of priceRecs) {
    // A missing year builds "undefined-03-15", which sorts above every real
    // date.
    if (!rec.closes || typeof rec.closes !== 'object' || !/^\d{4}$/.test(String(rec.year))) {
      issue('price_not_chunked', rec.recordId,
        'price record needs a 4-digit `year` and a `closes` map; §4 stores prices chunked per security-year');
      continue;
    }
    for (const [monthDay, close] of Object.entries(rec.closes)) {
      if (!MONTH_DAY_RE.test(monthDay)) {
        issue('price_not_chunked', rec.recordId, `close key ${JSON.stringify(monthDay)} is not a zero-padded MM-DD`);
        continue;
      }
      if (!Number.isSafeInteger(close)) {
        issue('non_integer_units', rec.recordId, `close ${rec.year}-${monthDay} is not a fixed-point integer: ${close}`);
        continue;
      }
      yield { securityId: rec.securityId, recordId: rec.recordId, date: `${rec.year}-${monthDay}`, close };
    }
  }
}

export function createPricesDomain({ records }) {
  /**
   * Every stored close for one security, oldest first.
   *
   * @param securityId  the security's recordId.
   * @param from/to     optional inclusive "YYYY-MM-DD" bounds.
   * @returns [{ date: "YYYY-MM-DD", close }] — close is a 1e8 integer.
   *
   * Returns the truth, at full daily resolution. Downsampling for a 360px
   * screen belongs in the view: a reader that thins the series cannot be used
   * for anything but drawing it.
   */
  async function series(securityId, { from, to } = {}) {
    if (!securityId) return [];
    const chunks = (await records.list(RECORD.price)).filter((r) => r.securityId === securityId);

    // ONE POINT PER DAY, first chunk in port order wins. Two chunks for the
    // same security-year are reachable — ppimport.js mints
    // `price_<hash>` and store.putPrice mints `price_<securityId>_<year>`, so
    // importing a PP file and then typing a close by hand leaves both, which is
    // why quotes.js has its own "lowest recordId wins" tiebreak. Appending both
    // would put two points on one date and let the second decide the chart's
    // latest close, while portfolio.js — which keeps the first close it sees at
    // an equal date, off the same records.list order — values the holdings row
    // off the other one. Same rule here, so the two never disagree.
    const byDate = new Map();
    for (const { date, close } of eachClose(chunks)) {
      // String comparison is exact for zero-padded ISO days, which is why the
      // key validation above is not optional.
      if (from && date < from) continue;
      if (to && date > to) continue;
      if (!byDate.has(date)) byDate.set(date, close);
    }
    return [...byDate.entries()]
      .map(([date, close]) => ({ date, close }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  return { series };
}
