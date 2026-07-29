// Record types, ARCHITECTURE.md §4. Shared vocabulary for the domain modules and
// the UI — the record *bodies* live here as documentation only; the port owns
// recordId/recordType/clientTs/deleted and stamps them on write (§3), so nothing
// in a body ever names those four fields.
//
// Pure module: no window/document/fetch/indexedDB (ARCHITECTURE.md §1).

export const RECORD = {
  account: 'account',       // { name, kind: "cash"|"securities", currency, closed }
  security: 'security',     // { name, isin?, ticker?, currency, assetClass, quote: { provider, symbol } }
  // accountId is the CASH leg for every type; a buy/sell also names portfolioId,
  // the securities account the shares land in — that is what keys a position.
  transaction: 'transaction', // { type, accountId, portfolioId?, securityId?, date, shares?, amount, fees?, taxes?, currency, fx?, note?, counterAccountId? }
  price: 'price',           // { securityId, year, closes: { "MM-DD": close } }  — chunked per security-year
  fx: 'fx',                 // { pair: "EURUSD", date, rate }
  settings: 'settings',     // singleton — { reportingCurrency, quoteProviders, costBasisMethod, ... }
};

// §4: how realized gain is REPORTED. Lots are tracked either way — the method
// does not change what is stored, only which basis a sale is measured against.
// FIFO leads because most EU tax authorities require it for declaring capital
// gains, so it is the default.
export const COST_BASIS_METHODS = ['fifo', 'moving_average'];

// The closed set from §4. Deliberately not a free-text kind: this exact set is
// what makes PP import possible and TTWROR/IRR computable.
export const TX_TYPES = [
  'buy', 'sell', 'dividend', 'deposit', 'removal',
  'interest', 'fee', 'tax', 'transfer_in', 'transfer_out',
];

export const ASSET_CLASSES = ['stock', 'etf', 'crypto', 'bond', 'commodity'];

// §4: settings is a singleton at a fixed recordId.
export const SETTINGS_ID = 'settings';

// §4: recordId is a client-generated `<type>_<ms>_<rand>` string. Math.random is
// used rather than crypto.getRandomValues to keep this module runtime-agnostic;
// ids only need to be collision-free within one user's portfolio, and the
// millisecond prefix already separates all but same-ms writes.
export function newRecordId(recordType, nowMs) {
  return `${recordType}_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}
