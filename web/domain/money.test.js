import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECIMALS, parseFixed, formatFixed, toFloat, marketValue, convert, proportion,
} from './money.js';

const { amount, shares, price, fx } = DECIMALS;

test('parses and formats each §5 scale, round-tripping the documented examples', () => {
  // The exact examples from ARCHITECTURE.md §5.
  assert.equal(parseFixed('1234.56', amount), 123456);
  assert.equal(parseFixed('0.00123456', shares), 123456);
  assert.equal(parseFixed('41.2350', price), 4123500000);
  assert.equal(parseFixed('1.0842', fx), 108420000);

  assert.equal(formatFixed(123456, amount), '1234.56');
  assert.equal(formatFixed(123456, shares), '0.00123456');
  assert.equal(formatFixed(4123500000, price), '41.23500000');
  assert.equal(formatFixed(108420000, fx), '1.08420000');
});

test('round-trips string -> units -> string at every scale', () => {
  const cases = [
    [amount, ['0.00', '0.01', '-0.01', '12.30', '-1234.56', '999999999.99']],
    [shares, ['0.00000000', '1.00000000', '0.00000001', '-0.00123456', '21000000.00000000']],
    [price, ['41.23500000', '0.00000123', '-99999.99999999']],
    [fx, ['1.08420000', '0.00000001']],
  ];
  for (const [decimals, values] of cases) {
    for (const v of values) {
      assert.equal(formatFixed(parseFixed(v, decimals), decimals), v, `round trip ${v} @${decimals}`);
    }
  }
});

test('accepts the shapes a user or importer actually types', () => {
  assert.equal(parseFixed('12', amount), 1200);
  assert.equal(parseFixed('.5', amount), 50);
  assert.equal(parseFixed('12.', amount), 1200);
  assert.equal(parseFixed('+12.34', amount), 1234);
  assert.equal(parseFixed('  12.34  ', amount), 1234);
  assert.equal(parseFixed('-0.00', amount), 0);
});

test('rounds half away from zero, and only on the truly dropped remainder', () => {
  assert.equal(parseFixed('0.005', amount), 1);
  assert.equal(parseFixed('-0.005', amount), -1);
  assert.equal(parseFixed('0.004', amount), 0);
  assert.equal(parseFixed('0.0049999', amount), 0);
  assert.equal(parseFixed('0.015', amount), 2);
  assert.equal(parseFixed('0.4999999', amount), 50);
  assert.equal(parseFixed('0.494', amount), 49);
});

test('normalises float input without inheriting its error', () => {
  // Numbers are accepted because quote APIs return JSON numbers.
  // The canonical float bug: 0.1 + 0.2 === 0.30000000000000004.
  assert.equal(parseFixed(0.1 + 0.2, amount), 30);
  assert.equal(parseFixed(-12.345, amount), -1235);
  // Exponential notation still has to land, for sub-cent crypto prices.
  assert.equal(parseFixed(1e-7, shares), 10);
  assert.equal(parseFixed(1.5e-8, price), 2);
});

test('a number at a decimal half-step rounds by its decimal, not its binary value', () => {
  // 1.005 is stored as 1.00499999999999989, so (1.005).toFixed(2) is '1.00' and
  // a cent silently vanishes. String() yields the shortest round-tripping
  // decimal ('1.005'), which is the value the caller actually meant.
  assert.equal(parseFixed(1.005, amount), 101);
  assert.equal(parseFixed(-1.005, amount), -101);
  assert.equal(parseFixed(8.575, amount), 858);
  // And it must agree with the string form of the same literal.
  for (const v of [1.005, 2.675, 8.575, -1.005]) {
    assert.equal(parseFixed(v, amount), parseFixed(String(v), amount), `number/string agree for ${v}`);
  }
});

test('expands exponential notation without losing a digit', () => {
  // String() switches to exponential below 1e-7 — a real sub-cent crypto price,
  // not a hypothetical. Every digit must survive the shift.
  assert.equal(parseFixed(1e-7, shares), 10);
  assert.equal(parseFixed(1.23456789e-3, shares), 123457); // rounds at the 8th decimal
  assert.equal(parseFixed(-1.5e-8, price), -2);
  assert.equal(parseFixed(1e-9, price), 0, 'below the scale rounds to zero, not to garbage');
  // Large exponents expand too, and then fail the safe-integer guard honestly
  // rather than silently truncating.
  assert.throws(() => parseFixed(1e21, amount), RangeError);
  // Number and string spellings of the same value must agree.
  for (const v of [1e-7, 1.5e-8, 2.5e-8, 1e-9]) {
    assert.equal(parseFixed(v, price), parseFixed(expandByHand(v), price), `agree for ${v}`);
  }
});

// Independent decimal expansion, so the test does not just re-run the implementation.
function expandByHand(v) {
  const [mantissa, exp] = String(v).split('e');
  const neg = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const intLen = mantissa.replace('-', '').split('.')[0].length;
  const point = intLen + Number(exp);
  const body = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : `${digits}${'0'.repeat(point - digits.length)}`;
  return neg ? `-${body}` : body;
}

