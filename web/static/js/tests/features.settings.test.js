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
import nodeCrypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { QUOTE_HOSTS } from '../../../domain/quotes.js';
import { fromBase64, toBase64 } from '../core/crypto.js';
import { MCP_PAIRING_TYPE, MCP_PAIRING_ID, readPairing, purgePairing } from '../core/mcp-responder.js';

globalThis.crypto ??= nodeCrypto.webcrypto;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SETTINGS_PATH = path.join(REPO_ROOT, 'web/static/js/features/settings.js');
const SHIM_MAIN_PATH = path.join(REPO_ROOT, 'cmd/mcpshim/main.go');
const SERVER_PATH = path.join(REPO_ROOT, 'internal/server/server.go');
const VECTORS_PATH = path.join(REPO_ROOT, 'internal/mcpshim/testdata/mcp_frame_vectors.json');

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

const {
    QUOTE_PROVIDERS, quoteProviderRows, mergeQuoteProviders,
    MCP_CODE_ENV_VAR, CONNECTOR_FACTS, relayEndpoint, shimEnvLine,
    mintPairing, savePairing, revokePairing,
} = await import('../features/settings.js');

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

// ===========================================================================
// Connect Claude (bd myportfolio-ybp.5, ARCHITECTURE.md §11)
// ===========================================================================
//
// Everything below drives the SHIPPED functions out of settings.js. Where a fact
// is owned by the Go side — the relay's route, the shim's environment variable,
// the pinned pairing-code vector — the assertion reads that file rather than
// restating its value here, because a test carrying its own copy of the contract
// passes exactly as happily when the shipped code drifts away from it. Four
// tests in this repo have already been caught doing that.

/** The §3 port, in memory: same three methods, same field ownership. */
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

/**
 * An `http` port that records everything it was asked to send. `calls` is what
 * the key must not appear anywhere inside.
 */
function recordingHttp(handler) {
    const calls = [];
    return {
        calls,
        http: async (url, init) => {
            calls.push({ url, init });
            return handler(url, init);
        },
    };
}

const mintResponse = (pairingId) => ({
    ok: true,
    status: 200,
    json: async () => ({ pairing_id: pairingId }),
});

const RELAY = 'wss://p.example/api/mcp/relay';
const realRandom = (buf) => crypto.getRandomValues(buf);

/** Everything the key could plausibly be smuggled as, in one place. */
function keyEncodings(key) {
    const b64 = toBase64(key);
    return [
        b64,
        b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), // base64url
        Buffer.from(key).toString('hex'),
        [...key].join(','), // the shape JSON.stringify gives a Uint8Array-turned-array
    ];
}

describe('Connect Claude — relay_url is the ENDPOINT, not the origin', () => {
    // The bug this pins 404'd every real pairing in C3 while passing every test
    // that minted its own code from a bare listener address. §11 names it, and
    // pins the shim's half against this same vector file.
    const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));

    test('minting for the pinned vector\'s host reproduces the pinned relay_url', () => {
        const { host, pathname } = new URL(vectors.relay_url.replace(/^wss:/, 'https:'));
        assert.equal(relayEndpoint({ protocol: 'https:', host }), vectors.relay_url);
        // Stated separately so a failure says which half is wrong.
        assert.equal(pathname, '/api/mcp/relay');
    });

    test('the path is the one the server actually routes', () => {
        // internal/server/server.go owns it. Deriving from the shim route means
        // moving the route breaks this test rather than breaking pairing.
        const route = fs.readFileSync(SERVER_PATH, 'utf8')
            .match(/mux\.HandleFunc\("GET (\/api\/mcp\/relay)\/shim"/);
        assert.ok(route, 'no GET /api/mcp/relay/shim route found in internal/server/server.go');
        assert.equal(relayEndpoint({ protocol: 'https:', host: 'p.example' }), `wss://p.example${route[1]}`);
    });

    test('the relay path appears exactly once — the doubling is the failure mode', () => {
        const url = relayEndpoint({ protocol: 'https:', host: 'p.example' });
        assert.equal(url.split('/api/mcp/relay').length - 1, 1);
    });

    test('a plain-http origin gets ws:, not wss:', () => {
        // Local development is served over http, and a wss: URL there fails as a
        // bare onclose — which reads identically to "no device online".
        assert.equal(
            relayEndpoint({ protocol: 'http:', host: 'localhost:8080' }),
            'ws://localhost:8080/api/mcp/relay'
        );
    });
});

