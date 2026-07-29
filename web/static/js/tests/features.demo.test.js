/**
 * features.demo.test.js — bd myportfolio-cnd.1.
 *
 * The fixture is run through the REAL engines, not through restated
 * expectations. A test that asserts its own fixture back is worthless: two
 * tests in this repo have already shipped green over broken code that way, so
 * nothing here re-derives a number the seed already knows. What is asserted is
 * what portfolio.js and perf.js make of it — issues empty, both depots holding
 * one ETF, a closed position with a realized gain, and TTWROR and IRR that are
 * finite and genuinely different.
 *
 * The DOM is not exercised (this project has no jsdom and no npm dependencies),
 * so the boot wiring is checked by reading boot.js — including EVALUATING the
 * demo-detection expression lifted out of its source, which is the only way an
 * assertion about it cannot drift away from what actually ships.
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoRecords, createDemoRecords } from '../features/demo.js';
import { createPortfolioDomain } from '../../../domain/portfolio.js';
import { createPerformanceDomain } from '../../../domain/perf.js';
import { RECORD, SETTINGS_ID } from '../../../domain/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOT_PATH = path.join(__dirname, '../features/boot.js');

const TODAY = '2026-07-29';

/** Every number anywhere inside a record, with the path that reached it. */
function* numbersIn(value, at = '') {
    if (typeof value === 'number') {
        yield [at, value];
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) yield* numbersIn(v, `${at}.${k}`);
    }
}

describe('demo mode — the seed through the real engines', () => {
    let seed;
    let snapshot;

    before(async () => {
        seed = demoRecords({ today: TODAY });
        const records = createDemoRecords(seed);
        snapshot = await createPortfolioDomain({ records }).snapshot();
    });

    test('the engine reports no issues at all', () => {
        // A demo that trips portfolio.js's own error reporting is not a demo:
        // missing_portfolio, oversell, no_price, non_integer_units and
        // currency_not_converted are each a visible defect on a screen.
        assert.deepEqual(
            snapshot.issues,
            [],
            `the fixture raises engine issues:\n${snapshot.issues.map((i) => `  • ${i.code} ${i.recordId}: ${i.message}`).join('\n')}`
        );
    });

    test('every position is valued — prices cover every security through today', () => {
        assert.ok(snapshot.positions.length > 0, 'the fixture produced no positions');
        for (const p of snapshot.positions) {
            assert.notEqual(p.marketValue, null, `${p.securityId} at ${p.accountId} has no marketValue`);
            assert.notEqual(p.unrealized, null, `${p.securityId} at ${p.accountId} has no unrealized`);
            assert.notEqual(p.accountId, null, `${p.securityId} landed in an unattributed position`);
        }
    });

    test('one security is held in two depots and the aggregate adds up', () => {
        // §4's most Portfolio-Performance-like property: a position is keyed by
        // (accountId, securityId), with a portfolio-wide aggregate on top.
        const byId = new Map();
        for (const p of snapshot.positions) {
            byId.set(p.securityId, [...(byId.get(p.securityId) ?? []), p]);
        }
        const shared = [...byId.entries()].filter(([, ps]) => ps.length > 1);
        assert.equal(shared.length, 1, 'exactly one security should be held in two depots');

        const [securityId, positions] = shared[0];
        assert.equal(new Set(positions.map((p) => p.accountId)).size, positions.length,
            'the two positions must sit in different accounts');
        const aggregate = snapshot.securities.find((s) => s.securityId === securityId);
        assert.equal(aggregate.shares, positions.reduce((a, p) => a + p.shares, 0));
        assert.equal(aggregate.accountIds.length, positions.length);
    });

    test('a fully closed position carries a realized gain', () => {
        const closed = snapshot.positions.filter((p) => p.shares === 0 && p.realized > 0);
        assert.ok(closed.length > 0, 'no position was bought, held and entirely sold at a profit');
        // A full FIFO exit consumes every lot, so no basis dust is left behind.
        assert.equal(closed[0].cost, 0, `${closed[0].securityId} left ${closed[0].cost} of basis behind`);
    });

    test('the portfolio is worth something and has been paid dividends', () => {
        assert.ok(snapshot.totals.total > 0, `totals.total is ${snapshot.totals.total}`);
        assert.ok(snapshot.totals.dividends > 0, `totals.dividends is ${snapshot.totals.dividends}`);
        // Fees and taxes are non-zero on purpose: §4 pins that fees capitalise
        // into basis and taxes do not, and a fixture of zeros silently stops
        // testing the arithmetic rule most likely to regress.
        assert.ok(snapshot.totals.fees > 0, 'no fees anywhere in the fixture');
        assert.ok(snapshot.totals.taxes > 0, 'no taxes anywhere in the fixture');
        assert.equal(snapshot.reportingCurrency, 'EUR');
        assert.equal(snapshot.costBasisMethod, 'fifo');
    });

    test('TTWROR and IRR are both finite and NOT equal', async () => {
        const perf = await createPerformanceDomain({ records: createDemoRecords(seed) }).performance({});
        assert.deepEqual(perf.issues, [], 'the performance engine reports issues');

        const { ttwror, irr } = perf.portfolio;
        assert.equal(ttwror.ok, true, `ttwror: ${JSON.stringify(ttwror)}`);
        assert.equal(irr.ok, true, `irr: ${JSON.stringify(irr)}`);
        assert.ok(Number.isFinite(ttwror.value), `ttwror ${ttwror.value}`);
        assert.ok(Number.isFinite(irr.value), `irr ${irr.value}`);
        // Staggered deposits are the whole reason a money-weighted and a
        // time-weighted return differ. Identical numbers mean the fixture is
        // one lump sum at the start and demonstrates nothing.
        assert.notEqual(ttwror.value, irr.value);
    });
});

