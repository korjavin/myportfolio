// Transaction form ⇄ record translation, and the validation that guards it.
//
// THE MONEY RULE LIVES HERE. An edit form is the one place a rendered value can
// leak back into a record and silently corrupt a portfolio, so both directions
// are pinned:
//
//   record → form   formatFixed(units, decimals)   exact decimal string
//   form   → record parseFixed(string, decimals)   digit-wise, never parseFloat
//
// Both are §5 primitives from web/domain/money.js and they are exact inverses:
// formatFixed emits precisely `decimals` fractional digits and parseFixed reads
// precisely that many back, so editing one field and saving cannot perturb the
// others. What must NEVER appear in this file is `toFloat`, or the grouped
// output of fmt.js — "1,234.56" is display text, and parsing display text back
// into money is the bug this whole layer exists to make impossible. fmt.js is
// deliberately not imported here.
//
// Validation is at a trust boundary (free text from a human), so it is
// deliberately not minimal: §4 pins which types may carry which fields and
// which signs are legal, and a violation is surfaced rather than coerced.
//
// Pure module — no DOM, so `node --test` can exercise it without jsdom.

import { parseFixed, formatFixed, DECIMALS } from '../../../domain/money.js';
import { TX_TYPES, RECORD } from '../../../domain/schema.js';

/** Types that book against a security. Everything else is cash-only. */
export const SECURITY_TYPES = new Set(['buy', 'sell', 'dividend']);

/** Types that move a share count. A dividend touches cash, not shares. */
export const SHARE_TYPES = new Set(['buy', 'sell']);

