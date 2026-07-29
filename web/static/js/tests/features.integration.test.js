/**
 * features.integration.test.js
 *
 * The bead's acceptance criterion, minus the pixels: "add / edit / delete a
 * transaction and see holdings and performance update".
 *
 * What this exercises is the whole seam — the exact values a screen collects,
 * through the exact translation the form does, through the real §3 records
 * port contract, into the real portfolio and performance engines, and back out
 * as the exact strings a row renders. Nothing is mocked except the storage
 * itself, which is a 20-line in-memory implementation of the three-method port
 * (a Dexie double would test Dexie, not this).
 *
 * The DOM is not exercised — this project has no jsdom and no npm dependencies
 * — so what a browser draws is verified by hand, not here. What IS verified
 * here is every number that would be drawn, which is the half that can be
 * wrong without anyone noticing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTxBody, txToForm, buildPriceChunk } from '../features/forms.js';
import * as fmt from '../features/fmt.js';
import { createPortfolioDomain } from '../../../domain/portfolio.js';
import { createPerformanceDomain } from '../../../domain/perf.js';
import { RECORD } from '../../../domain/schema.js';

/**
 * The §3 port, in memory. Same three methods, same field ownership (the port
 * stamps recordId/recordType/clientTs/deleted, bodies never carry them), same
 * tombstone-not-delete semantics.
 */
function memoryRecords() {
    const rows = new Map();
    let clock = 1;
    return {
        async list(recordType) {
            return [...rows.values()].filter((r) => r.recordType === recordType && r.deleted !== true);
        },
        async put(recordType, recordId, body) {
            rows.set(recordId, { ...body, recordId, recordType, deleted: false, clientTs: clock++ });
        },
        async del(recordType, recordId) {
            rows.set(recordId, { recordId, recordType, deleted: true, clientTs: clock++ });
        },
        _raw: rows,
    };
}

async function fixture() {
    const records = memoryRecords();
    const portfolio = createPortfolioDomain({ records });
    const performance = createPerformanceDomain({ records });
    await records.put(RECORD.account, 'acct_cash', {
        name: 'Broker cash', kind: 'cash', currency: 'EUR', closed: false,
    });
    // §4: the shares leg. A trade names both, and this is the one that keys the
    // position — the fixture has always needed it, it just had nowhere to say so.
    await records.put(RECORD.account, 'acct_depot', {
        name: 'Broker depot', kind: 'securities', currency: 'EUR', closed: false,
    });
    await records.put(RECORD.security, 'sec_vwce', {
        name: 'FTSE All-World', ticker: 'VWCE', currency: 'EUR', quote: {},
    });
    return { records, portfolio, performance };
}

/** What the Add-transaction modal hands to forms.js — plain strings. */
const DEPOSIT_FORM = {
    type: 'deposit', date: '2024-01-02', accountId: 'acct_cash',
    amount: '10000.00', currency: 'EUR',
};
const BUY_FORM = {
    type: 'buy', date: '2024-03-15', accountId: 'acct_cash', portfolioId: 'acct_depot',
    securityId: 'sec_vwce',
    shares: '10', amount: '1234.56', fees: '4.56', taxes: '', currency: 'EUR',
};

