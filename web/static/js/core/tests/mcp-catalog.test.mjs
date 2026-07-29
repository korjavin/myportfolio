// The hand-written read-only catalog (bd myportfolio-ybp.4, ARCHITECTURE.md §11).
// Run with `node --test` from web/.
//
// Three properties are worth a test here and the rest is noise:
//
//   1. DRIFT. The catalog names domain functions in prose-free `source` blocks.
//      A domain module that loses an export must fail HERE, not at the agent,
//      where it surfaces as "the connector answered with an internal error".
//   2. READ-ONLY, proved rather than asserted. Every operation is run against a
//      port whose put/del THROW. That is stronger than grepping for ".put(":
//      it covers a write reached through any depth of domain code, and it is
//      why createRunner narrows the port instead of trusting a convention.
//   3. THE MONEY BOUNDARY. Every operation is run against a real fixture
//      portfolio and its whole output tree is walked: no bare §5 integer may
//      reach a model. That is the single highest-risk detail in the bead —
//      123456 read as 123,456 euros is a confidently wrong answer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CATALOG, TOPICS, operation, createRunner, presentMoney } from '../mcp-catalog.js';
import { createDemoRecords, demoRecords } from '../../features/demo.js';
import { formatFixed } from '../../../../domain/money.js';

// A real portfolio: five years of deposits and trades across two brokers, a
// dollar-denominated holding with its own FX series, generated prices. Pinned
// `today` so every number below is reproducible.
const TODAY = '2025-06-30';
const seed = demoRecords({ today: TODAY });
const port = createDemoRecords(seed);

// The same port with the write half armed to explode. Nothing the runner does
// may reach it.
const readOnlyTrap = {
    list: (t) => port.list(t),
    put: () => { throw new Error('a catalog operation reached records.put — v1 is READ-ONLY'); },
    del: () => { throw new Error('a catalog operation reached records.del — v1 is READ-ONLY'); },
};

// Params that make every operation return something real. The performance range
// is deliberately short: perf.js folds one full snapshot per boundary date, so a
// five-year range is a minute of CPU for no extra coverage.
const SAMPLE_PARAMS = {
    'portfolio.summary': {},
    'portfolio.holdings': {},
    'portfolio.securities': {},
    'portfolio.accounts': {},
    'portfolio.issues': {},
    'performance.summary': { from: '2025-01-01', to: TODAY },
    'prices.series': { securityId: null, limit: 20 }, // securityId filled in below
    'transactions.list': { limit: 25 },
};

describe('catalog — drift against the domain modules', () => {
    it('every operation names a source that still exists', async () => {
        for (const op of CATALOG) {
            assert.ok(op.source, `${op.id} declares no source — the drift test cannot pin it`);
            const mod = await import(`../../../../domain/${op.source.module}`);
            if (op.source.factory) {
                assert.equal(typeof mod[op.source.factory], 'function',
                    `${op.id}: web/domain/${op.source.module} no longer exports ${op.source.factory}()`);
                const domain = mod[op.source.factory]({ records: readOnlyTrap });
                assert.equal(typeof domain[op.source.method], 'function',
                    `${op.id}: ${op.source.factory}() no longer returns a ${op.source.method}()`);
            }
            if (op.source.records) {
                assert.ok(Object.values(mod.RECORD).includes(op.source.records),
                    `${op.id}: schema.js RECORD no longer has a "${op.source.records}" type`);
            }
        }
    });

    it('is small, hand-written and complete — ids, topics and lookups agree', () => {
        assert.ok(CATALOG.length > 0);
        assert.equal(new Set(CATALOG.map((o) => o.id)).size, CATALOG.length, 'duplicate operation id');
        for (const op of CATALOG) {
            assert.equal(operation(op.id), op);
            assert.ok(TOPICS.includes(op.topic));
            assert.ok(op.description.length > 40, `${op.id}: the description is what a model reads`);
            assert.ok(op.params && typeof op.params === 'object', `${op.id}: params must be a (possibly empty) map`);
        }
        // A prototype member must not resolve to an operation.
        for (const evil of ['constructor', 'toString', '__proto__', '']) {
            assert.equal(operation(evil), undefined);
        }
    });

    it('the catalog source carries no write path at all', () => {
        const src = readFileSync(new URL('../mcp-catalog.js', import.meta.url), 'utf8');
        // Belt to the runtime trap's braces: the runner narrows the port to
        // `list`, so a write cannot happen — but a reviewer reading this file
        // should not have to prove that from the call graph.
        for (const f of ['.put(', '.del(', 'importRecords', 'putSettings', 'exportAll']) {
            assert.ok(!src.includes(f), `mcp-catalog.js mentions ${f} — v1 is read-only`);
        }
    });
});

