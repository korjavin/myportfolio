// Fixed-point money. ARCHITECTURE.md §5 — every currency amount, share count,
// price and FX rate in web/domain/ is a scaled integer, never a float:
//
//   amounts (cash, fees, taxes)  1e2   €1234.56      -> 123456
//   shares                       1e8   0.00123456 BTC -> 123456
//   prices                       1e8   $41.2350      -> 4123500000
//   FX rates                     1e8   1.0842        -> 108420000
//
// Those are Portfolio Performance's own scales, so a later PP import is
// lossless and round-trips. Values become floats exactly once, at the render
// boundary (toFloat), and never flow back.
//
// Pure module: no window/document/fetch/indexedDB (ARCHITECTURE.md §1).

export const DECIMALS = { amount: 2, shares: 8, price: 8, fx: 8 };

const POW10 = (n) => 10n ** BigInt(n);
const FIXED_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

// Scaled integers are carried as JS numbers (safe to ~9e15, i.e. €90 trillion
// at 1e2). Products are computed in BigInt and only narrowed here, so a value
// that would silently lose precision throws instead.
function toSafeNumber(big) {
  const n = Number(big);
  if (!Number.isSafeInteger(n)) throw new RangeError(`fixed-point overflow: ${big}`);
  return n;
}

function assertUnits(units, label) {
  if (!Number.isSafeInteger(units)) {
    throw new RangeError(`${label}: expected a fixed-point integer, got ${units}`);
  }
  return units;
}

// Round half away from zero, the conventional money rounding. `d` must be > 0.
function divRound(n, d) {
  const q = n / d;
  const r = n % d;
  const rem2 = (r < 0n ? -r : r) * 2n;
  if (rem2 < d) return q;
  return n < 0n ? q - 1n : q + 1n;
}

const EXPONENTIAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

// String() switches to exponential notation below 1e-7 and past ~1e21 — and a
// sub-1e-7 crypto price is a real input, not a hypothetical. Shifting the
// decimal point by hand keeps every digit, so the exponential path stays exactly
// as precise as the ordinary one instead of falling back to toFixed.
function expandExponential(s) {
  const m = EXPONENTIAL_RE.exec(s);
  if (!m) return s;
  const [, sign, intPart, frac = '', exp] = m;
  const digits = intPart + frac;
  const pointAt = intPart.length + Number(exp);
  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

// parseFixed turns user/import input into scaled integer units. Strings are
// parsed digit-wise, never via parseFloat, which would reintroduce the float we
// are trying to avoid.
//
// Numbers are accepted because quote APIs hand back JSON numbers, and they are
// normalised with String() rather than toFixed(): String() yields the shortest
// decimal that round-trips to that double, which recovers the decimal the caller
// meant. toFixed rounds the *binary* value instead, so (1.005).toFixed(2) is
// '1.00' and a cent vanishes — toFixed is therefore not used anywhere here.
export function parseFixed(value, decimals) {
  let s;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
    s = expandExponential(String(value));
  } else {
    s = String(value ?? '').trim();
  }
  const m = FIXED_RE.exec(s);
  // Reject "", ".", "abc", "1e5" — anything without at least one digit.
  if (!m || (!m[2] && !m[3])) throw new RangeError(`not a fixed-point number: ${JSON.stringify(value)}`);

  const intPart = m[2] || '0';
  const frac = m[3] || '';
  let units;
  if (frac.length <= decimals) {
    units = BigInt(intPart + frac.padEnd(decimals, '0'));
  } else {
    units = BigInt(intPart + frac.slice(0, decimals));
    // The first dropped digit being >= 5 is exactly "remainder >= half".
    if (frac.charCodeAt(decimals) >= 0x35) units += 1n;
  }
  return toSafeNumber(m[1] === '-' ? -units : units);
}

// formatFixed renders scaled units as an exact decimal string. This is a string,
// not a number, so it is safe on the render path and cannot drift.
export function formatFixed(units, decimals) {
  const n = BigInt(assertUnits(units, 'formatFixed'));
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(decimals + 1, '0');
  const cut = abs.length - decimals;
  const body = decimals > 0 ? `${abs.slice(0, cut)}.${abs.slice(cut)}` : abs;
  return neg ? `-${body}` : body;
}

// toFloat is THE render boundary (§5). Nothing may feed its result back into
// domain arithmetic — use the scaled integer, or formatFixed for display.
export function toFloat(units, decimals) {
  return assertUnits(units, 'toFloat') / Number(POW10(decimals));
}

// marketValue: shares (1e8) x price (1e8) -> amount (1e2). The intermediate
// product reaches ~1e22 for realistic holdings, well past Number.MAX_SAFE_INTEGER,
// which is why this is BigInt and not `shares * price / 1e14`.
export function marketValue(shares, price) {
  assertUnits(shares, 'marketValue shares');
  assertUnits(price, 'marketValue price');
  const drop = DECIMALS.shares + DECIMALS.price - DECIMALS.amount;
  return toSafeNumber(divRound(BigInt(shares) * BigInt(price), POW10(drop)));
}

// perShare: amount (1e2) / shares (1e8) -> price (1e8). The inverse of
// marketValue, for the add-transaction form, where a broker states shares and a
// total and the price per share is the field the user has to fill in. Rounded
// once at the price scale, and exact where it can be: perShare(marketValue(s,
// p), s) === p whenever s x p has no sub-cent remainder to lose.
export function perShare(amount, shares) {
  const scale = Number(POW10(DECIMALS.shares + DECIMALS.price - DECIMALS.amount));
  return proportion(amount, scale, shares);
}

// convert: amount (1e2) x FX rate (1e8) -> amount (1e2).
export function convert(amount, rate) {
  assertUnits(amount, 'convert amount');
  assertUnits(rate, 'convert rate');
  return toSafeNumber(divRound(BigInt(amount) * BigInt(rate), POW10(DECIMALS.fx)));
}

// proportion: units * numerator / denominator, exact and rounded once. Used for
// moving-average cost removal, where `units * num` overflows a float long before
// it overflows BigInt. Selling the whole position removes the whole cost with no
// rounding dust, since proportion(c, h, h) === c.
export function proportion(units, numerator, denominator) {
  assertUnits(units, 'proportion units');
  assertUnits(numerator, 'proportion numerator');
  assertUnits(denominator, 'proportion denominator');
  if (denominator === 0) throw new RangeError('proportion: zero denominator');
  let n = BigInt(units) * BigInt(numerator);
  let d = BigInt(denominator);
  if (d < 0n) { n = -n; d = -d; }
  return toSafeNumber(divRound(n, d));
}