describe('screens → engine: adding a transaction', () => {
    test('a deposit typed into the form lands as cash the dashboard can total', async () => {
        const { records, portfolio } = await fixture();
        const { body, errors } = buildTxBody(DEPOSIT_FORM);
        assert.deepEqual(errors, []);
        await records.put(RECORD.transaction, 'tx_1', body);

        const snap = await portfolio.snapshot();
        assert.equal(snap.totals.cash, 1000000);
        assert.equal(snap.totals.total, 1000000);
        // …and the string the dashboard tile actually shows.
        assert.equal(fmt.money(snap.totals.total), '10,000.00');
    });

    test('a buy opens a position, moves cash, and capitalises fees into basis', async () => {
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);

        const snap = await portfolio.snapshot();
        assert.equal(snap.positions.length, 1);
        const [position] = snap.positions;
        assert.equal(position.securityId, 'sec_vwce');
        assert.equal(position.shares, 1000000000);          // 10, at 1e8
        // §4: cost += amount − taxes, so the €4.56 fee IS in the basis and the
        // €0 tax is not. That is the line that changes every gain number.
        assert.equal(position.cost, 123456);
        assert.equal(snap.totals.cash, 1000000 - 123456);
        // No price yet: an unpriced position has no market value and says so.
        assert.equal(position.marketValue, null);
        assert.equal(fmt.money(position.marketValue), fmt.UNKNOWN);
        assert.ok(snap.issues.some((i) => i.code === 'no_price'));
    });

    test('a trade entered in the form is attributed to a depot, not to nothing', async () => {
        // The bug this bead is: the form collected only the cash account, so
        // §4's position key had a null securities account, portfolio.js raised
        // `missing_portfolio` on every manually entered trade, and Holdings
        // showed a holding that belonged to no broker. Asserted through the
        // real engine on the real form output, so it fails if the form stops
        // collecting the field OR if the engine stops reading it.
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);

        const snap = await portfolio.snapshot();
        assert.deepEqual(snap.issues.filter((i) => i.code === 'missing_portfolio'), []);
        const [position] = snap.positions;
        assert.equal(position.accountId, 'acct_depot');
        assert.equal(position.accountName, 'Broker depot');
        // …and the row says which broker, so a second depot holding the same
        // ETF does not render as a duplicate of the first.
        assert.equal(fmt.positionLabel(position), 'VWCE · FTSE All-World · Broker depot');
    });

    test('the same security at two brokers is two positions with two labels', async () => {
        const { records, portfolio } = await fixture();
        await records.put(RECORD.account, 'acct_depot2', {
            name: 'Second depot', kind: 'securities', currency: 'EUR', closed: false,
        });
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);
        await records.put(RECORD.transaction, 'tx_3', buildTxBody({
            ...BUY_FORM, portfolioId: 'acct_depot2', date: '2024-04-01', amount: '600.00', shares: '5',
        }).body);

        const snap = await portfolio.snapshot();
        assert.equal(snap.positions.length, 2);
        const labels = snap.positions.map(fmt.positionLabel);
        assert.equal(new Set(labels).size, 2, `two rows rendered identically: ${labels.join(' | ')}`);
    });

    test('entering a close gives the position a value and a live gain', async () => {
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);

        // What the Holdings "Set price" modal does: 150.00 at 1e8.
        const chunk = buildPriceChunk({
            securityId: 'sec_vwce', day: '2024-03-15', closeUnits: 15000000000,
        });
        assert.deepEqual(chunk.errors, []);
        await records.put(RECORD.price, chunk.recordId, chunk.body);

        const snap = await portfolio.snapshot();
        const [position] = snap.positions;
        assert.equal(position.marketValue, 150000);        // €1,500.00
        assert.equal(position.unrealized, 150000 - 123456);
        assert.equal(snap.totals.total, (1000000 - 123456) + 150000);

        // The exact row a user reads.
        assert.equal(fmt.money(position.marketValue), '1,500.00');
        assert.equal(fmt.signedMoney(position.unrealized), '+265.44');
        assert.equal(fmt.deltaClass(position.unrealized), 'wg-delta--gain');
        assert.equal(fmt.sharePercent(position.unrealized, position.cost), '21.50%');
        assert.equal(fmt.money(snap.totals.total), '10,265.44');
    });
});

