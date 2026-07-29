/**
 * features.forms.test.js
 *
 * The money rule, tested where it can actually break: the edit form.
 *
 * ARCHITECTURE.md §5 says values become floats exactly once, at the render
 * boundary, and never flow back. The failure mode that rule exists for is not
 * theoretical — it is an edit form that renders a stored integer, lets the user
 * change one unrelated field, and parses its own rendered output back through a
 * float. Every amount in the portfolio then drifts by a cent per edit, silently,
 * and only shows up as a reconciliation that no longer balances.
 *
 * So the load-bearing case here is the round trip: record → txToForm →
 * buildTxBody must be the identity on every money field, for values chosen to
 * be exactly the ones a double gets wrong.
 *
 * No DOM: forms.js is deliberately free of it, which is why this can run under
 * `node --test` in a project with no npm dependencies.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildTxBody, txToForm, emptyTxForm, todayLocal, buildPriceChunk,
    SECURITY_TYPES, SHARE_TYPES, SIGNED_TYPES,
} from '../features/forms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('forms — the money round trip', () => {
    // Every one of these is a value that loses a cent through a double at some
    // point in a naive implementation: 1.005 does not round-trip through
    // toFixed(2), 0.1+0.2 is the canonical float example, and the last two are
    // large enough that float64 has no cent-level precision left at all.
    const AMOUNTS = [1, -1, 100, 123456, 100500, 30000000000000, 999999999999999];
    const SHARES = [1, 123456, 100000000, 12345678901234];

    for (const amount of AMOUNTS) {
        test(`amount ${amount} survives record → form → record`, () => {
            const record = {
                type: 'deposit', date: '2024-03-15', accountId: 'acct_1',
                amount: Math.abs(amount), currency: 'EUR',
            };
            const { body, errors } = buildTxBody(txToForm(record));
            assert.deepEqual(errors, []);
            assert.equal(body.amount, Math.abs(amount));
            // Not just equal — still an integer. A float that happens to print
            // the same would pass an == check and fail everything downstream.
            assert.ok(Number.isSafeInteger(body.amount));
        });
    }

    for (const shares of SHARES) {
        test(`share count ${shares} survives record → form → record`, () => {
            const record = {
                type: 'buy', date: '2024-03-15', accountId: 'acct_1', securityId: 'sec_1',
                shares, amount: 123456, fees: 199, taxes: 0, currency: 'EUR',
            };
            const { body, errors } = buildTxBody(txToForm(record));
            assert.deepEqual(errors, []);
            assert.equal(body.shares, shares);
            assert.ok(Number.isSafeInteger(body.shares));
        });
    }

    test('trailing zeros are trimmed for the input but re-parse to the same integer', () => {
        // "10.00000000" in an 8-decimal shares field is a typo waiting to
        // happen on a phone keyboard. Trimming is only legal because it is not
        // rounding — parseFixed pads the fraction back out.
        const form = txToForm({
            type: 'buy', date: '2024-01-01', accountId: 'a', securityId: 's',
            shares: 1000000000, amount: 1000000, fees: 500,
        });
        assert.equal(form.shares, '10');
        assert.equal(form.amount, '10000.00');   // cash keeps its two decimals
        assert.equal(form.fees, '5.00');
        const { body } = buildTxBody(form);
        assert.equal(body.shares, 1000000000);
        assert.equal(body.amount, 1000000);
        assert.equal(body.fees, 500);
    });

    test('a share count with real precision keeps every digit', () => {
        const form = txToForm({
            type: 'buy', date: '2024-01-01', accountId: 'a', securityId: 's',
            shares: 123456, amount: 100,
        });
        assert.equal(form.shares, '0.00123456');
        assert.equal(buildTxBody(form).body.shares, 123456);
    });

    test('a full record round-trips field for field, including fees and taxes', () => {
        const record = {
            type: 'sell', date: '2024-11-02', accountId: 'acct_1', securityId: 'sec_1',
            shares: 250000000, amount: 1000050, fees: 995, taxes: 1234,
            currency: 'EUR', note: 'partial exit',
        };
        const { body, errors } = buildTxBody(txToForm(record));
        assert.deepEqual(errors, []);
        assert.deepEqual(body, record);
    });

    test('re-opening and saving an untouched form changes nothing', () => {
        // The regression this guards: an edit form that "normalises" what it
        // renders. Two passes must be a fixed point, or every open-and-close
        // cycle moves the portfolio.
        const record = {
            type: 'buy', date: '2020-01-31', accountId: 'a', securityId: 's',
            shares: 3, amount: 7, fees: 1, taxes: 2, currency: 'USD',
        };
        const once = buildTxBody(txToForm(record)).body;
        const twice = buildTxBody(txToForm(once)).body;
        assert.deepEqual(twice, once);
        assert.deepEqual(once, record);
    });

    test('display text is rejected, not silently parsed', () => {
        // fmt.money() emits "1,234.56". If that ever reaches a form, the
        // grouping separator must make it fail loudly rather than parse as 1.
        const { errors } = buildTxBody({
            type: 'deposit', date: '2024-01-01', accountId: 'a', amount: '1,234.56',
        });
        assert.ok(errors.some((e) => /not a number/.test(e)), errors.join(' | '));
    });

    test('sub-cent input rounds once, at parse, and never compounds', () => {
        const { body } = buildTxBody({
            type: 'deposit', date: '2024-01-01', accountId: 'a', amount: '10.005',
        });
        assert.equal(body.amount, 1001); // half away from zero, money.js's rule
        assert.equal(buildTxBody(txToForm({ ...body, type: 'deposit', date: '2024-01-01', accountId: 'a' })).body.amount, 1001);
    });
});

describe('forms — §4 validation', () => {
    const base = { type: 'deposit', date: '2024-03-15', accountId: 'acct_1', amount: '100' };

    test('every transaction needs an account — §4 has no per-type branching', () => {
        const { errors } = buildTxBody({ ...base, accountId: '' });
        assert.ok(errors.some((e) => /account/i.test(e)));
    });

    test('an unparseable date is refused rather than rolled forward', () => {
        for (const date of ['', '15/03/2024', '2024-3-15', 'today']) {
            const { errors } = buildTxBody({ ...base, date });
            assert.ok(errors.some((e) => /YYYY-MM-DD/.test(e)), `accepted ${JSON.stringify(date)}`);
        }
    });

    test('a negative amount is legal only on fee / tax / interest', () => {
        for (const type of ['fee', 'tax', 'interest']) {
            const { errors } = buildTxBody({ ...base, type, amount: '-25' });
            assert.deepEqual(errors, [], `${type} should allow a refund/charge`);
        }
        for (const type of ['deposit', 'removal']) {
            const { errors } = buildTxBody({ ...base, type, amount: '-25' });
            assert.ok(errors.some((e) => /negative amount/i.test(e)), `${type} accepted a negative amount`);
        }
    });

    test('SIGNED_TYPES is exactly the cash-only set §4 names', () => {
        assert.deepEqual([...SIGNED_TYPES].sort(), ['fee', 'interest', 'tax']);
    });

    test('a buy or sell needs a security and a positive share count', () => {
        const buy = { type: 'buy', date: '2024-03-15', accountId: 'a', amount: '100' };
        assert.ok(buildTxBody(buy).errors.some((e) => /needs a security/.test(e)));
        assert.ok(buildTxBody({ ...buy, securityId: 's' }).errors.some((e) => /Shares is required/.test(e)));
        assert.ok(buildTxBody({ ...buy, securityId: 's', shares: '0' }).errors.some((e) => /greater than zero/.test(e)));
        assert.deepEqual(buildTxBody({ ...buy, securityId: 's', shares: '1.5' }).errors, []);
    });

    test('a security transfer is refused at the form, not stored to fail later', () => {
        // §4: not representable in v1 — there is no way to express carried-over
        // cost basis, and portfolio.js refuses them with an explicit issue.
        const { errors } = buildTxBody({
            type: 'transfer_in', date: '2024-03-15', accountId: 'a', securityId: 's', amount: '10',
        });
        assert.ok(errors.some((e) => /Security transfers/.test(e)));
    });

    test('a cash type drops a stray securityId rather than storing it', () => {
        const { body, errors } = buildTxBody({ ...base, securityId: 'sec_1' });
        assert.deepEqual(errors, []);
        assert.equal(body.securityId, undefined);
    });

    test('the type sets agree with what the screens hide', () => {
        assert.deepEqual([...SECURITY_TYPES].sort(), ['buy', 'dividend', 'sell']);
        assert.deepEqual([...SHARE_TYPES].sort(), ['buy', 'sell']);
    });
});

describe('forms — form defaults', () => {
    test('todayLocal reads the LOCAL calendar day, not the UTC one', () => {
        // 2024-03-15T23:30 local is 2024-03-16 UTC in a positive-offset zone.
        // The form must offer the day the user's own calendar shows; only
        // web/domain/ is UTC by fiat.
        const local = new Date(2024, 2, 15, 23, 30, 0);
        assert.equal(todayLocal(local), '2024-03-15');
        const newYear = new Date(2025, 0, 1, 0, 5, 0);
        assert.equal(todayLocal(newYear), '2025-01-01');
    });

    test('a new form is a buy, dated today, with every money field blank', () => {
        const form = emptyTxForm();
        assert.equal(form.type, 'buy');
        assert.match(form.date, /^\d{4}-\d{2}-\d{2}$/);
        for (const key of ['amount', 'shares', 'fees', 'taxes']) assert.equal(form[key], '');
    });

    test('defaults prefill without losing the blank money fields', () => {
        const form = emptyTxForm({ type: 'buy', securityId: 'sec_9' });
        assert.equal(form.securityId, 'sec_9');
        assert.equal(form.amount, '');
    });
});

describe('forms — price chunks (§4 per-security-year storage)', () => {
    test('the MM-DD key is zero-padded, so the latest-close race is won by the latest date', () => {
        // portfolio.js picks the newest close by STRING comparison. Unpadded,
        // "3-15" > "12-31" and a March price would shadow every December one
        // for the rest of the security's life.
        const { body } = buildPriceChunk({ securityId: 's', day: '2024-03-05', closeUnits: 100 });
        assert.deepEqual(Object.keys(body.closes), ['03-05']);
    });

    test('an existing year is merged, not replaced', () => {
        const existing = { securityId: 's', year: '2024', closes: { '01-02': 1, '06-30': 2 } };
        const { body } = buildPriceChunk({ existing, securityId: 's', day: '2024-12-31', closeUnits: 3 });
        assert.deepEqual(body.closes, { '01-02': 1, '06-30': 2, '12-31': 3 });
    });

    test('re-entering the same day overwrites that day only', () => {
        const existing = { securityId: 's', year: '2024', closes: { '01-02': 1, '06-30': 2 } };
        const { body } = buildPriceChunk({ existing, securityId: 's', day: '2024-06-30', closeUnits: 99 });
        assert.deepEqual(body.closes, { '01-02': 1, '06-30': 99 });
    });

    test('the record id is deterministic per security-year, so a price updates in place', () => {
        const a = buildPriceChunk({ securityId: 'sec_1', day: '2024-01-01', closeUnits: 1 });
        const b = buildPriceChunk({ securityId: 'sec_1', day: '2024-09-09', closeUnits: 2 });
        assert.equal(a.recordId, b.recordId);
        assert.equal(a.recordId, 'price_sec_1_2024');
        assert.notEqual(a.recordId, buildPriceChunk({ securityId: 'sec_1', day: '2025-01-01', closeUnits: 1 }).recordId);
    });

    test('year is the 4-digit value portfolio.js demands', () => {
        // A missing or malformed year makes portfolio.js raise
        // price_not_chunked and drop the record entirely.
        const { body } = buildPriceChunk({ securityId: 's', day: '2024-03-05', closeUnits: 100 });
        assert.match(String(body.year), /^\d{4}$/);
    });

    test('a non-integer or non-positive close is refused', () => {
        assert.ok(buildPriceChunk({ securityId: 's', day: '2024-01-01', closeUnits: 1.5 }).errors.length > 0);
        assert.ok(buildPriceChunk({ securityId: 's', day: '2024-01-01', closeUnits: 0 }).errors.length > 0);
        assert.ok(buildPriceChunk({ securityId: 's', day: 'nope', closeUnits: 1 }).errors.length > 0);
        assert.ok(buildPriceChunk({ securityId: '', day: '2024-01-01', closeUnits: 1 }).errors.length > 0);
    });
});

describe('forms — the render boundary stays one-way', () => {
    test('no feature module imports toFloat', () => {
        // toFloat is THE render boundary (§5) and its result must never re-enter
        // a record. The screens have no legitimate use for it — every display
        // path goes through formatFixed, which yields an exact string. Importing
        // it anywhere under features/ is the first step of the bug this whole
        // test file exists for, so it is banned outright rather than reviewed.
        const dir = path.join(REPO_ROOT, 'web/static/js/features');
        const offenders = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.js')) continue;
            const source = fs.readFileSync(path.join(dir, name), 'utf8')
                // Prose about the rule is not a violation of it.
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/[^\n]*$/gm, '');
            if (/\btoFloat\b/.test(source)) offenders.push(name);
        }
        assert.deepEqual(
            offenders,
            [],
            `web/static/js/features must render money through formatFixed, never toFloat: ${offenders.join(', ')}`
        );
    });

    test('a transaction body preserves its own currency, never the reporting one', () => {
        // A transaction carries the currency the money actually moved in. The
        // reporting currency is a *display* preference, and overwriting a
        // record with it silences portfolio.js's `currency_not_converted`
        // issue — the engine then adds an imported USD amount straight into a
        // EUR total. A silent misvaluation, triggered by opening a form and
        // pressing Save with nothing changed.
        //
        // A source guard rather than a behavioural test on purpose: the bug
        // lives in a DOM-bound save() handler, and with no jsdom the only other
        // option is to restate the fix in a fixture and assert the restatement
        // — which passes whether or not the shipped code is correct. That is
        // what the first attempt at covering this did, and it stayed green with
        // the fix reverted.
        //
        // Scoped to the buildTxBody call rather than banning the token
        // outright: a NEW account or security legitimately defaults to the
        // reporting currency, because there is no prior value to erase and
        // nothing better to guess. Only the transaction path is the bug.
        // Revisit when B8 lands real conversion.
        const dir = path.join(REPO_ROOT, 'web/static/js/features');
        const offenders = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.js')) continue;
            const source = fs.readFileSync(path.join(dir, name), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/[^\n]*$/gm, '');
            // `buildTxBody({` is a call site; forms.js's own
            // `export function buildTxBody(values)` declaration is not.
            if (!/\bbuildTxBody\s*\(\s*\{/.test(source)) continue;
            // The body handed to buildTxBody must carry the transaction's own
            // currency. `values.currency || reportingCurrency()` is fine — the
            // fallback only applies when there is nothing to preserve.
            if (!/\bcurrency\s*:\s*values\.currency\b/.test(source)) offenders.push(name);
        }
        assert.deepEqual(
            offenders,
            [],
            'a transaction body must pass its own currency to buildTxBody, not the '
            + `reporting currency: ${offenders.join(', ')}`
        );
    });
});
