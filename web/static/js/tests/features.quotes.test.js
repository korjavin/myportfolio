/**
 * features.quotes.test.js
 *
 * The wiring bead's acceptance criteria, minus the pixels: pressing Refresh
 * fetches through the real web/domain/quotes.js, and every per-security outcome
 * it reports reaches the user as its own actionable line.
 *
 * WHAT IS REAL HERE, because a test that restates the fix in its own fixture
 * passes whether or not the shipped code is correct (two of those have already
 * been caught and replaced in this repo):
 *
 *   - the real `createQuotesDomain` from web/domain/quotes.js, over a real
 *     in-memory §3 records port and a recorded HTTP double. The reports fed to
 *     `describeRefresh` are therefore produced by the shipped fetcher, not
 *     hand-written to match the wording being asserted;
 *   - the real `createPortfolioDomain`, so `valuationAsOf` is asserted against
 *     the `priceDate` the shipped engine actually emits rather than against a
 *     position object this file invented.
 *
 * The DOM is not exercised — no jsdom in this project — so the handler wiring
 * is pinned by source guards at the bottom, the pattern features.forms.test.js
 * established for exactly this.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeRefresh, valuationAsOf, dayMs, STALE_AFTER_MS } from '../features/quotes.js';
import { createQuotesDomain } from '../../../domain/quotes.js';
import { createPortfolioDomain } from '../../../domain/portfolio.js';
import { RECORD, SETTINGS_ID } from '../../../domain/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FEATURES_DIR = path.join(REPO_ROOT, 'web/static/js/features');

/** The §3 port in memory — same three methods, same field ownership. */
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
    };
}

/** A fetch-shaped double. `routes` maps a host substring to a canned answer. */
function httpDouble(routes) {
    const calls = [];
    return {
        calls,
        http: async (url) => {
            calls.push(String(url));
            for (const [needle, answer] of Object.entries(routes)) {
                if (!String(url).includes(needle)) continue;
                const { status = 200, body } = answer;
                return { ok: status >= 200 && status < 300, status, json: async () => body };
            }
            throw new TypeError('Failed to fetch');
        },
    };
}

const COINGECKO_OK = {
    body: {
        prices: [
            [Date.UTC(2024, 2, 14, 12), 60000.5],
            [Date.UTC(2024, 2, 15, 12), 61234.25],
        ],
    },
};

/**
 * A portfolio with one security per outcome we want reported. Every one of
 * these routes somewhere different inside quotes.js, which is the point: the
 * four reasons must not be able to collapse into one another.
 */
async function fixture({ quoteProviders = {} } = {}) {
    const records = memoryRecords();
    await records.put(RECORD.settings, SETTINGS_ID, { reportingCurrency: 'EUR', quoteProviders });
    await records.put(RECORD.security, 'sec_btc', {
        name: 'Bitcoin', ticker: 'BTC', currency: 'EUR', quote: { provider: 'coingecko', symbol: 'bitcoin' },
    });
    await records.put(RECORD.security, 'sec_aapl', {
        name: 'Apple', ticker: 'AAPL', currency: 'USD', quote: { provider: 'twelvedata', symbol: 'AAPL' },
    });
    await records.put(RECORD.security, 'sec_house', {
        name: 'Unlisted fund', currency: 'EUR', quote: {},
    });
    await records.put(RECORD.security, 'sec_legacy', {
        name: 'Legacy holding', ticker: 'LEG', currency: 'EUR', quote: { provider: 'finnhub', symbol: 'LEG' },
    });
    return records;
}