describe('demo mode — the seed itself', () => {
    test('two calls with the same `today` deep-equal', () => {
        assert.deepEqual(demoRecords({ today: TODAY }), demoRecords({ today: TODAY }));
    });

    test('every number in every record is a fixed-point integer', () => {
        // §5: amounts 1e2, shares 1e8, prices 1e8, and nothing fractional
        // anywhere. This is the guard that catches somebody typing 1234.56 for a
        // euro amount, which is wrong by 100x on every screen at once.
        const bad = [];
        for (const rec of demoRecords({ today: TODAY })) {
            for (const [at, n] of numbersIn(rec)) {
                if (!Number.isInteger(n)) bad.push(`${rec.recordId}${at} = ${n}`);
            }
        }
        assert.deepEqual(bad, [], `non-integer money in the fixture:\n${bad.map((b) => `  • ${b}`).join('\n')}`);
    });

    test('the record set is complete and the ids are stable', () => {
        const seed = demoRecords({ today: TODAY });
        const ids = seed.map((r) => r.recordId);
        assert.equal(new Set(ids).size, ids.length, 'duplicate recordId in the seed');
        assert.ok(ids.every((id) => /^[a-z0-9_]+$/.test(id)), 'a recordId is not a stable literal');
        for (const type of [RECORD.account, RECORD.security, RECORD.transaction, RECORD.price]) {
            assert.ok(seed.some((r) => r.recordType === type), `no ${type} records`);
        }
        assert.ok(seed.some((r) => r.recordId === SETTINGS_ID && r.recordType === RECORD.settings),
            'no settings singleton');
        assert.ok(seed.every((r) => r.deleted === false && Number.isInteger(r.clientTs)),
            'a record is not in §3 stored shape');
    });

    test('a rubbish `today` is refused rather than rolled forward', () => {
        assert.throws(() => demoRecords({ today: '2026-02-30' }), RangeError);
        assert.throws(() => demoRecords({ today: 'yesterday' }), RangeError);
        assert.throws(() => demoRecords({}), RangeError);
    });

    test('evergreen: a `today` five years out still works and still values', async () => {
        // A demo with hardcoded dates reads as an abandoned product within a
        // year. Everything is anchored on `today`, so a future one must give the
        // same clean portfolio with prices right up to it.
        const future = '2031-01-15';
        const seed = demoRecords({ today: future });
        const snap = await createPortfolioDomain({ records: createDemoRecords(seed) }).snapshot();
        assert.deepEqual(snap.issues, []);

        const latest = snap.positions.reduce((a, p) => (p.priceDate > a ? p.priceDate : a), '');
        assert.equal(latest, future, `latest priced day is ${latest}, not ${future}`);
    });
});