describe('Connect Claude — the environment line names the variable the shim reads', () => {
    test('the variable is cmd/mcpshim/main.go\'s own codeEnvVar', () => {
        const declared = fs.readFileSync(SHIM_MAIN_PATH, 'utf8').match(/const codeEnvVar = "([^"]+)"/);
        assert.ok(declared, 'codeEnvVar not found in cmd/mcpshim/main.go');
        assert.equal(MCP_CODE_ENV_VAR, declared[1]);
    });

    test('the line is NAME=code, and the code needs no shell quoting', async () => {
        const records = memoryRecords();
        const { http } = recordingHttp(() => mintResponse('prg-abc'));
        const { code } = await mintPairing({ http, records, randomBytes: realRandom, relayUrl: RELAY });
        // The unquoted form in shimEnvLine is only safe while this holds.
        assert.match(code, /^[A-Za-z0-9._-]+$/);
        assert.equal(shimEnvLine(code), `${MCP_CODE_ENV_VAR}=${code}`);
    });
});

describe('Connect Claude — THE KEY NEVER TOUCHES THE SERVER', () => {
    test('the mint request carries no body, no query and no key', async () => {
        const records = memoryRecords();
        const { http, calls } = recordingHttp(() => mintResponse('prg-abc'));
        const { key } = await mintPairing({ http, records, randomBytes: realRandom, relayUrl: RELAY });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/api/mcp/pairings');
        assert.equal(calls[0].init.method, 'POST');
        assert.equal(calls[0].init.body, undefined, 'the mint request must have no body at all');

        const wire = JSON.stringify(calls);
        for (const encoded of keyEncodings(key)) {
            assert.equal(wire.includes(encoded), false, 'the pairing key reached the server');
        }
        // And nothing key-shaped got in there by some other route.
        assert.doesNotMatch(wire, /[A-Za-z0-9+/_-]{40,}/);
    });

    test('revoking carries no key either', async () => {
        const { http, calls } = recordingHttp(() => ({ ok: true, status: 204 }));
        await revokePairing({ http });
        assert.deepEqual(calls.map((c) => [c.url, c.init.method]), [['/api/mcp/pairings', 'DELETE']]);
        assert.equal(calls[0].init.body, undefined);
    });

    test('the key is 32 fresh bytes from the injected CSPRNG', async () => {
        const records = memoryRecords();
        const { http } = recordingHttp(() => mintResponse('prg-abc'));
        const seen = [];
        const mint = () => mintPairing({
            http,
            records,
            randomBytes: (b) => { crypto.getRandomValues(b); seen.push(b); return b; },
            relayUrl: RELAY,
        });
        const a = await mint();
        const b = await mint();
        assert.equal(a.key.length, 32);
        assert.equal(seen.length, 2, 'the key must come from the injected randomness, not from elsewhere');
        assert.notEqual(toBase64(a.key), toBase64(b.key));
    });
});

describe('Connect Claude — the stored record is the one mcp-responder.js reads', () => {
    test('readPairing (the shipped responder function) finds what savePairing wrote', async () => {
        const records = memoryRecords();
        const { http } = recordingHttp(() => mintResponse('prg-7f3c'));
        const { pairingId, key } = await mintPairing({
            http, records, randomBytes: realRandom, relayUrl: RELAY,
        });
        await savePairing({ records, pairingId, key });

        const stored = await readPairing(records);
        assert.ok(stored, 'the responder cannot see the record the card wrote');
        assert.equal(stored.pairingId, 'prg-7f3c');
        // The responder hands `key` straight to fromBase64 and then to the AEAD,
        // so the encoding is part of the contract, not an implementation detail.
        assert.deepEqual([...fromBase64(stored.key)], [...key]);
        // At the type and id the responder looks under, and nowhere else.
        assert.equal(records._raw.get(MCP_PAIRING_ID).recordType, MCP_PAIRING_TYPE);
    });

    test('the pairing type is outside schema.js\'s RECORD map, so exports cannot carry the key', async () => {
        // store.exportAll() enumerates Object.values(RECORD). The one secret the
        // server never sees must not land in a plaintext export file.
        const { RECORD } = await import('../../../domain/schema.js');
        assert.equal(Object.values(RECORD).includes(MCP_PAIRING_TYPE), false);
    });
});