describe('quotes — every outcome the domain reports reaches the user as its own line', () => {
    test('four different reasons produce four different lines, each naming its securities', async () => {
        // No Twelve Data key configured, so AAPL is `no_api_key`; the unlisted
        // fund is `no_quote_config`; the Finnhub leftover is
        // `unknown_provider`; BTC succeeds. Four outcomes, one press.
        const records = await fixture();
        const { http } = httpDouble({ 'api.coingecko.com': COINGECKO_OK });
        const report = await createQuotesDomain({ records, http }).refresh();

        const securities = await records.list(RECORD.security);
        const { notes, issues } = describeRefresh(report, securities);

        assert.equal(issues.length, 3, `expected one line per reason, got:\n${issues.join('\n')}`);
        const all = issues.join('\n');

        // Each line names its own securities, by the same label Holdings shows.
        const lineFor = (needle) => issues.find((i) => i.includes(needle));
        assert.ok(lineFor('Unlisted fund')?.includes('Settings › Securities'), all);
        assert.ok(/AAPL/.test(lineFor('API key') ?? ''), all);
        assert.ok(lineFor('Legacy holding'), all);

        // …and no line is a generic "prices failed to update".
        assert.ok(!/failed to update/i.test(all), all);

        // The success half is reported separately and says how many landed.
        assert.equal(notes.length, 1, notes.join('\n'));
        assert.match(notes[0], /Updated 1 security/);
        assert.match(notes[0], /2024-03-15/);
    });

    test('a rejected key and an exhausted quota are told apart, and neither is retried', async () => {
        const records = await fixture({ quoteProviders: { twelvedata: { apiKey: 'WRONG' } } });

        for (const [status, needle] of [[401, 'rejected the key'], [429, 'quota is intact']]) {
            const { http, calls } = httpDouble({
                'api.coingecko.com': COINGECKO_OK,
                'api.twelvedata.com': { status, body: { code: status, status: 'error', message: 'nope' } },
            });
            const report = await createQuotesDomain({ records, http }).refresh();
            const { issues } = describeRefresh(report, await records.list(RECORD.security));
            const all = issues.join('\n');
            assert.ok(all.includes(needle), `HTTP ${status} did not produce its own advice:\n${all}`);
            assert.ok(all.includes('AAPL'), all);
            // The no-retry rule, measured rather than asserted about: one
            // Twelve Data request went out for one failing batch, not two.
            const td = calls.filter((u) => u.includes('api.twelvedata.com'));
            assert.equal(td.length, 1, `retried a ${status}: ${td.length} requests`);
        }
    });

    test('an unreachable provider degrades to a report, never an error, and carries its reason', async () => {
        // The httpDouble throws for any host it has no route for — which is
        // what a browser does offline, and also what it does when the origin's
        // CSP blocks the request before it leaves.
        const records = await fixture({ quoteProviders: { twelvedata: { apiKey: 'K' } } });
        const report = await createQuotesDomain({ records, http: httpDouble({}).http }).refresh();
        const { notes, issues } = describeRefresh(report, await records.list(RECORD.security));
        const all = issues.join('\n');

        assert.ok(/could not be reached/.test(all), all);
        assert.ok(/Failed to fetch/.test(all), 'the provider\'s own reason is dropped');
        assert.ok(/still valued from the closes already stored/.test(all), all);
        assert.deepEqual(notes, []);
    });

    test('an unknown code still names itself and its securities rather than vanishing', () => {
        const { issues } = describeRefresh(
            { updated: [], skipped: [], errors: [{ securityId: 'sec_btc', code: 'teapot' }] },
            [{ recordId: 'sec_btc', name: 'Bitcoin', ticker: 'BTC' }]
        );
        assert.deepEqual(issues, ['teapot: BTC · Bitcoin']);
    });

    test('an empty portfolio says what to do rather than claiming success', () => {
        const { notes, issues } = describeRefresh({ updated: [], skipped: [], errors: [] }, []);
        assert.deepEqual(issues, []);
        assert.match(notes[0], /Nothing to fetch/);
    });
});