describe('demo mode — the boot branch', () => {
    const boot = fs.readFileSync(BOOT_PATH, 'utf8');

    // The two branches, located by brace matching. Read out of the shipped file
    // rather than described here, so this cannot pass while boot.js says
    // something else.
    function branches(source) {
        const open = source.indexOf('if (demo) {');
        assert.notEqual(open, -1, 'boot.js has no `if (demo) {` branch');

        // Returns [body, indexAfterClosingBrace] for the block starting at the
        // first `{` at or after `at`.
        const block = (at) => {
            let i = source.indexOf('{', at);
            const start = i + 1;
            for (let depth = 0; i < source.length; i += 1) {
                if (source[i] === '{') depth += 1;
                else if (source[i] === '}' && (depth -= 1) === 0) break;
            }
            return [source.slice(start, i), i + 1];
        };

        const [demoBlock, afterDemo] = block(open);
        const elseAt = source.indexOf('else', afterDemo);
        assert.notEqual(elseAt, -1, 'boot.js has no else branch for the ordinary path');
        const [elseBlock, afterElse] = block(elseAt);
        const outside = source.slice(0, open) + source.slice(afterElse);
        return { demoBlock, elseBlock, outside };
    }

    test('the detection expression itself says no for an empty query string', () => {
        // Lifted from boot.js and executed: `location` is the only free name in
        // it, so it can be fed a stub. Restating the rule here instead would be
        // a test of this file, not of the shell.
        const expr = boot.match(/const demo = ([^;]+);/);
        assert.ok(expr, 'boot.js does not declare `const demo = …;`');
        const detect = new Function('location', `return ${expr[1]};`);
        assert.equal(detect({ search: '' }), false);
        assert.equal(detect({ search: '?other=1' }), false);
        assert.equal(detect({ search: '?demo=1' }), true);
        assert.equal(detect({ search: '?demo' }), true);
    });

    test('demo mode never opens a vault, a sync or a database', () => {
        // THE isolation guarantee. startSync() calls tryWarmUnlock(), which
        // reads the LDK device database and can adopt vaultRecords — a demo
        // that ran it would be one bug away from syncing invented trades into a
        // real vault. openMirror is the Dexie handle; not calling it is why no
        // IndexedDB operation happens at all in demo mode.
        const { demoBlock, elseBlock, outside } = branches(boot);
        for (const forbidden of ['startSync', 'watchFocus', 'openMirror', 'openSyncMeta']) {
            assert.ok(
                !demoBlock.includes(`${forbidden}(`),
                `boot.js calls ${forbidden}() inside the ?demo=1 branch`
            );
        }
        // …and they are still called on the ordinary path, so the guard above
        // cannot be satisfied by deleting sync from the app entirely.
        assert.ok(elseBlock.includes('startSync({'), 'boot.js no longer starts sync at all');
        assert.ok(elseBlock.includes('watchFocus({'), 'boot.js no longer watches focus at all');
        // Nothing outside the else branch may call them either: a stray
        // top-level call would run in demo mode too.
        const stray = outside.split('\n').filter((l) => /^\s*(startSync|watchFocus|openMirror)\(/.test(l));
        assert.deepEqual(stray, [], 'startSync/watchFocus are called outside the else branch');
    });

    test('demo.js is imported dynamically, and the banner is unhidden', () => {
        const { demoBlock } = branches(boot);
        assert.match(demoBlock, /import\(\s*'\.\/demo\.js'\s*\)/,
            'the demo module must be a DYNAMIC import — a static one ships the fixture to every '
            + 'real user and makes architecture.sw-precache demand a PRECACHE entry for it');
        assert.ok(!/^\s*import\b[^(]/m.test(boot.slice(boot.indexOf('demo.js') - 200, boot.indexOf('demo.js'))),
            'demo.js must not be statically imported');
        assert.match(demoBlock, /getElementById\('demo-banner'\)[\s\S]*classList\.remove\('hidden'\)/);
        assert.match(demoBlock, /useRecords\(/, 'the demo port must be swapped in through useRecords');
    });

    test('the banner ships in index.html, hidden and not dismissable', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
        const banner = html.match(/<div id="demo-banner"[\s\S]*?<\/div>/);
        assert.ok(banner, 'index.html has no #demo-banner element');
        assert.match(banner[0], /class="[^"]*\bhidden\b/, 'the banner must be hidden by default');
        assert.ok(!/<button/.test(banner[0]),
            'the banner must not be dismissable — an unlabelled fabricated portfolio is what gets '
            + 'screenshotted out of context');
    });
});
