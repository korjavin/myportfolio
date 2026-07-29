// The render boundary, and nothing else.
//
// ARCHITECTURE.md §5: fixed-point integers become human-readable text HERE and
// nowhere else, and the result never flows back into a record. Note what this
// module does NOT import: `toFloat`. Every function below goes through
// `formatFixed`, which returns an exact decimal *string* — so there is no
// intermediate double for a rounding error to hide in, and nothing produced
// here can be parsed back into a number without someone noticing they are
// parsing display text.
//
// The one exception is percent(), whose input is already a float: TTWROR and
// IRR are ratios, not money, and §5 says so explicitly.
//
// Pure module — no DOM. That is what makes it testable under `node --test`,
// which has no jsdom here.

import { DECIMALS, formatFixed, proportion } from '../../../domain/money.js';

// Shown wherever a value is genuinely unknown (an unpriced position's market
// value, an undefined return). Deliberately not "0.00": a missing price and a
// zero balance are different facts and must not render the same.
export const UNKNOWN = '—';

// Thin-space grouping is done on the *digit string* produced by formatFixed,
// never via toLocaleString on a number — that would mean turning money into a
// double first, which is the whole thing §5 forbids.
function group(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function split(units, decimals) {
    const s = formatFixed(units, decimals);
    const neg = s.startsWith('-');
    const [int, frac] = (neg ? s.slice(1) : s).split('.');
    return { neg, int, frac: frac ?? '' };
}

/** A cash amount (1e2) as grouped text: 123456 → "1,234.56". */
export function money(units) {
    if (!Number.isSafeInteger(units)) return UNKNOWN;
    const { neg, int, frac } = split(units, DECIMALS.amount);
    return `${neg ? '-' : ''}${group(int)}.${frac}`;
}

/** Same, with an explicit + on positives — for flows and gains. */
export function signedMoney(units) {
    if (!Number.isSafeInteger(units)) return UNKNOWN;
    return units > 0 ? `+${money(units)}` : money(units);
}

// Share counts and prices carry 8 decimals so 0.00000001 BTC survives a round
// trip, but rendering "10.00000000 VWCE" on a phone row is noise. Trailing
// zeros are trimmed down to `min` places; the digits themselves are untouched,
// so nothing is rounded away — a value with real precision keeps all of it.
function trimTrailing(units, decimals, min) {
    if (!Number.isSafeInteger(units)) return UNKNOWN;
    const { neg, int, frac } = split(units, decimals);
    let end = frac.length;
    while (end > min && frac[end - 1] === '0') end -= 1;
    const kept = frac.slice(0, end);
    return `${neg ? '-' : ''}${group(int)}${kept ? `.${kept}` : ''}`;
}

/** A share count (1e8): 1000000000 → "10", 123456 → "0.00123456". */
export function shares(units) {
    return trimTrailing(units, DECIMALS.shares, 0);
}

/** A price (1e8): 4123500000 → "41.235". Always at least 2 decimals. */
export function price(units) {
    return trimTrailing(units, DECIMALS.price, 2);
}

/**
 * The delta modifier for a signed integer (or ratio). Gain/loss is NEVER
 * encoded by colour alone — .wg-delta--* emits its ▲/▼/— glyph from CSS, which
 * is why callers must go through these class names rather than colouring a
 * bare number (ARCHITECTURE.md §9).
 *
 * A null/unknown value is `--flat`, whose glyph is the em dash: "we do not
 * know" reads as neutral, not as a loss.
 */
export function deltaClass(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'wg-delta--flat';
    return value > 0 ? 'wg-delta--gain' : 'wg-delta--loss';
}

/**
 * A performance ratio as a percentage. The input is already a float — perf.js
 * returns TTWROR/IRR as ratios, and §5 exempts ratios from the integer rule
 * because the scale cancels out of every one of them.
 */
export function percent(ratio) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return UNKNOWN;
    const pct = ratio * 100;
    return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/**
 * `part` as a percentage of `total`, both fixed-point integers of the same
 * scale. The division happens in the domain (money.js `proportion`, exact
 * BigInt with a single rounding) and only the resulting basis points are
 * formatted here — so no float appears anywhere in the path.
 */
export function sharePercent(part, total) {
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || total === 0) return UNKNOWN;
    return `${formatFixed(proportion(10000, part, total), 2)}%`;
}

/** Basis points of `total`, as an integer 0..10000 — for bar widths. */
export function shareBasisPoints(part, total) {
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || total <= 0) return 0;
    return Math.max(0, Math.min(10000, proportion(10000, part, total)));
}

/**
 * How a position is named, in one place for every screen.
 *
 * A POSITION IS OPAQUE. Screens render whatever identity the engine hands them
 * and must not reconstruct one: no keying a row, map or DOM id off
 * `securityId`. Today portfolio.js returns one position per security; bd
 * g7e.11 re-keys them by (accountId, securityId), so the same ETF at two
 * brokers becomes two positions. Every screen goes through this function, so
 * that change is one edit here — adding the account qualifier to the label —
 * rather than a hunt through three screens for a label built inline.
 *
 * Not pre-built for that: reading a field the engine does not emit yet would
 * read as a bug today, and `filter(Boolean)` on `undefined` is scaffolding.
 */
export function positionLabel(position) {
    if (!position) return UNKNOWN;
    if (position.ticker && position.name) return `${position.ticker} · ${position.name}`;
    return position.ticker || position.name || position.securityId || UNKNOWN;
}

const TX_LABELS = {
    buy: 'Buy',
    sell: 'Sell',
    dividend: 'Dividend',
    deposit: 'Deposit',
    removal: 'Withdrawal',
    interest: 'Interest',
    fee: 'Fee',
    tax: 'Tax',
    transfer_in: 'Transfer in',
    transfer_out: 'Transfer out',
};

export function txTypeLabel(type) {
    return TX_LABELS[type] ?? String(type ?? UNKNOWN);
}