describe('quotes — the fetch actually lands in the records valuation reads', () => {
    test('a refreshed close values the position, through the real engine', async () => {
        const records = await fixture();
        await records.put(RECORD.account, 'acct_cash', {
            name: 'Cash', kind: 'cash', currency: 'EUR', closed: false,
        });
        await records.put(RECORD.account, 'acct_depot', {
            name: 'Depot', kind: 'securities', currency: 'EUR', closed: false,
        });
        await records.put(RECORD.transaction, 'tx_1', {
            type: 'buy', date: '2024-01-02', accountId: 'acct_cash', portfolioId: 'acct_depot',
            securityId: 'sec_btc', shares: 100000000, amount: 5000000, currency: 'EUR',
        });

        const portfolio = createPortfolioDomain({ records });
        const before = await portfolio.snapshot();
        assert.equal(valuationAsOf(before), null, 'nothing is priced before the refresh');

        const { http } = httpDouble({ 'api.coingecko.com': COINGECKO_OK });
        await createQuotesDomain({ records, http }).refresh();

        const after = await portfolio.snapshot();
        const [position] = after.positions;
        // The badge's durable signal is exactly this field.
        assert.equal(position.priceDate, '2024-03-15');
        assert.equal(valuationAsOf(after), '2024-03-15');
        assert.equal(position.price, 6123425000000);   // 61234.25 at the 1e8 price scale
        assert.ok(Number.isSafeInteger(position.marketValue));
    });

    test('a failed refresh leaves the valuation exactly where it was', async () => {
        const records = await fixture();
        await records.put(RECORD.account, 'acct_cash', {
            name: 'Cash', kind: 'cash', currency: 'EUR', closed: false,
        });
        await records.put(RECORD.account, 'acct_depot', {
            name: 'Depot', kind: 'securities', currency: 'EUR', closed: false,
        });
        await records.put(RECORD.transaction, 'tx_1', {
            type: 'buy', date: '2024-01-02', accountId: 'acct_cash', portfolioId: 'acct_depot',
            securityId: 'sec_btc', shares: 100000000, amount: 5000000, currency: 'EUR',
        });
        await createQuotesDomain({ records, http: httpDouble({ 'api.coingecko.com': COINGECKO_OK }).http }).refresh();

        const portfolio = createPortfolioDomain({ records });
        const good = await portfolio.snapshot();

        // Now every provider is down.
        const report = await createQuotesDomain({ records, http: httpDouble({}).http }).refresh();
        const stale = await portfolio.snapshot();

        assert.equal(report.fetchedAt, null);
        assert.equal(stale.positions[0].marketValue, good.positions[0].marketValue);
        assert.equal(valuationAsOf(stale), valuationAsOf(good));
    });
});

describe('quotes — the staleness signal', () => {
    test('the oldest close wins, because a total is only as fresh as its stalest input', () => {
        const snapshot = {
            positions: [
                { shares: 1, priceDate: '2024-03-15' },
                { shares: 2, priceDate: '2024-01-02' },
                { shares: 3, priceDate: '2024-06-30' },
            ],
        };
        assert.equal(valuationAsOf(snapshot), '2024-01-02');
    });

    test('closed and unpriced positions do not age the total', () => {
        assert.equal(valuationAsOf({
            positions: [
                { shares: 0, priceDate: '2001-01-01' },   // sold years ago
                { shares: 5, priceDate: null },           // held, never priced
                { shares: 5, priceDate: '2024-03-15' },
            ],
        }), '2024-03-15');
        assert.equal(valuationAsOf({ positions: [] }), null);
        assert.equal(valuationAsOf(null), null);
    });

    test('a stored day is anchored at UTC, not in the device\'s zone', () => {
        assert.equal(dayMs('2024-03-15'), Date.UTC(2024, 2, 15));
        assert.equal(dayMs('2024-3-15'), null);
        assert.equal(dayMs(null), null);
        assert.equal(dayMs(''), null);
    });

    test('the warning threshold clears a weekend, so Monday is not an alarm', () => {
        // A close dated Friday is 3 days old on Monday morning purely because
        // markets are shut. A 1h or 1d threshold would light up every week.
        assert.ok(STALE_AFTER_MS > 3 * 24 * 60 * 60 * 1000, 'a normal weekend would trip the badge');
        assert.ok(STALE_AFTER_MS <= 7 * 24 * 60 * 60 * 1000, 'a week-old price should not read as fresh');
    });

    test('the badge component turns that timestamp into the right tone', async () => {
        // The shipped component, evaluated as the classic script it is. Pins
        // that the durable signal produces a *warning* when it is old — the
        // badge is the whole staleness indicator, so a tone that never changes
        // is the same as not having one.
        const source = fs.readFileSync(
            path.join(REPO_ROOT, 'web/static/js/components/wg-stale-badge.js'), 'utf8'
        );
        const scope = { window: {} };
        new Function('window', source)(scope.window);
        const now = Date.UTC(2024, 2, 20);
        const label = (date) => scope.window.WGStaleBadge.formatLabel({ fetchedAt: dayMs(date), now });
        assert.equal(label('2024-03-20'), 'Updated just now');
        assert.equal(label('2024-03-15'), 'Updated 5d ago');
        assert.equal(label(null), 'Never updated');
        assert.equal(
            scope.window.WGStaleBadge.formatLabel({ fetchedAt: dayMs('2024-03-19'), isOffline: true, now }),
            'Offline · 1d old'
        );
    });
});