describe('Connect Claude — an abandoned code leaves nothing behind', () => {
    test('minting drops the record for the pairing it just replaced', async () => {
        // The server keeps one pairing per account, so minting kills the old one
        // — the record naming it is a tombstone from that moment. Dropping it
        // before the code is shown is what makes closing the screen safe: no
        // device is left holding a key for a pairing that cannot answer, and the
        // card honestly reads "not connected".
        const records = memoryRecords();
        await savePairing({ records, pairingId: 'prg-old', key: new Uint8Array(32).fill(7) });
        assert.ok(await readPairing(records));

        const { http } = recordingHttp(() => mintResponse('prg-new'));
        await mintPairing({ http, records, randomBytes: realRandom, relayUrl: RELAY });
        assert.equal(await readPairing(records), null, 'the replaced pairing is still stored');
    });

    test('nothing is stored until the user says they saved the code', async () => {
        const records = memoryRecords();
        const { http } = recordingHttp(() => mintResponse('prg-new'));
        const minted = await mintPairing({ http, records, randomBytes: realRandom, relayUrl: RELAY });
        assert.equal(await readPairing(records), null);
        await savePairing({ records, pairingId: minted.pairingId, key: minted.key });
        assert.equal((await readPairing(records)).pairingId, 'prg-new');
    });

    test('a refused mint stores nothing and says which failure it was', async () => {
        const records = memoryRecords();
        const { http } = recordingHttp(() => ({ ok: false, status: 401 }));
        await assert.rejects(
            mintPairing({ http, records, randomBytes: realRandom, relayUrl: RELAY }),
            /session has expired/
        );
        assert.equal(await readPairing(records), null);
    });

    test('a mint response with no pairing id is refused rather than coded around', async () => {
        const records = memoryRecords();
        const { http } = recordingHttp(() => ({ ok: true, status: 200, json: async () => ({}) }));
        await assert.rejects(
            mintPairing({ http, records, randomBytes: realRandom, relayUrl: RELAY }),
            /no pairing id/
        );
    });
});

describe('Connect Claude — disconnect revokes server-side AND drops the record', () => {
    test('the DELETE goes out and the stored key stops being readable', async () => {
        const records = memoryRecords();
        const mintHttp = recordingHttp(() => mintResponse('prg-abc'));
        const { pairingId, key } = await mintPairing({
            http: mintHttp.http, records, randomBytes: realRandom, relayUrl: RELAY,
        });
        await savePairing({ records, pairingId, key });

        // The two halves of onDisconnect, in its order.
        const delHttp = recordingHttp(() => ({ ok: true, status: 204 }));
        await revokePairing({ http: delHttp.http });
        await purgePairing(records);

        assert.deepEqual(delHttp.calls.map((c) => c.init.method), ['DELETE']);
        assert.equal(await readPairing(records), null);
        // A tombstone, not a hard delete — §3, or the next merge resurrects it —
        // and the body, which is where the key was, is gone with it.
        const row = records._raw.get(MCP_PAIRING_ID);
        assert.equal(row.deleted, true);
        assert.equal(row.key, undefined, 'the tombstone still carries the pairing key');
    });

    test('a server that refuses the revoke throws, so the card keeps the key', async () => {
        // Purging first would delete the only copy of the key while the relay
        // still routed the pairing: a shim that connects to a pairing nothing can
        // answer, which reaches the user as the design's own "no device online".
        const { http } = recordingHttp(() => ({ ok: false, status: 500 }));
        await assert.rejects(revokePairing({ http }), /would not revoke/);
    });
});

describe('Connect Claude — the copy states the three product facts', () => {
    // §11: these are not implementation details, and a user who discovers them
    // by being confused has been failed by this card.
    const all = () => CONNECTOR_FACTS.join(' ');

    test('answers need a live unlocked tab, and there is no fallback', () => {
        assert.match(all(), /open and unlocked/);
        assert.match(all(), /no server-side fallback/);
    });

    test('the relay sees size and timing but not content', () => {
        assert.match(all(), /cannot read/);
        assert.match(all(), /size and timing/);
    });

    test('the connector is read-only', () => {
        assert.match(all(), /read-only/);
        assert.match(all(), /cannot add, change or delete/);
    });
});

