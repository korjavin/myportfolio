/**
 * features.settings.test.js
 *
 * `settings.quoteProviders` is a MAP (ARCHITECTURE.md §7), and this file exists
 * because the Settings card used to write it wholesale:
 *
 *     patch.quoteProviders = { [providerSel.value]: { apiKey } };
 *
 * so configuring Twelve Data erased CoinGecko and vice versa. Nothing surfaced
 * an error — the other provider just vanished and half the portfolio quietly
 * stopped pricing. web/domain/quotes.js has always routed per security and
 * looked its config up by name, so the map was only ever wrong on this side.
 *
 * These exercise the SHIPPED functions out of settings.js rather than a fixture
 * restating them — a restatement passes whether or not the fix is present, which
 * this project has already been bitten by once. The DOM half (which control
 * feeds which row) has no jsdom to run under and is pinned by a source guard at
 * the bottom.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUOTE_HOSTS } from '../../../domain/quotes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SETTINGS_PATH = path.join(REPO_ROOT, 'web/static/js/features/settings.js');

// settings.js reaches store.js → core/localdb.js, which opens the real Dexie
// handle at import time and there is no IndexedDB under node. A chainable no-op
// satisfies `new Dexie(...).version(1).stores({...})`; nothing below touches
// storage, so nothing below depends on what it returns.
function chainableNoop() {
    return new Proxy(function noop() {}, {
        get: () => chainableNoop(),
        apply: () => chainableNoop(),
        construct: () => chainableNoop(),
    });
}
globalThis.Dexie = chainableNoop();

const { QUOTE_PROVIDERS, quoteProviderRows, mergeQuoteProviders } =
    await import('../features/settings.js');

/** What the card's Save handler builds from the rendered rows, untouched. */
const editsFrom = (rows) => rows.map((row) => ({
    name: row.name,
    keyField: row.keyField,
    enabled: row.enabled,
    apiKey: row.apiKey,
}));

/** Open the card on `stored` and press Save without touching anything. */
const reopenAndSave = (stored) => mergeQuoteProviders(stored, editsFrom(quoteProviderRows(stored)));

describe('settings — the provider list matches what quotes.js can actually do', () => {
    test('every offered provider is one quotes.js knows', () => {
        // The card used to offer finnhub and alphavantage; quotes.js reports
        // both as `unknown_provider` and prices nothing, with no error the user
        // ever sees. QUOTE_HOSTS is quotes.js's own exported host table, so
        // adding a provider there and forgetting this list fails here.
        assert.deepEqual(
            QUOTE_PROVIDERS.map((p) => p.name).sort(),
            Object.keys(QUOTE_HOSTS).sort()
        );
    });

    test('CoinGecko is the keyless one and the equity provider is not', () => {
        const byName = new Map(QUOTE_PROVIDERS.map((p) => [p.name, p]));
        assert.equal(byName.get('coingecko').needsKey, false);
        assert.equal(byName.get('twelvedata').needsKey, true);
    });
});