describe('screens → engine: editing a transaction', () => {
    test('reopening a stored transaction and saving it unchanged moves no number', async () => {
        // The corruption this whole layer is built to prevent: an edit form
        // that renders a stored integer and parses its own output back through
        // a float. Everything would still *look* right — the drift is a cent
        // per edit — so it is asserted on the totals, not just the field.
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);
        const before = await portfolio.snapshot();

        for (let i = 0; i < 5; i += 1) {
            const stored = (await records.list(RECORD.transaction)).find((r) => r.recordId === 'tx_2');
            const { body, errors } = buildTxBody(txToForm(stored));
            assert.deepEqual(errors, []);
            await records.put(RECORD.transaction, 'tx_2', body);
        }

        const after = await portfolio.snapshot();
        assert.deepEqual(after.totals, before.totals);
        assert.equal(after.positions[0].cost, before.positions[0].cost);
        assert.equal(after.positions[0].shares, before.positions[0].shares);
    });

    test('an imported foreign-currency transaction keeps its currency through an edit', async () => {
        // Found by codex review. Rewriting `currency` to the reporting currency
        // on save silences portfolio.js's `currency_not_converted` issue, and
        // the engine then adds the USD amount straight into the EUR total —
        // a silent misvaluation caused by opening a form and pressing Save.
        // Multi-currency conversion is B8; until then the engine warns, and the
        // form must not erase what it warns about.
        const { records, portfolio } = await fixture();
        await records.put(RECORD.settings, 'settings', { reportingCurrency: 'EUR' });
        await records.put(RECORD.transaction, 'tx_usd', {
            type: 'deposit', date: '2024-02-01', accountId: 'acct_cash',
            amount: 50000, currency: 'USD',
        });
        assert.ok((await portfolio.snapshot()).issues.some((i) => i.code === 'currency_not_converted'));

        const stored = (await records.list(RECORD.transaction)).find((r) => r.recordId === 'tx_usd');
        const form = txToForm(stored);
        assert.equal(form.currency, 'USD');
        // What transactions.js save() now passes through.
        const { body } = buildTxBody({ ...form, currency: form.currency || 'EUR' });
        assert.equal(body.currency, 'USD');
        await records.put(RECORD.transaction, 'tx_usd', body);

        assert.ok(
            (await portfolio.snapshot()).issues.some((i) => i.code === 'currency_not_converted'),
            'the mixed-currency warning disappeared after a no-op edit'
        );
    });

    test('an imported trade keeps its depot through a no-op edit', async () => {
        // The importer writes portfolioId; the form must hand it back. A form
        // that drops a field it does not collect re-attributes an imported
        // trade to nothing the moment someone opens it and presses Save — the
        // holding leaves its broker and the issue banner lights up, with no
        // edit having been made. Asserted on the engine's attribution, not on
        // the body, because that is what the user would see change.
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_pp', {
            type: 'buy', date: '2024-03-15', accountId: 'acct_cash', portfolioId: 'acct_depot',
            securityId: 'sec_vwce', shares: 1000000000, amount: 123456, currency: 'EUR',
        });
        const before = await portfolio.snapshot();
        assert.equal(before.positions[0].accountId, 'acct_depot');

        const stored = (await records.list(RECORD.transaction)).find((r) => r.recordId === 'tx_pp');
        const { body, errors } = buildTxBody(txToForm(stored));
        assert.deepEqual(errors, []);
        await records.put(RECORD.transaction, 'tx_pp', body);

        const after = await portfolio.snapshot();
        assert.equal(after.positions[0].accountId, 'acct_depot');
        assert.deepEqual(after.issues.filter((i) => i.code === 'missing_portfolio'), []);
        assert.equal(after.positions.length, 1);
    });

    test('editing the amount is reflected in cash and basis immediately', async () => {
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);

        const stored = (await records.list(RECORD.transaction)).find((r) => r.recordId === 'tx_2');
        const form = txToForm(stored);
        form.amount = '1300.00';
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(form).body);

        const snap = await portfolio.snapshot();
        assert.equal(snap.positions[0].cost, 130000);
        assert.equal(snap.totals.cash, 1000000 - 130000);
    });
});

describe('screens → engine: deleting a transaction', () => {
    test('a deleted buy closes the position and returns the cash', async () => {
        const { records, portfolio } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);

        await records.del(RECORD.transaction, 'tx_2');

        const snap = await portfolio.snapshot();
        assert.equal(snap.positions.length, 0);
        assert.equal(snap.totals.cash, 1000000);
        assert.equal(snap.totals.total, 1000000);
        // §3: a tombstone, never a hard delete — otherwise the next merge
        // resurrects the trade.
        assert.equal(records._raw.get('tx_2').deleted, true);
    });
});

describe('screens → engine: performance', () => {
    test('the Performance screen gets a real TTWROR and IRR from these records', async () => {
        const { records, performance } = await fixture();
        await records.put(RECORD.transaction, 'tx_1', buildTxBody(DEPOSIT_FORM).body);
        await records.put(RECORD.transaction, 'tx_2', buildTxBody(BUY_FORM).body);
        const chunk = buildPriceChunk({ securityId: 'sec_vwce', day: '2024-03-15', closeUnits: 15000000000 });
        await records.put(RECORD.price, chunk.recordId, chunk.body);

        const perf = await performance.performance({ from: '2024-01-01', to: '2024-03-15' });
        assert.equal(perf.from, '2024-01-01');
        assert.equal(perf.to, '2024-03-15');
        assert.equal(perf.portfolio.ttwror.ok, true);
        // €10,000 in, worth €10,265.44 at the close — a small positive return.
        assert.ok(perf.portfolio.ttwror.value > 0, `ttwror was ${perf.portfolio.ttwror.value}`);
        assert.match(fmt.percent(perf.portfolio.ttwror.value), /^\+\d+\.\d\d%$/);
        assert.equal(fmt.deltaClass(perf.portfolio.ttwror.value), 'wg-delta--gain');
    });

    test('an empty portfolio yields a screen-renderable "nothing yet", not a throw', async () => {
        // The first-run path. A screen that has to catch an exception to draw
        // its empty state is a screen that will one day draw a stack trace.
        const { records, portfolio, performance } = await fixture();
        const snap = await portfolio.snapshot();
        assert.equal(snap.positions.length, 0);
        assert.equal(snap.totals.total, 0);
        const perf = await performance.performance({});
        assert.equal(perf.portfolio, null);
        assert.deepEqual(perf.issues, []);
        assert.equal(records._raw.size, 3);
    });
});