// §4: "A negative `amount` is legal only on the cash-only types — fee, tax,
// interest — where it means the flow runs the other way" (PP's FEES_REFUND,
// TAX_REFUND, INTEREST_CHARGE). On every other type the direction is already
// carried by CASH_SIGN, so a negative amount is a data error to surface, not a
// reversal to honour.
export const SIGNED_TYPES = new Set(['fee', 'tax', 'interest']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today as a YYYY-MM-DD day in the *user's local* calendar.
 *
 * Deliberately local, unlike everything in web/domain/, which is UTC by fiat.
 * This is a form default — the day the human standing in front of the phone
 * would write down — not arithmetic. Reading it off toISOString() would file a
 * trade made on the evening of the 5th in Berlin as the 5th (fine) but one made
 * at 8pm on the 5th in Auckland as the 5th too while the user's calendar says
 * the 6th. Building it from the local parts is what the date picker itself
 * would show.
 */
export function todayLocal(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Blank form values for a new transaction. */
export function emptyTxForm(defaults = {}) {
    return {
        type: 'buy',
        date: todayLocal(),
        accountId: '',
        securityId: '',
        shares: '',
        amount: '',
        fees: '',
        taxes: '',
        note: '',
        currency: '',
        ...defaults,
    };
}

/**
 * Render stored units for an input, keeping at least `min` fractional digits.
 *
 * Dropping trailing zeros is safe precisely because it is not rounding:
 * "10.00000000" and "10" parse to the identical integer at 1e8, and parseFixed
 * pads a short fraction back out, so the round trip stays exact. It matters
 * because the shares field is eight decimals wide, and asking someone to edit
 * "10.00000000" on a phone is how a keystroke lands in the wrong decimal place.
 * Cash keeps its two decimals (min = 2), where they read as money rather than
 * as noise.
 */
function forInput(units, decimals, min) {
    if (!Number.isSafeInteger(units)) return '';
    const s = formatFixed(units, decimals);
    if (!s.includes('.')) return s;
    const [int, frac] = s.split('.');
    let end = frac.length;
    while (end > min && frac[end - 1] === '0') end -= 1;
    return end > 0 ? `${int}.${frac.slice(0, end)}` : int;
}

/**
 * A stored transaction as form strings. Money fields go through formatFixed,
 * so what lands in the input is the stored integer rendered exactly — reopening
 * and saving an untouched form is a no-op on every field.
 */
export function txToForm(record) {
    const fixed = (units, decimals) => forInput(units, decimals, Math.min(decimals, 2));
    return {
        type: record.type ?? 'buy',
        date: String(record.date ?? '').slice(0, 10),
        accountId: record.accountId ?? '',
        securityId: record.securityId ?? '',
        shares: forInput(record.shares, DECIMALS.shares, 0),
        amount: fixed(record.amount, DECIMALS.amount),
        fees: fixed(record.fees, DECIMALS.amount),
        taxes: fixed(record.taxes, DECIMALS.amount),
        note: record.note ?? '',
        currency: record.currency ?? '',
    };
}

function parseInto(target, values, key, decimals, label, errors, { required = false } = {}) {
    const raw = String(values[key] ?? '').trim();
    if (raw === '') {
        if (required) errors.push(`${label} is required.`);
        return;
    }
    try {
        target[key] = parseFixed(raw, decimals);
    } catch {
        errors.push(`${label} is not a number: ${raw}`);
    }
}

/**
 * Form values → a §4 `transaction` body, or the reasons it is not one.
 *
 * Returns `{ body, errors }`. `body` is only meaningful when `errors` is empty.
 * The port owns recordId/recordType/clientTs/deleted (§3), so none of them
 * appear here.
 */
export function buildTxBody(values) {
    const errors = [];
    const type = String(values.type ?? '');
    if (!TX_TYPES.includes(type)) errors.push(`Unknown transaction type: ${type || '(none)'}`);

    const date = String(values.date ?? '').trim();
    if (!DAY_RE.test(date)) errors.push('Date must be a YYYY-MM-DD calendar day.');

    const accountId = String(values.accountId ?? '').trim();
    if (!accountId) errors.push('Pick an account — every transaction moves cash on one (§4).');

    const body = { type, date, accountId };

    const securityId = String(values.securityId ?? '').trim();
    if (SECURITY_TYPES.has(type)) {
        if (!securityId) errors.push(`A ${type} needs a security.`);
        else body.securityId = securityId;
    } else if (securityId && (type === 'transfer_in' || type === 'transfer_out')) {
        // §4: security transfers are not representable in v1 — there is no way
        // to express carried-over cost basis, and the engine refuses them. Say
        // so at the form rather than storing a record that will only ever
        // produce an issue.
        errors.push('Security transfers are not supported in v1 (no way to carry cost basis).');
    }

    parseInto(body, values, 'amount', DECIMALS.amount, 'Amount', errors, { required: true });
    parseInto(body, values, 'fees', DECIMALS.amount, 'Fees', errors);
    parseInto(body, values, 'taxes', DECIMALS.amount, 'Taxes', errors);
    if (SHARE_TYPES.has(type)) {
        parseInto(body, values, 'shares', DECIMALS.shares, 'Shares', errors, { required: true });
        if (Number.isSafeInteger(body.shares) && body.shares <= 0) {
            errors.push('Shares must be greater than zero — use Sell to reduce a position.');
        }
    }

    if (Number.isSafeInteger(body.amount) && body.amount < 0 && !SIGNED_TYPES.has(type)) {
        errors.push(
            `A negative amount is only meaningful on fee/tax/interest (a refund or charge). ` +
            `A ${type} already carries its direction.`
        );
    }
    for (const key of ['fees', 'taxes']) {
        if (Number.isSafeInteger(body[key]) && body[key] < 0) errors.push(`${key} cannot be negative.`);
    }

    const currency = String(values.currency ?? '').trim().toUpperCase();
    if (currency) body.currency = currency;
    const note = String(values.note ?? '').trim();
    if (note) body.note = note;

    return { body, errors };
}

/**
 * Fold one day's close into a security's price chunk.
 *
 * §4 stores prices chunked per security-year — `{ securityId, year, closes:
 * {"MM-DD": close} }` — so recording a price is a read-modify-write of the
 * year's record, not an insert. Three details are load-bearing, which is why
 * this is a named, tested function instead of an object spread inside a click
 * handler:
 *
 *  - the MM-DD key is ZERO-PADDED. portfolio.js picks the latest close by
 *    string comparison, and an unpadded "3-15" sorts above "12-31" and would
 *    win the latest-close race for the whole year. §4 says so in as many words.
 *  - the existing `closes` map is spread, not replaced, so entering today's
 *    price does not wipe the year's history.
 *  - `year` is a 4-digit STRING-shaped value; portfolio.js raises
 *    `price_not_chunked` and drops the record if it is not.
 *
 * `recordId` is deterministic (`price_<securityId>_<year>`) so re-entering a
 * price updates the chunk instead of minting a second one for the same year.
 */
export function buildPriceChunk({ existing, securityId, day, closeUnits }) {
    const errors = [];
    const date = String(day ?? '').slice(0, 10);
    if (!DAY_RE.test(date)) errors.push('Date must be a YYYY-MM-DD calendar day.');
    if (!securityId) errors.push('A price needs a security.');
    if (!Number.isSafeInteger(closeUnits)) errors.push('Close must be a fixed-point integer.');
    else if (closeUnits <= 0) errors.push('A close must be greater than zero.');
    if (errors.length > 0) return { errors };

    const year = date.slice(0, 4);
    return {
        errors,
        recordId: `${RECORD.price}_${securityId}_${year}`,
        body: {
            securityId,
            year,
            closes: { ...(existing?.closes ?? {}), [date.slice(5, 10)]: closeUnits },
        },
    };
}