describe('settings — quoteProviders is merged, never replaced', () => {
    test('crypto and equities are configured at the same time, and both survive a reload', () => {
        // The bead's acceptance criterion. Configure them in either order and
        // the map holds both.
        let stored = mergeQuoteProviders({}, [
            { name: 'coingecko', keyField: true, enabled: true, apiKey: '' },
        ]);
        stored = mergeQuoteProviders(stored, [
            { name: 'twelvedata', keyField: true, enabled: true, apiKey: 'TD-KEY' },
        ]);
        assert.deepEqual(stored, { coingecko: {}, twelvedata: { apiKey: 'TD-KEY' } });

        // Reload: render the card from the stored map, press Save untouched.
        // A re-render that drops a stored key is the same class of bug as the
        // one being fixed, so this must be the identity.
        assert.deepEqual(reopenAndSave(stored), stored);
        assert.deepEqual(reopenAndSave(reopenAndSave(stored)), stored);
    });

    test('the equity key does not erase CoinGecko — the original bug', () => {
        const stored = { coingecko: {} };
        const rows = quoteProviderRows(stored);
        const edits = editsFrom(rows).map((e) => (
            e.name === 'twelvedata' ? { ...e, enabled: true, apiKey: 'TD-KEY' } : e
        ));
        assert.deepEqual(mergeQuoteProviders(stored, edits), {
            coingecko: {},
            twelvedata: { apiKey: 'TD-KEY' },
        });
    });

    test('removing one leaves the other intact, in both directions', () => {
        const stored = { coingecko: {}, twelvedata: { apiKey: 'TD-KEY' } };

        const offCrypto = editsFrom(quoteProviderRows(stored))
            .map((e) => (e.name === 'coingecko' ? { ...e, enabled: false } : e));
        assert.deepEqual(mergeQuoteProviders(stored, offCrypto), { twelvedata: { apiKey: 'TD-KEY' } });

        // Clearing the key field is how an equity provider is turned off.
        const offEquity = editsFrom(quoteProviderRows(stored))
            .map((e) => (e.name === 'twelvedata' ? { ...e, enabled: false, apiKey: '' } : e));
        assert.deepEqual(mergeQuoteProviders(stored, offEquity), { coingecko: {} });
    });

    test('config this card does not own survives a save', () => {
        // quotes.js reads `minIntervalMs` out of the same per-provider config.
        // The card edits one field; spreading rather than replacing is what
        // keeps the rest.
        const stored = {
            coingecko: { minIntervalMs: 0 },
            twelvedata: { apiKey: 'OLD', minIntervalMs: 1000 },
        };
        const edits = editsFrom(quoteProviderRows(stored))
            .map((e) => (e.name === 'twelvedata' ? { ...e, apiKey: 'NEW' } : e));
        assert.deepEqual(mergeQuoteProviders(stored, edits), {
            coingecko: { minIntervalMs: 0 },
            twelvedata: { apiKey: 'NEW', minIntervalMs: 1000 },
        });
    });

    test('the stored map is not mutated in place', () => {
        const stored = { twelvedata: { apiKey: 'TD-KEY' } };
        const before = JSON.stringify(stored);
        mergeQuoteProviders(stored, [{ name: 'twelvedata', keyField: true, enabled: false, apiKey: '' }]);
        mergeQuoteProviders(stored, [{ name: 'coingecko', keyField: true, enabled: true, apiKey: '' }]);
        assert.equal(JSON.stringify(stored), before);
    });

    test('a name the card never rendered is left exactly as stored', () => {
        const stored = { twelvedata: { apiKey: 'TD-KEY' } };
        assert.deepEqual(
            mergeQuoteProviders(stored, [{ name: 'coingecko', keyField: true, enabled: true, apiKey: '' }]),
            { coingecko: {}, twelvedata: { apiKey: 'TD-KEY' } }
        );
    });

    test('a garbled or absent map does not throw', () => {
        for (const junk of [undefined, null, 'nope', 42]) {
            assert.deepEqual(
                mergeQuoteProviders(junk, [{ name: 'coingecko', keyField: true, enabled: true, apiKey: '' }]),
                { coingecko: {} }
            );
            assert.ok(Array.isArray(quoteProviderRows(junk)));
        }
        // A provider whose config is not an object must not spread into one.
        assert.deepEqual(
            mergeQuoteProviders({ twelvedata: 'TD-KEY' }, [
                { name: 'twelvedata', keyField: true, enabled: true, apiKey: 'REAL' },
            ]),
            { twelvedata: { apiKey: 'REAL' } }
        );
    });
});