test('rejects input that is not a fixed-point number', () => {
  for (const bad of ['', '.', 'abc', '1e5', '1,234.00', '1 2', null, undefined, NaN, Infinity]) {
    assert.throws(() => parseFixed(bad, amount), RangeError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('refuses to hand back a value that lost precision', () => {
  assert.throws(() => parseFixed('99999999999999999999', amount), RangeError);
  // 1e6 shares of a 1e8-scaled price is ~1e22 before scaling down; the product
  // must not be attempted as a float.
  assert.throws(() => marketValue(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => formatFixed(1.5, amount), RangeError);
  assert.throws(() => toFloat(1.5, amount), RangeError);
});

test('marketValue multiplies 1e8 shares by a 1e8 price into a 1e2 amount', () => {
  // 2 shares @ $41.235 = $82.47
  assert.equal(marketValue(200000000, 4123500000), 8247);
  // 10 shares @ $120.00 = $1200.00
  assert.equal(marketValue(1000000000, 12000000000), 120000);
  // Rounds half away from zero: 1 share @ $41.235 = $41.235 -> $41.24
  assert.equal(marketValue(100000000, 4123500000), 4124);
  // Zero shares is worth zero, whatever the price.
  assert.equal(marketValue(0, 4123500000), 0);
  // A short position is worth a negative amount.
  assert.equal(marketValue(-200000000, 4123500000), -8247);
});

test('marketValue stays exact where a float product would not', () => {
  // 0.00123456 BTC @ $41235.00. Exact answer via BigInt, no float anywhere.
  const btc = parseFixed('0.00123456', shares);
  const px = parseFixed('41235.00', price);
  const expected = Number((BigInt(btc) * BigInt(px) * 100n) / (10n ** 16n)); // -> 1e2 units, truncated
  const got = marketValue(btc, px);
  // Rounding may differ from truncation by at most one cent.
  assert.ok(got === expected || got === expected + 1, `${got} vs ${expected}`);
  // And the float route really is wrong, which is why this function exists.
  assert.equal(got, 5091);
});

test('convert applies a 1e8 FX rate to a 1e2 amount', () => {
  // €1000.00 at 1.0842 = $1084.20
  assert.equal(convert(100000, 108420000), 108420);
  assert.equal(convert(0, 108420000), 0);
  assert.equal(convert(-100000, 108420000), -108420);
  // Identity rate is exact.
  assert.equal(convert(123456, 100000000), 123456);
});

test('proportion removes cost exactly, leaving no dust on a full exit', () => {
  assert.equal(proportion(101000, 400000000, 1000000000), 40400);
  // Whole position out -> whole cost out.
  assert.equal(proportion(100991, 733333333, 733333333), 100991);
  assert.equal(proportion(0, 5, 10), 0);
  assert.throws(() => proportion(100, 1, 0), RangeError);
  // Negative denominator (a short) normalises rather than mis-rounding.
  assert.equal(proportion(1000, -1, -2), 500);
});

test('draining a position one sliver at a time returns exactly the cost put in', () => {
  // The drift-on-transaction-900 scenario: repeated proportional removal must
  // never leave a stray cent behind or invent one.
  let held = 1000000000; // 10 shares
  let cost = 100991;     // $1009.91
  let removed = 0;
  const slice = held / 1000;
  for (let i = 0; i < 1000; i += 1) {
    const c = proportion(cost, slice, held);
    removed += c;
    cost -= c;
    held -= slice;
  }
  assert.equal(held, 0);
  assert.equal(cost, 0);
  assert.equal(removed, 100991);
});

test('a 1000-transaction sum is exact where the float sum is not', () => {
  const units = parseFixed('12.34', amount);
  let total = 0;
  for (let i = 0; i < 1000; i += 1) total += units;
  assert.equal(total, 1234000);
  assert.equal(formatFixed(total, amount), '12340.00');

  // The float path this design exists to avoid. Note it is the *accumulation*
  // that drifts (12340.000000000115) — a single 1000 * 12.34 is correctly
  // rounded and looks fine, which is exactly why the bug surfaces on
  // transaction 900 rather than transaction 2.
  let drifted = 0;
  for (let i = 0; i < 1000; i += 1) drifted += 12.34;
  assert.notEqual(drifted, 12340);
});

test('a 1000-transaction sum of awkward amounts matches BigInt exactly', () => {
  const amounts = [];
  for (let i = 0; i < 1000; i += 1) amounts.push(`${i}.07`);
  const total = amounts.reduce((acc, a) => acc + parseFixed(a, amount), 0);
  const expected = Number(amounts.reduce((acc, a) => acc + BigInt(a.replace('.', '')), 0n));
  assert.equal(total, expected);
  // Sum of 0..999 = 499500 units of a dollar, plus 1000 x 7 cents.
  assert.equal(total, 499500 * 100 + 7000);
});

test('toFloat is the render boundary and nothing more', () => {
  assert.equal(toFloat(123456, amount), 1234.56);
  assert.equal(toFloat(0, amount), 0);
  assert.equal(toFloat(-1, amount), -0.01);
  assert.equal(toFloat(123456, shares), 0.00123456);
});
