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
    buildTxBody, txToForm, emptyTxForm, todayLocal, buildPriceChunk, defaultPortfolioId,
    deriveTxField, SECURITY_TYPES, SHARE_TYPES, SIGNED_TYPES,
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
                type: 'buy', date: '2024-03-15', accountId: 'acct_1', portfolioId: 'acct_depot',
                securityId: 'sec_1',
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
            type: 'sell', date: '2024-11-02', accountId: 'acct_1', portfolioId: 'acct_depot',
            securityId: 'sec_1',
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
            type: 'buy', date: '2020-01-31', accountId: 'a', portfolioId: 'd', securityId: 's',
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

describe('forms — shares x price = amount', () => {
    // A broker states shares and a price per share; `amount` is what we store.
    // The multiplication crosses §5's scales (1e8 x 1e8 -> 1e2), which is the
    // one place in this form where a wrong number is not a typo the user can
    // see — it is a cost basis that is quietly wrong forever.

    test('a four-decimal price keeps the cent a float multiply drops', () => {
        // 1310.9216 x 9754.6875 is exactly 12787630.545 — a half-cent TIE, and
        // money.js rounds half away from zero, so the answer is ...55. The
        // naive path a form would otherwise take (multiply the two as doubles,
        // toFixed(2)) computes 12787630.544999999925 and answers ...54. One
        // cent, on one trade, in the direction of an understated cost basis,
        // and nothing on screen says so.
        assert.equal(
            (1310.9216 * 9754.6875).toFixed(2), '12787630.54',
            'the float path this test exists to catch changed'
        );

        assert.equal(
            deriveTxField('amount', { type: 'buy', shares: '1310.9216', price: '9754.6875' }),
            '12787630.55'
        );
    });

    test('fees and taxes are INSIDE the derived amount, on the side the type puts them', () => {
        // portfolio.js: `amount` is the cash that moved — gross + fees + taxes
        // on a buy, gross - fees - taxes on a sell. Deriving the gross alone
        // would understate every commission-bearing buy.
        const trade = { shares: '1310.9216', price: '9754.6875', fees: '9.99', taxes: '1.50' };
        assert.equal(deriveTxField('amount', { ...trade, type: 'buy' }), '12787642.04');
        assert.equal(deriveTxField('amount', { ...trade, type: 'sell' }), '12787619.06');
    });

    test('shares + amount shows the implied price, fees taken back out', () => {
        // 200 shares of a 41.235 stock, 8.00 commission: 8247.00 gross, 8255.00
        // out of the account. The price the user is owed back is the gross one.
        const shares = '200';
        assert.equal(deriveTxField('price', { type: 'buy', shares, amount: '8247' }), '41.235');
        assert.equal(deriveTxField('price', { type: 'buy', shares, amount: '8255', fees: '8' }), '41.235');
        assert.equal(deriveTxField('price', { type: 'sell', shares, amount: '8239', fees: '8' }), '41.235');
    });

    test('the derived amount is the one that round-trips, not the derived price', () => {
        // Deriving back is NOT the identity when the product has a sub-cent
        // remainder, and that is correct: the stored amount is the rounded one
        // the user saw, so the price it implies is the price that actually
        // produced it. Nothing rounds twice, and nothing is stored unseen.
        const amount = deriveTxField('amount', { type: 'buy', shares: '1310.9216', price: '9754.6875' });
        assert.equal(amount, '12787630.55');
        assert.equal(
            deriveTxField('price', { type: 'buy', shares: '1310.9216', amount }),
            '9754.68750381'
        );
    });

    test('a half-typed form derives nothing rather than a wrong number', () => {
        assert.equal(deriveTxField('amount', { type: 'buy', shares: '', price: '10' }), '');
        assert.equal(deriveTxField('amount', { type: 'buy', shares: '10', price: '' }), '');
        assert.equal(deriveTxField('amount', { type: 'buy', shares: '10', price: '.' }), '');
        assert.equal(deriveTxField('price', { type: 'buy', shares: '0', amount: '100' }), '');
        assert.equal(deriveTxField('price', { type: 'buy', shares: '10', amount: '' }), '');
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
        const buy = { type: 'buy', date: '2024-03-15', accountId: 'a', portfolioId: 'd', amount: '100' };
        assert.ok(buildTxBody(buy).errors.some((e) => /needs a security/.test(e)));
        assert.ok(buildTxBody({ ...buy, securityId: 's' }).errors.some((e) => /Shares is required/.test(e)));
        assert.ok(buildTxBody({ ...buy, securityId: 's', shares: '0' }).errors.some((e) => /greater than zero/.test(e)));
        assert.deepEqual(buildTxBody({ ...buy, securityId: 's', shares: '1.5' }).errors, []);
    });

    test('a buy or sell carries the securities account the shares land in', () => {
        // §4: the trade names both accounts, and `portfolioId` is the one that
        // keys the position. Absent, portfolio.js raises `missing_portfolio`
        // and the holding is attributed to nothing — which is what every
        // manually entered trade did before this field was collected.
        for (const type of ['buy', 'sell']) {
            const trade = {
                type, date: '2024-03-15', accountId: 'acct_cash', securityId: 'sec_1',
                shares: '10', amount: '100',
            };
            assert.ok(
                buildTxBody(trade).errors.some((e) => /securities account/.test(e)),
                `${type} accepted no portfolioId`
            );
            const { body, errors } = buildTxBody({ ...trade, portfolioId: 'acct_depot' });
            assert.deepEqual(errors, []);
            assert.equal(body.portfolioId, 'acct_depot');
        }
    });

    test('a dividend may name a depot but is not required to', () => {
        // PP's own model has no depot on a dividend, so requiring one would
        // refuse a record the importer legitimately writes. When it IS named,
        // the engine attributes the income to that position instead of falling
        // back to "the only position holding this security".
        const div = {
            type: 'dividend', date: '2024-03-15', accountId: 'acct_cash',
            securityId: 'sec_1', amount: '12.34',
        };
        assert.deepEqual(buildTxBody(div).errors, []);
        assert.equal(buildTxBody(div).body.portfolioId, undefined);
        assert.equal(buildTxBody({ ...div, portfolioId: 'acct_depot' }).body.portfolioId, 'acct_depot');
    });

    test('the cash leg and the shares leg cannot be the same account', () => {
        // §4 splits them by account kind, so one record cannot be both. The
        // pickers offer each kind in one place only; this is the half of that
        // rule a pure function can check.
        const { errors } = buildTxBody({
            type: 'buy', date: '2024-03-15', accountId: 'acct_1', portfolioId: 'acct_1',
            securityId: 'sec_1', shares: '1', amount: '100',
        });
        assert.ok(errors.some((e) => /same account/.test(e)), errors.join(' | '));
    });

    test('an imported portfolioId survives an edit untouched', () => {
        // The PP importer writes portfolioId; a form that renders a record and
        // drops a field it did not collect corrupts that record on a no-op
        // save. Same class of bug as overwriting `currency` with the reporting
        // currency, which silently re-attributed nothing and misvalued a
        // portfolio. Two passes, because a fixed point is the actual property.
        const imported = {
            type: 'buy', date: '2021-06-07', accountId: 'account_pp_cash',
            portfolioId: 'account_pp_depot', securityId: 'security_pp_1',
            shares: 100000000, amount: 50000, currency: 'EUR',
        };
        const once = buildTxBody(txToForm(imported)).body;
        assert.equal(once.portfolioId, 'account_pp_depot');
        assert.deepEqual(buildTxBody(txToForm(once)).body, imported);
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

describe('forms — which depot a form opens on', () => {
    test('a new transaction prefills the only securities account, and never one of two', () => {
        assert.equal(defaultPortfolioId({ depotIds: ['d1'] }), 'd1');
        assert.equal(defaultPortfolioId({ depotIds: ['d1', 'd2'] }), '');
        assert.equal(defaultPortfolioId({ depotIds: [] }), '');
    });

    test('a stored value wins over the prefill, in both directions', () => {
        assert.equal(defaultPortfolioId({ stored: 'd2', depotIds: ['d1'] }), 'd2');
        assert.equal(defaultPortfolioId({ stored: 'd2', depotIds: ['d1'], editing: true }), 'd2');
    });

    test('an edit never invents a depot the record did not have', () => {
        // Found by codex review. `portfolioId` is optional on a dividend, so
        // prefilling the only depot when editing means pressing Save on an
        // untouched imported record writes an attribution the user never made
        // — and portfolio.js then books the income to a freshly created
        // zero-share position at that depot instead of to the position that
        // actually holds the shares. A no-op save must move nothing.
        assert.equal(defaultPortfolioId({ stored: '', depotIds: ['d1'], editing: true }), '');
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

    test('every buildTxBody call site collects portfolioId', () => {
        // Same shape of guard, and for the same reason: the field is read off a
        // DOM picker inside save(), and with no jsdom the alternative is a
        // fixture that restates the fix and stays green when it is reverted.
        //
        // Asserted on the ARGUMENT OBJECT, not the file: a screen that merely
        // mentions portfolioId somewhere while handing buildTxBody a body
        // without it writes exactly the unattributed trade this bead is about.
        const dir = path.join(REPO_ROOT, 'web/static/js/features');
        const offenders = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.js')) continue;
            const source = fs.readFileSync(path.join(dir, name), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/[^\n]*$/gm, '');
            for (const call of source.matchAll(/\bbuildTxBody\s*\(\s*\{[\s\S]*?\n\s*\}\)/g)) {
                if (!/\bportfolioId\b/.test(call[0])) offenders.push(name);
            }
        }
        assert.deepEqual(
            offenders,
            [],
            '§4: a buy/sell names both accounts, so the transaction body handed to '
            + `buildTxBody must carry portfolioId: ${offenders.join(', ')}`
        );
    });

    test('defaultPortfolioId is always told whether the form is an edit', () => {
        // The prefill is only safe on a new transaction (see the unit tests
        // above). A call site that omits `editing` silently gets the new-form
        // behaviour on an edit, which writes a depot the record never had —
        // and that lives in the same DOM-bound handler, out of reach of a
        // behavioural test.
        const dir = path.join(REPO_ROOT, 'web/static/js/features');
        const offenders = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.js') || name === 'forms.js') continue;
            const source = fs.readFileSync(path.join(dir, name), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/[^\n]*$/gm, '');
            for (const call of source.matchAll(/\bdefaultPortfolioId\s*\(\s*\{[\s\S]*?\n\s*\}\)/g)) {
                if (!/\bediting\b/.test(call[0])) offenders.push(name);
            }
        }
        assert.deepEqual(offenders, [], `${offenders.join(', ')} must pass \`editing\` to defaultPortfolioId`);
    });
});