describe('settings — a key is never filed under a provider it was not typed for', () => {
    test('each row carries only its own key', () => {
        const rows = quoteProviderRows({ twelvedata: { apiKey: 'TD-KEY' } });
        const byName = new Map(rows.map((r) => [r.name, r]));
        assert.equal(byName.get('twelvedata').apiKey, 'TD-KEY');
        assert.equal(byName.get('coingecko').apiKey, '');
    });

    test('a key typed into one row lands under that row and nowhere else', () => {
        const stored = { twelvedata: { apiKey: 'TD-KEY' } };
        const edits = editsFrom(quoteProviderRows(stored))
            .map((e) => (e.name === 'coingecko' ? { ...e, enabled: true, apiKey: 'CG-DEMO' } : e));
        assert.deepEqual(mergeQuoteProviders(stored, edits), {
            coingecko: { apiKey: 'CG-DEMO' },
            twelvedata: { apiKey: 'TD-KEY' },
        });
    });

    test('a row with no key field of its own never writes one', () => {
        // The structural half of the 8cb4a3f fix: the merge refuses, so a future
        // wiring mistake in the card cannot resurrect the credential-crossing
        // bug on its own.
        const next = mergeQuoteProviders({}, [
            { name: 'finnhub', keyField: false, enabled: true, apiKey: 'SOMEONE-ELSES-KEY' },
        ]);
        assert.deepEqual(next, { finnhub: {} });
    });

    test('a key stored under CoinGecko is visible and editable, not silently kept or dropped', () => {
        // quotes.js sends a stored CoinGecko key as `x_cg_demo_api_key`, so what
        // sits here is neither inert nor safe to guess about: it may be a real
        // demo key raising the free-tier limit, or another vendor's credential
        // that 8cb4a3f's shared key field misfiled — and from the stored map
        // alone the two are indistinguishable. So the card renders it in
        // CoinGecko's OWN field: an untouched save keeps it, and clearing the
        // field is how it goes away. Deleting it behind the user's back would
        // break the legitimate case with no way to put it back.
        const stored = { coingecko: { apiKey: 'CG-DEMO' }, twelvedata: { apiKey: 'TD-KEY' } };
        assert.equal(quoteProviderRows(stored).find((r) => r.name === 'coingecko').apiKey, 'CG-DEMO');
        assert.deepEqual(reopenAndSave(stored), stored);

        const cleared = editsFrom(quoteProviderRows(stored))
            .map((e) => (e.name === 'coingecko' ? { ...e, apiKey: '' } : e));
        assert.deepEqual(mergeQuoteProviders(stored, cleared), {
            coingecko: {},
            twelvedata: { apiKey: 'TD-KEY' },
        });
    });
});

describe('settings — providers dropped from the list are still reachable', () => {
    test('a stored-but-unsupported provider gets a row so it can be deleted', () => {
        // An install that configured Finnhub before it was dropped would
        // otherwise hold a credential it can neither see nor remove.
        const stored = { finnhub: { apiKey: 'OLD-KEY' }, twelvedata: { apiKey: 'TD-KEY' } };
        const rows = quoteProviderRows(stored);
        const legacy = rows.find((r) => r.name === 'finnhub');
        assert.ok(legacy, 'no row offered for a stored provider the card no longer lists');
        assert.equal(legacy.unsupported, true);
        assert.equal(legacy.keyField, false, 'a dropped provider must not re-render its credential');
        assert.equal(legacy.apiKey, '');

        // Left alone it survives byte for byte — it has no field of its own, so
        // the merge does not touch what it holds.
        assert.deepEqual(reopenAndSave(stored), stored);

        // Toggled off it is gone, and the supported one is untouched.
        const edits = editsFrom(rows).map((e) => (e.name === 'finnhub' ? { ...e, enabled: false } : e));
        assert.deepEqual(mergeQuoteProviders(stored, edits), { twelvedata: { apiKey: 'TD-KEY' } });
    });
});

describe('settings — the card is wired to the merge', () => {
    // The save handler is DOM-bound and this project has no jsdom, so the wiring
    // is guarded at the source. Everything above tests real functions; this only
    // pins that the card still calls them.
    const source = fs.readFileSync(SETTINGS_PATH, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');

    test('the save path merges instead of assigning the map', () => {
        assert.match(source, /quoteProviders:\s*mergeQuoteProviders\(/);
        assert.doesNotMatch(
            source,
            /\.quoteProviders\s*=[^=]/,
            'assigning settings.quoteProviders replaces the map — that is the bug'
        );
    });

    test('the rendered rows come from quoteProviderRows, not a second list', () => {
        assert.match(source, /quoteProviderRows\(state\.settings\?\.quoteProviders\)/);
    });

    test('there is one key field per provider, not one shared field', () => {
        // The old card had a single `apiKey` input and a <select>; the fix is
        // that a key input only ever exists inside a row's own scope, and the
        // edit it produces reads that input and nothing else.
        assert.doesNotMatch(source, /providerSel/);
        assert.match(source, /row\.keyField\s*\n?\s*\?\s*ui\.input\(row\.apiKey/);
        assert.match(source, /apiKey:\s*key\s*\?\s*key\.value\.trim\(\)\s*:\s*''/);
    });
});