describe('catalog — every operation answers with real numbers', () => {
    const run = createRunner({ records: readOnlyTrap });

    it('read-only: no operation can reach put or del', async () => {
        const securities = await run('portfolio.securities', {});
        SAMPLE_PARAMS['prices.series'].securityId = securities.securities[0].securityId;
        for (const op of CATALOG) {
            // The trap throws rather than returning, so reaching a write fails
            // this loop with the message above rather than silently passing.
            await run(op.id, SAMPLE_PARAMS[op.id]);
        }
    });

    it('portfolio.summary values a five-year fixture portfolio', async () => {
        const out = await run('portfolio.summary', {});
        assert.equal(out.reportingCurrency, 'EUR');
        assert.equal(out.costBasisMethod, 'fifo');
        assert.ok(out.positionCount > 0);
        // The authoritative field is the decimal string and it is a real number,
        // not "0.00" — a fixture that valued to nothing would pass every shape
        // assertion in this file while proving nothing.
        assert.match(out.totals.total, /^-?\d+\.\d{2}$/);
        assert.ok(Math.abs(out.totals.totalUnits) > 100000, `fixture portfolio valued at ${out.totals.total}`);
        assert.equal(out.totals.total, formatFixed(out.totals.totalUnits, 2));
    });

    it('portfolio.holdings drops the internal lot queue and keeps the position keys', async () => {
        const out = await run('portfolio.holdings', {});
        assert.ok(out.positions.length > 0);
        for (const p of out.positions) {
            assert.equal(p.lots, undefined, 'lots is an internal acquisition queue, not an answer');
            assert.ok('securityId' in p && 'accountId' in p);
        }
    });

    it('performance.summary returns rates as fractions, never money', async () => {
        const out = await run('performance.summary', SAMPLE_PARAMS['performance.summary']);
        assert.equal(out.from, '2025-01-01');
        assert.equal(out.to, TODAY);
        for (const rate of [out.portfolio.ttwror, out.portfolio.irr]) {
            assert.equal(typeof rate.ok, 'boolean');
            if (rate.ok) {
                // A ratio, not an amount: it must NOT have been formatted, and it
                // must NOT have grown a Units twin.
                assert.equal(typeof rate.value, 'number');
                assert.equal(rate.valueUnits, undefined);
            } else {
                assert.equal(typeof rate.reason, 'string');
            }
        }
        // Valuations either side of the range ARE money.
        assert.equal(typeof out.portfolio.closeValue, 'string');
    });

    it('prices.series keeps the newest points and says how many it dropped', async () => {
        const { securities } = await run('portfolio.securities', {});
        const id = securities[0].securityId;
        const all = await run('prices.series', { securityId: id, limit: 100000 });
        const few = await run('prices.series', { securityId: id, limit: 5 });
        assert.equal(few.count, 5);
        assert.equal(few.omitted, all.count - 5);
        assert.deepEqual(few.points, all.points.slice(-5), 'the kept window must be the newest, not the oldest');
        assert.match(few.points[0].close, /^-?\d+\.\d{8}$/);
    });

    it('prices.series refuses without a securityId, in words the agent can act on', async () => {
        await assert.rejects(() => run('prices.series', {}), /securityId/);
    });

    it('transactions.list filters, orders newest-first and reports what it omitted', async () => {
        const buys = await run('transactions.list', { type: 'buy', limit: 3 });
        assert.equal(buys.count, 3);
        assert.ok(buys.matched > 3);
        assert.equal(buys.omitted, buys.matched - 3);
        for (const tx of buys.transactions) assert.equal(tx.type, 'buy');
        const dates = buys.transactions.map((t) => t.date);
        assert.deepEqual(dates, [...dates].sort().reverse());
    });

    it('a garbage limit falls back to the default instead of answering "you own nothing"', async () => {
        for (const limit of [0, -1, 'lots', null, NaN]) {
            const out = await run('transactions.list', { limit });
            assert.ok(out.count > 0, `limit=${JSON.stringify(limit)} returned an empty portfolio`);
        }
    });

    it('portfolio.issues surfaces what the engine could not compute', async () => {
        const out = await run('portfolio.issues', {});
        assert.equal(out.issueCount, out.issues.length);
        assert.ok(Array.isArray(out.issues));
    });
});