describe('Connect Claude — the card is wired to these functions', () => {
    // DOM-bound, and this project has no jsdom: the handlers are pinned at the
    // source, the way the quote-provider card's are above.
    const source = fs.readFileSync(SETTINGS_PATH, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');

    test('the card is rendered', () => {
        assert.match(source, /connectClaudeCard\(\),/);
    });

    test('the code is minted with the endpoint form of the relay URL', () => {
        assert.match(source, /relayUrl:\s*relayEndpoint\(window\.location\)/);
    });

    test('the key comes from crypto.getRandomValues', () => {
        assert.match(source, /randomBytes:\s*\(buf\)\s*=>\s*crypto\.getRandomValues\(buf\)/);
        assert.doesNotMatch(source, /Math\.random/);
    });

    test('the code is never stored anywhere but the DOM', () => {
        // A module-level variable holding it (the shape importCard uses for its
        // report) would survive the screen and defeat "shown once"; localStorage
        // would put the key outside the vault entirely.
        assert.doesNotMatch(source, /localStorage|sessionStorage/);
        assert.doesNotMatch(source, /^(let|var)\s+\w*[Cc]ode\b/m);
    });

    test('the code is never re-displayed from the stored record', () => {
        // formatPairingCode appears twice — the import and the one call inside
        // mintPairing. A third would be a "show it again" button, and the stored
        // record holds everything needed to build one.
        assert.equal(source.split('formatPairingCode').length - 1, 2);
    });

    test('disconnect revokes server-side and purges, in that order', () => {
        const disconnect = source.match(/async function onDisconnect\(\)[\s\S]*?\n {4}\}/);
        assert.ok(disconnect, 'onDisconnect not found');
        assert.match(disconnect[0], /await revokePairing\(\{ http \}\);\s*await purgePairing\(records\);/);
    });

    test('connect, finish and disconnect all re-run the responder without a reload', () => {
        assert.equal(source.split('refreshResponder({ records })').length - 1, 3);
    });
});

// --- The real Go parser ----------------------------------------------------
//
// The strongest evidence available from this side: a code minted by the shipped
// mintPairing, handed to the REAL cmd/mcpshim binary through the REAL
// environment variable, and accepted by the REAL Go parser. Nothing about the
// format is restated here — if the JS encoder and the Go decoder disagree by one
// byte, the shim refuses to start and this fails.
//
// The negative control is what makes the positive result mean anything: a
// one-character corruption of the same code must be REJECTED. Without it, a shim
// that accepted any string at all would pass just as well.
//
// Skipped where there is no Go toolchain, like mcp-shim-e2e.test.mjs.
const HAVE_GO = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;

describe('Connect Claude — the minted code parses in the real shim', { skip: !HAVE_GO }, () => {
    /**
     * Start the real binary with `code` in the environment and report how far it
     * got: 'started' means the parser accepted it and the stdio server came up,
     * 'rejected' means it exited on the code itself.
     */
    function runShim(binary, code) {
        return new Promise((resolve, reject) => {
            const child = spawn(binary, [], { env: { ...process.env, [MCP_CODE_ENV_VAR]: code } });
            let stderr = '';
            const settle = (outcome) => {
                clearTimeout(timer);
                child.kill('SIGKILL');
                resolve({ outcome, stderr });
            };
            const timer = setTimeout(() => settle('hung'), 20000);
            child.stdout.on('data', () => {});
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
                if (stderr.includes('starting stdio MCP server')) settle('started');
            });
            child.on('error', reject);
            child.on('exit', () => { clearTimeout(timer); resolve({ outcome: 'rejected', stderr }); });
        });
    }

    test('the real binary accepts it, and rejects it one character wrong', async (t) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'mcpshim-c5-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const binary = path.join(dir, 'mcpshim');
        const build = spawnSync('go', ['build', '-o', binary, './cmd/mcpshim'], {
            cwd: REPO_ROOT, encoding: 'utf8',
        });
        assert.equal(build.status, 0, `go build failed: ${build.stderr}`);

        const records = memoryRecords();
        // Shaped like a real one: generatePairingID (internal/server/mcp_relay.go)
        // returns base64url over 16 bytes, so "-" and "_" are ordinary in an id.
        const { http } = recordingHttp(() => mintResponse('a-_9ZmQrS1tuVwx2Y3Z0Aw'));
        const { code, key } = await mintPairing({
            http,
            records,
            randomBytes: realRandom,
            // Exactly what this card would mint for an https origin.
            relayUrl: relayEndpoint({ protocol: 'https:', host: 'portfolio.example' }),
        });

        const ok = await runShim(binary, code);
        assert.equal(ok.outcome, 'started', `the real shim rejected a code this card minted:\n${ok.stderr}`);
        // And it echoed neither the code nor the key into its diagnostics.
        for (const encoded of keyEncodings(key)) {
            assert.equal(ok.stderr.includes(encoded), false, 'the shim logged the pairing key');
        }
        assert.equal(ok.stderr.includes(code), false, 'the shim logged the pairing code');

        // Negative control: flip one character inside the body.
        const at = code.length - 12;
        const flipped = code.slice(0, at) + (code[at] === 'A' ? 'B' : 'A') + code.slice(at + 1);
        const bad = await runShim(binary, flipped);
        assert.equal(bad.outcome, 'rejected', 'the shim started on a corrupted code');
        assert.match(bad.stderr, new RegExp(`invalid ${MCP_CODE_ENV_VAR}`));
    });
});