describe('quotes — the wiring, guarded at the source', () => {
    // These handlers are DOM-bound and this project has no jsdom. Everything
    // above tests real functions; this pins that the screen still calls them,
    // and that the rules the domain module depends on are not undone here.
    const read = (name) => fs.readFileSync(path.join(FEATURES_DIR, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
    const quotesSource = read('quotes.js');
    const holdingsSource = read('holdings.js');

    test('Refresh is an inline toolbar pill, not a FAB or a bottom dock', () => {
        // §9. ui.toolbar renders `primary` as .wg-toolbar-btn--primary and
        // nothing else does, so going through it IS the guarantee.
        assert.match(holdingsSource, /ui\.toolbar\(\{[\s\S]*?primary:\s*\[[\s\S]*?refreshAction\(\)/);
        assert.doesNotMatch(holdingsSource, /fab|bottom-cta|bottom-dock/i);
    });

    test('the badge is mounted off the snapshot, not off the last fetch time', () => {
        assert.match(holdingsSource, /staleBadge\(snapshot\)/);
        // fetchedAt does not survive a reload; priceDate does. Reaching for the
        // former here is the bug this bead's landmine names.
        assert.doesNotMatch(holdingsSource, /fetchedAt/);
        assert.match(quotesSource, /fetchedAt:\s*dayMs\(valuationAsOf\(snapshot\)\)/);
    });

    test('one press is one pass — nothing re-invokes refresh on failure', () => {
        const calls = [...quotesSource.matchAll(/\bquotes\.refresh\(/g)].length;
        assert.equal(calls, 1,
            'quotes.js halts a provider on 401/403/429 rather than burning the user\'s quota; '
            + 'a second refresh() call in the failure path is exactly the retry it refuses to do');
        assert.doesNotMatch(quotesSource, /setTimeout|setInterval|attempt|retry/i,
            'no timer and no retry loop belongs in the refresh path');
    });

    test('no URL is built here — the domain module owns every one of them', () => {
        // The privacy differentiator (§7): the server must never learn a ticker.
        // The domain module decides what is contacted (a provider host with the
        // user's key, plus the parameterless universe blob on our own origin);
        // this file only supplies the transport. A URL literal here — an origin,
        // an /api/ path, anything — means the wiring started making that decision.
        assert.match(quotesSource, /http:\s*\(url,\s*init\)\s*=>\s*window\.fetch\(url,\s*init\)/);
        assert.doesNotMatch(quotesSource, /['"`]\/api\//);
        assert.doesNotMatch(quotesSource, /https?:\/\//);
    });

    test('demo mode switches the shared universe blob off', () => {
        // Landmine 5 / §12: the demo fixture carries its own deterministic price
        // history, so live prices would break the tests that pin it AND show real
        // market prices against invented share counts. The gate is here rather
        // than in boot.js because this module is loaded by the screens.
        assert.match(quotesSource, /universe:\s*!new URLSearchParams\(globalThis\.location\?\.search[^)]*\)\.has\('demo'\)/);
    });

    test('the report survives the re-render its own write causes', () => {
        // store.refresh() emits, the screen re-renders, and a report held only
        // by the detached node is never seen — the bug settings.js already hit
        // with its import report.
        assert.match(quotesSource, /^let lastReport = null;$/m);
        assert.match(holdingsSource, /const report = refreshReport\(\);/);
    });

    test('a security can be given the provider quotes.js routes on', () => {
        // Without this the whole feature is unreachable again: quotes.js skips
        // a security with no `quote.provider` as no_quote_config, and the form
        // used to collect only the symbol.
        const settingsSource = read('settings.js');
        assert.match(settingsSource, /quote\.provider\s*=\s*quoteProvider\.value/);
        assert.match(settingsSource, /ui\.field\('Quote provider',\s*quoteProvider\)/);
    });
});