// --- The money boundary -----------------------------------------------------

// Numeric fields that are legitimately NOT money. Anything else that reaches a
// model as a bare number is the bug this whole section exists to catch.
const NOT_MONEY = new Set([
    'count', 'matched', 'omitted', 'issueCount', 'positionCount', 'securityCount', 'accountCount',
    'value',   // the TTWROR/IRR ratio
    'clientTs',
]);

// Walk a result tree and collect every bare number, with the path to it.
function bareNumbers(node, path = '$', found = []) {
    if (Array.isArray(node)) {
        node.forEach((v, i) => bareNumbers(v, `${path}[${i}]`, found));
        return found;
    }
    if (node === null || typeof node !== 'object') return found;
    for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'number') {
            if (!NOT_MONEY.has(k) && !k.endsWith('Units')) found.push(`${path}.${k} = ${v}`);
            continue;
        }
        bareNumbers(v, `${path}.${k}`, found);
    }
    return found;
}

describe('catalog — the money boundary', () => {
    const run = createRunner({ records: readOnlyTrap });

    it('no operation lets a bare fixed-point integer reach a model', async () => {
        const securities = await run('portfolio.securities', {});
        const params = { ...SAMPLE_PARAMS, 'prices.series': { securityId: securities.securities[0].securityId } };
        for (const op of CATALOG) {
            const out = await run(op.id, params[op.id]);
            assert.deepEqual(bareNumbers(out), [],
                `${op.id} returned unscaled §5 integers. A model shown 123456 with no scale reports 123,456 euros.\n`
                + 'Either register the field in MONEY_DECIMALS in mcp-catalog.js, or add it to NOT_MONEY here '
                + 'if it genuinely is not money.');
        }
    });

    it('the plain field is the exact decimal and the Units twin is the integer', () => {
        const out = presentMoney({ marketValue: 123456, shares: 150000000, price: 4123500000 });
        assert.deepEqual(out, {
            marketValue: '1234.56', marketValueUnits: 123456,
            shares: '1.50000000', sharesUnits: 150000000,
            price: '41.23500000', priceUnits: 4123500000,
        });
    });

    it('null means "not computable", not zero, on both halves', () => {
        assert.deepEqual(presentMoney({ marketValue: null, unrealized: undefined }), {
            marketValue: null, marketValueUnits: null,
            unrealized: null, unrealizedUnits: null,
        });
    });

    it('leaves a non-money field alone however number-shaped it is', () => {
        const out = presentMoney({ value: 0.0734, count: 12, ok: true, date: '2025-06-30', nested: { close: 100 } });
        assert.equal(out.value, 0.0734);
        assert.equal(out.count, 12);
        assert.equal(out.valueUnits, undefined);
        assert.equal(out.nested.close, '0.00000100');
    });

    it('a field name inherited from Object.prototype is not treated as money', () => {
        const out = presentMoney({ constructor: 5, toString: 7 });
        assert.equal(out.constructor, 5);
        assert.equal(out.toString, 7);
    });

    it('every operation description states the money rule, because that is all a model reads', () => {
        for (const op of CATALOG) {
            const returnsMoney = op.id !== 'portfolio.issues';
            if (!returnsMoney) continue;
            assert.match(op.description, /AUTHORITATIVE/,
                `${op.id}: the description must say which of the two money fields is authoritative`);
            assert.match(op.description, /Units/, `${op.id}: the description must name the *Units convention`);
        }
    });
});
