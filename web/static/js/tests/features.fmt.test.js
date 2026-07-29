/**
 * features.fmt.test.js
 *
 * fmt.js is the render boundary (ARCHITECTURE.md §5). Two things must hold and
 * both have a way of quietly breaking:
 *
 *  1. Formatting is exact. Grouping "1234567.89" must not go anywhere near a
 *     double, and a value past float64's cent-level precision must still print
 *     every digit it stores.
 *  2. Gain and loss are never encoded by colour alone. deltaClass is the only
 *     thing a screen may use to say "this is a gain", and the ▲/▼/— glyph rides
 *     on those class names from CSS. A screen that colours a bare number
 *     instead fails for roughly 1 in 12 men, and it is the single most common
 *     accessibility defect in finance UIs.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fmt from '../features/fmt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('fmt — money', () => {
    test('renders cents exactly, with thousands grouping', () => {
        assert.equal(fmt.money(0), '0.00');
        assert.equal(fmt.money(5), '0.05');
        assert.equal(fmt.money(123456), '1,234.56');
        assert.equal(fmt.money(-123456), '-1,234.56');
        assert.equal(fmt.money(100000000), '1,000,000.00');
    });

    test('keeps every digit past the point a double would round', () => {
        // 9007199254740991 cents is €90,071,992,547,409.91 — the last safe
        // integer. Anything that touched a float on the way here would print a
        // different final digit.
        assert.equal(fmt.money(9007199254740991), '90,071,992,547,409.91');
    });

    test('an unknown value is the em dash, never 0.00', () => {
        // A missing price and a zero balance are different facts. Rendering
        // both as "0.00" is how an unpriced position reads as a total loss.
        for (const v of [null, undefined, NaN, 1.5, 'x']) assert.equal(fmt.money(v), fmt.UNKNOWN);
    });

    test('signedMoney marks positives explicitly', () => {
        assert.equal(fmt.signedMoney(12840), '+128.40');
        assert.equal(fmt.signedMoney(-6420), '-64.20');
        assert.equal(fmt.signedMoney(0), '0.00');
    });
});

describe('fmt — shares and prices', () => {
    test('trailing zeros are trimmed without touching the digits', () => {
        assert.equal(fmt.shares(1000000000), '10');
        assert.equal(fmt.shares(150000000), '1.5');
        assert.equal(fmt.shares(123456), '0.00123456');  // 0.00123456 BTC
        assert.equal(fmt.shares(1), '0.00000001');       // one satoshi survives
    });

    test('a price keeps at least two decimals', () => {
        assert.equal(fmt.price(4123500000), '41.235');
        assert.equal(fmt.price(100000000), '1.00');
        assert.equal(fmt.price(1), '0.00000001');
    });
});

describe('fmt — gain/loss is structural, not chromatic', () => {
    test('deltaClass maps sign to the three delta modifiers', () => {
        assert.equal(fmt.deltaClass(1), 'wg-delta--gain');
        assert.equal(fmt.deltaClass(-1), 'wg-delta--loss');
        assert.equal(fmt.deltaClass(0), 'wg-delta--flat');
    });

    test('an unknown value is flat, not a loss', () => {
        for (const v of [null, undefined, NaN, Infinity, 'x']) {
            assert.equal(fmt.deltaClass(v), 'wg-delta--flat');
        }
    });

    test('each class the screens can emit has a CSS ::before glyph behind it', () => {
        // The contract fmt.deltaClass depends on: its return value is only
        // meaningful because styles.css attaches ▲/▼/— to it. If a rename ever
        // split the two, every gain/loss signal in the app would silently
        // become colour-only.
        const css = fs.readFileSync(path.join(REPO_ROOT, 'web/static/css/styles.css'), 'utf8');
        for (const variant of ['gain', 'loss', 'flat']) {
            assert.equal(fmt.deltaClass(variant === 'gain' ? 1 : variant === 'loss' ? -1 : 0), `wg-delta--${variant}`);
            const rule = new RegExp(`\\.wg-delta--${variant}::before\\s*\\{[^}]*content:\\s*'[^']+'`);
            assert.match(css, rule, `.wg-delta--${variant}::before has no glyph`);
        }
    });
    // Colours-from-JS is not re-tested here: architecture.design-tokens.test.js
    // already bans every --wg-* reference across web/static/js, features
    // included, and a second copy of that scan would only ever drift from it.
});

describe('fmt — ratios and proportions', () => {
    test('percent formats a perf.js ratio, signed', () => {
        assert.equal(fmt.percent(0.0241), '+2.41%');
        assert.equal(fmt.percent(-0.0108), '-1.08%');
        assert.equal(fmt.percent(0), '0.00%');
        assert.equal(fmt.percent(null), fmt.UNKNOWN);
        assert.equal(fmt.percent(Infinity), fmt.UNKNOWN);
    });

    test('a share of a total is computed from the two integers, exactly', () => {
        assert.equal(fmt.sharePercent(2500, 10000), '25.00%');
        assert.equal(fmt.sharePercent(1, 3), '33.33%');
        assert.equal(fmt.sharePercent(1, 0), fmt.UNKNOWN);
    });

    test('bar widths come back as clamped basis points', () => {
        assert.equal(fmt.shareBasisPoints(2500, 10000), 2500);
        assert.equal(fmt.shareBasisPoints(0, 10000), 0);
        assert.equal(fmt.shareBasisPoints(10, 0), 0);
        // A position worth more than the total it is measured against (possible
        // with an overdrawn cash account) must not overflow the track.
        assert.equal(fmt.shareBasisPoints(200, 100), 10000);
    });
});

describe('fmt — position labels', () => {
    test('names a position from whatever identity the engine supplies', () => {
        assert.equal(fmt.positionLabel({ ticker: 'VWCE', name: 'FTSE All-World' }), 'VWCE · FTSE All-World');
        assert.equal(fmt.positionLabel({ ticker: 'VWCE' }), 'VWCE');
        assert.equal(fmt.positionLabel({ name: 'FTSE All-World' }), 'FTSE All-World');
        assert.equal(fmt.positionLabel({ securityId: 'sec_1' }), 'sec_1');
        assert.equal(fmt.positionLabel({}), fmt.UNKNOWN);
        assert.equal(fmt.positionLabel(null), fmt.UNKNOWN);
    });

    test('a position is opaque — two positions of the same security both label', () => {
        // Positions are keyed by (accountId, securityId), so the same ETF held
        // at two brokers is two positions. Nothing here dedupes or keys by
        // securityId, so that stayed a label change in one function rather
        // than a rewrite of Holdings and Dashboard.
        const a = { securityId: 'sec_1', ticker: 'VWCE', name: 'FTSE All-World' };
        const b = { securityId: 'sec_1', ticker: 'VWCE', name: 'FTSE All-World' };
        assert.equal(fmt.positionLabel(a), fmt.positionLabel(b));
    });

    test('the broker is part of the name, so two depots do not render alike', () => {
        // Two rows on Holdings and two bars on the allocation with the same
        // text read as a duplicate-rendering bug, not as two real holdings.
        const at = (accountName) => fmt.positionLabel({
            securityId: 'sec_1', ticker: 'VWCE', name: 'FTSE All-World', accountName,
        });
        assert.equal(at('Trade Republic'), 'VWCE · FTSE All-World · Trade Republic');
        assert.notEqual(at('Trade Republic'), at('Scalable'));
        // §4's unattributed position has no account, and says nothing rather
        // than inventing a broker name for it.
        assert.equal(fmt.positionLabel({ ticker: 'VWCE', accountName: null }), 'VWCE');
    });
});

describe('fmt — transaction type labels', () => {
    test('every §4 transaction type has a human label', () => {
        const schema = fs.readFileSync(path.join(REPO_ROOT, 'web/domain/schema.js'), 'utf8');
        const block = schema.match(/export const TX_TYPES\s*=\s*\[([\s\S]*?)\]/);
        assert.ok(block, 'TX_TYPES not found in schema.js');
        const types = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        assert.ok(types.length >= 10);
        for (const type of types) {
            const label = fmt.txTypeLabel(type);
            assert.notEqual(label, type, `${type} falls through to its raw id`);
            assert.match(label, /^[A-Z]/);
        }
    });
});
