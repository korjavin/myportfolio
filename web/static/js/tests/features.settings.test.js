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
import { RECORD, SETTINGS_ID, newRecordId } from '../../../domain/schema.js';
import { createFxRates } from '../../../domain/fx.js';
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
    HOSTED_CONSENT, CONNECTOR_DOCS,
    hostedConnectorURL, readHostedConnector, enableHostedConnector, disableHostedConnector,
    sampleRecords, sampleLoaded, sampleConfirm, sampleRemoveConfirm, isSampleId, ownForeignCurrency,
} = await import('../features/settings.js');

// The same module instance settings.js holds, so `useRecords` below swaps the
// port the card's own importRecords writes through.
const store = await import('../features/store.js');
const { demoRecords } = await import('../features/demo.js');
// The port store.js starts on, so the swap below can be put back. Dynamic like
// the rest: core/localdb.js opens a Dexie handle at module load and the stub
// above is only in place once this file's static imports have run.
const { localRecords } = await import('../core/localdb.js');

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

    test('finish and disconnect re-run the responder without a reload, and nothing else does', () => {
        // Exactly two calls, and the count is the assertion. A third — the
        // obvious one, right after minting — is dropped by mcp-responder's
        // `electing` guard if its election is still in flight, and takes
        // Finish's call down with it: a saved pairing that answers nothing
        // until a reload. See the comment in onConnect.
        //
        // One of the two is inside adoptPairing, which is how BOTH tiers store a
        // key and start answering with it — Finish and the hosted connector's
        // enable. That is why enabling the hosted connector did not need a third.
        assert.equal(source.split('refreshResponder({ records })').length - 1, 2);
        assert.match(source, /async function adoptPairing[\s\S]*?await savePairing\([\s\S]*?refreshResponder\(\{ records \}\)/);
        for (const fn of ['async function onDisconnect', 'busy(\'Storing the key…\')']) {
            assert.ok(source.includes(fn), `${fn} not found`);
        }
    });
});

// ===========================================================================
// The hosted connector (bd myportfolio-9f1.3, ARCHITECTURE.md §11 Tier 2)
// ===========================================================================
//
// The URL a user pastes into claude.ai or ChatGPT. This tier is NOT zero
// knowledge: the server holds the pairing key and sees questions and answers in
// plaintext in transit. Everything below exists to keep two things true — the
// user is told that at the moment they choose it, and the URL behaves like the
// capability it is.

describe('The hosted connector — the URL is the route the server actually serves', () => {
    test('it is this origin plus the /mcp/<token> route from server.go', () => {
        // Derived from the registered route, not from a copy of it here: moving
        // the route then breaks this test rather than breaking every user's URL.
        const route = fs.readFileSync(SERVER_PATH, 'utf8').match(/mux\.Handle\("POST (\/mcp)\/\{token\}"/);
        assert.ok(route, 'no POST /mcp/{token} route found in internal/server/server.go');
        assert.equal(
            hostedConnectorURL({ origin: 'https://p.example' }, 'tok-123'),
            `https://p.example${route[1]}/tok-123`
        );
    });

    test('it uses the page\'s own origin, so a local http server gets an http URL', () => {
        // The server cannot compose this: behind a TLS-terminating proxy it sees
        // only http, and a URL with the wrong scheme is a connector that never
        // connects.
        assert.equal(hostedConnectorURL({ origin: 'http://localhost:8080' }, 'tok'), 'http://localhost:8080/mcp/tok');
    });
});

describe('The hosted connector — the key crosses the wire exactly once, on enable', () => {
    const PAIRING = { pairingId: 'prg-abc', key: toBase64(new Uint8Array(32).fill(9)) };

    test('reading the state, enabling and revoking: only the enable carries the key', async () => {
        const { http, calls } = recordingHttp((url, init) => (init?.method === 'DELETE'
            ? { ok: true, status: 204 }
            : { ok: true, status: 200, json: async () => ({ token: 'tok-123' }) }));

        await readHostedConnector({ http });
        await enableHostedConnector({ http, pairing: PAIRING, relayUrl: RELAY });
        await disableHostedConnector({ http });

        assert.deepEqual(
            calls.map((c) => [c.url, c.init?.method ?? 'GET']),
            [['/api/mcp/remote', 'GET'], ['/api/mcp/remote', 'POST'], ['/api/mcp/remote', 'DELETE']]
        );
        const carrying = calls.filter((c) => String(c.init?.body ?? '').includes(PAIRING.key));
        assert.equal(carrying.length, 1, 'the pairing key crossed the wire more than once, or not at all');
        assert.equal(carrying[0].init.method, 'POST');
        // The other two have no body at all, so there is nothing in them to leak.
        assert.equal(calls[0].init?.body, undefined);
        assert.equal(calls[2].init.body, undefined);
    });

    test('the enable body is the pairing, unchanged, plus this origin\'s relay endpoint', async () => {
        const { http, calls } = recordingHttp(() => ({ ok: true, status: 200, json: async () => ({ token: 'tok' }) }));
        await enableHostedConnector({ http, pairing: PAIRING, relayUrl: RELAY });

        // The field names the Go handler decodes (hostedConnectorRequest), and the
        // key in the base64 the record already holds — nothing re-encodes it, so
        // there is no second encoding to disagree about.
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            relay_url: RELAY, pairing_id: 'prg-abc', key: PAIRING.key,
        });
    });

    test('a server that returns no token is refused rather than shown as a URL', async () => {
        // hostedConnectorURL would happily render "<origin>/mcp/", which 404s at
        // the route and reads to the user as a broken connector.
        const { http } = recordingHttp(() => ({ ok: true, status: 200, json: async () => ({}) }));
        await assert.rejects(
            enableHostedConnector({ http, pairing: PAIRING, relayUrl: RELAY }),
            /no connector URL/
        );
    });

    test('an expired session says so, on every one of the three', async () => {
        const { http } = recordingHttp(() => ({ ok: false, status: 401 }));
        await assert.rejects(readHostedConnector({ http }), /session has expired/);
        await assert.rejects(enableHostedConnector({ http, pairing: PAIRING, relayUrl: RELAY }), /session has expired/);
        await assert.rejects(disableHostedConnector({ http }), /would not revoke/);
    });

    test('off is an empty token, not an error', async () => {
        const { http } = recordingHttp(() => ({ ok: true, status: 200, json: async () => ({ token: '' }) }));
        assert.equal(await readHostedConnector({ http }), '');
    });
});

describe('The hosted connector — revoking hits the route that drops the key', () => {
    test('the DELETE goes to the route server.go wires to disableHostedConnector', async () => {
        // The Go side proves that handler drops the row, the sealed key and the
        // live entry (TestHostedConnectorRoutesEnableShowAndRevoke). This side
        // proves the button reaches it — hiding the URL while the server kept the
        // key would look identical in the browser.
        const server = fs.readFileSync(SERVER_PATH, 'utf8');
        const route = server.match(/mux\.HandleFunc\("DELETE (\/api\/mcp\/remote)"[\s\S]{0,200}?disableHostedConnector/);
        assert.ok(route, 'no DELETE /api/mcp/remote route wired to disableHostedConnector in internal/server/server.go');

        const { http, calls } = recordingHttp(() => ({ ok: true, status: 204 }));
        await disableHostedConnector({ http });
        assert.deepEqual(calls.map((c) => [c.url, c.init.method]), [[route[1], 'DELETE']]);
    });

    test('it does NOT touch the relay pairing, which the local shim shares', async () => {
        // One request, and it is not /api/mcp/pairings. Revoking the shared
        // pairing here would disconnect a cmd/mcpshim the user is still running
        // and never asked to touch.
        const { http, calls } = recordingHttp(() => ({ ok: true, status: 204 }));
        await disableHostedConnector({ http });
        assert.equal(calls.length, 1);
        assert.equal(calls.some((c) => c.url.includes('/api/mcp/pairings')), false);
    });
});

describe('The hosted connector — the consent names the trade AND the alternative', () => {
    // These were written against a six-sentence consent and are now written
    // against one, because the owner was right that nobody read the six. The
    // PROPERTIES did not change and none was dropped — what changed is that they
    // are pinned as properties rather than as the exact phrasing that carried
    // them, so the copy can stay short without the guard going quiet.
    //
    // The two facts that must survive any future edit: the server can read the
    // traffic, and there is a named alternative that does not. Everything the
    // long version also said (sealed at rest, what the relay learns, why the
    // shape is the shape) moved to docs/AI-CONNECTOR.md, which is linked from the
    // card and is allowed to be long.

    test('it is ONE short sentence — this is the point of the copy, so it is pinned', () => {
        // Sentence-enders, not em dashes or semicolons: those keep it one
        // sentence to read. A second '. ' is an essay starting again.
        assert.equal(HOSTED_CONSENT.split(/[.!?](\s|$)/).filter((s) => s.trim()).length, 1,
            `the consent is more than one sentence again:\n${HOSTED_CONSENT}`);
        assert.ok(HOSTED_CONSENT.length <= 200, `${HOSTED_CONSENT.length} chars is drifting back to an essay`);
    });

    test('it says the server can read the traffic, and when', () => {
        // The load-bearing risk. "Involves risks" would be worse than silence:
        // a warning naming no risk cannot be weighed against the alternative.
        assert.match(HOSTED_CONSENT, /pairing key/);
        assert.match(HOSTED_CONSENT, /read your questions and answers/);
        assert.match(HOSTED_CONSENT, /in transit/);
    });

    test('it says this is weaker, and never claims end-to-end or zero knowledge', () => {
        // §11: not zero knowledge, "and must never be described as such" — and
        // not end-to-end encrypted either. The old copy shouted "NOT end-to-end
        // encrypted"; "can read your questions and answers" is the same fact
        // without the jargon, so the phrase is gone and the negative guards are
        // what keep the claim from ever appearing.
        assert.match(HOSTED_CONSENT, /weaker/);
        assert.doesNotMatch(HOSTED_CONSENT, /zero.knowledge/i);
        assert.doesNotMatch(HOSTED_CONSENT, /end.to.end/i);
        assert.doesNotMatch(HOSTED_CONSENT, /encrypted/i);
    });

    test('it names Tier 1 as the alternative that keeps the guarantee', () => {
        // "Weaker" without naming what it is weaker than is a shrug. The name has
        // to be the one on the button above it in the same card.
        assert.match(HOSTED_CONSENT, /Connect Claude/);
        const settings = fs.readFileSync(SETTINGS_PATH, 'utf8');
        assert.ok(settings.includes("'Connect Claude'"), 'the alternative names a button that is not there');
    });

    test('the detail the sentence dropped is in the doc it links to, not nowhere', () => {
        // The cut is only honest if the essay landed somewhere. The link target
        // is checked as a file, so a rename cannot leave the card pointing at a
        // 404 while this passes.
        const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/AI-CONNECTOR.md'), 'utf8');
        assert.match(doc, /sealed at rest/);
        assert.match(doc, /in transit/);
        assert.match(CONNECTOR_DOCS, /docs\/AI-CONNECTOR\.md$/);
        const settings = fs.readFileSync(SETTINGS_PATH, 'utf8');
        assert.ok(settings.includes('docsLink('), 'the consent cuts detail and links nowhere');
    });
});

describe('The hosted connector — the card is wired to these functions', () => {
    const source = fs.readFileSync(SETTINGS_PATH, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');

    test('the section is painted in both connected states', () => {
        // Both, or a user who has connected the shim cannot find the hosted
        // option at all.
        assert.equal(source.split('...hostedSection(hostedToken)').length - 1, 2);
        assert.match(source, /hostedToken = await readHostedConnector\(\{ http \}\)/);
    });

    test('a state read that failed shows as unknown, never as off', () => {
        // Offline is an ordinary state for a PWA, and rendering it as "off" would
        // invite a user to enable a connector that is already on — which rotates
        // the token and silently breaks the URL they already pasted into Claude.
        // It is also why the failed read is swallowed instead of taking the whole
        // card down: the local connector needs no network to render.
        assert.match(source, /if \(token === null\)/);
        assert.match(source, /let hostedToken = null;\s*try \{[\s\S]*?\} catch \{\s*hostedToken = null;\s*\}/);
    });

    test('enabling is only reachable through the consent dialog', () => {
        // The load-bearing one. onHostedEnable appears exactly twice — its own
        // definition and the confirm's onConfirm — so there is no button that
        // hands the key over without showing HOSTED_CONSENT first.
        assert.equal(source.split('onHostedEnable').length - 1, 2);
        assert.match(source, /function confirmHostedEnable\(\)[\s\S]*?message: HOSTED_CONSENT[\s\S]*?onConfirm: onHostedEnable/);
    });

    test('revoking is only reachable through its own confirm', () => {
        assert.equal(source.split('onHostedDisable').length - 1, 2);
        assert.match(source, /function confirmHostedDisable\(\)[\s\S]*?onConfirm: onHostedDisable/);
    });

    test('the URL is rendered as text, never as markup, and never logged', () => {
        // It is a capability: ui.el sets textContent, and nothing in this file
        // may put one in innerHTML or a console line.
        assert.match(source, /ui\.el\('div', 'wg-code-block mt-md', url\)/);
        assert.doesNotMatch(source, /innerHTML/);
        assert.doesNotMatch(source, /console\./);
    });

    test('an existing pairing is reused rather than re-minted', () => {
        // Re-minting revokes the pairing, so asking for a URL would stop a shim
        // the user is running right now.
        assert.match(source, /async function ensurePairing\(\)[\s\S]*?const existing = await readPairing\(records\);\s*if \(existing\) return existing;/);
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
            // 'close', not 'exit': 'exit' fires while the pipes may still hold
            // buffered output, so the negative control below resolved with an
            // empty `stderr` roughly one full-suite run in three and failed on
            // the message it was asserting. 'close' is the event that waits for
            // stdio to drain.
            child.on('close', () => { clearTimeout(timer); resolve({ outcome: 'rejected', stderr }); });
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

// ===========================================================================
// The sample portfolio (bd myportfolio-cnd.6, ARCHITECTURE.md §12)
// ===========================================================================
//
// The supported way to try the Claude connector on demo data: `?demo=1` never
// answers MCP calls, so a signed-in user loads the fixture into their OWN vault
// instead. What has to hold, and what each of these pins:
//
//   • the written set IS demoRecords(), minus the one record whose id collides
//     with something the user already owns (the §4 settings singleton, which
//     carries their API keys);
//   • nothing is written without a confirmation that names the record count and
//     says the data is invented;
//   • a second load updates in place rather than duplicating;
//   • loading over existing data destroys none of it;
//   • the removal takes exactly the sample back out and nothing else.
//
// The first four are exercised against the SHIPPED importRecords over the real
// §3 port; only the DOM wiring is a source guard, because there is no jsdom.

const SAMPLE_TODAY = '2026-03-17';
const SAMPLE_SEED = demoRecords({ today: SAMPLE_TODAY });

/** Every live row in a port, flattened across the record types in play. */
async function liveRows(port) {
    const types = new Set([
        ...SAMPLE_SEED.map((r) => r.recordType),
        RECORD.settings, RECORD.account, RECORD.security, RECORD.transaction,
    ]);
    const lists = await Promise.all([...types].map((t) => port.list(t)));
    return lists.flat();
}

const idsOf = (rows) => new Set(rows.map((r) => r.recordId));

/** Bodies only — the port owns recordId/recordType/clientTs/deleted. */
function bodyOf(rec) {
    const { recordId, recordType, clientTs, deleted, ...body } = rec;
    return body;
}

describe('sample portfolio — what gets written', () => {
    test('it is demoRecords() minus the settings singleton, and nothing else', () => {
        const written = sampleRecords(SAMPLE_SEED);
        const dropped = SAMPLE_SEED.filter((r) => !written.includes(r));
        assert.equal(dropped.length, 1, 'exactly one record is held back');
        assert.equal(dropped[0].recordType, RECORD.settings);
        assert.equal(dropped[0].recordId, SETTINGS_ID);
        // Order and identity preserved for everything else: the fixture is the
        // input, not something restated here.
        assert.deepEqual(written, SAMPLE_SEED.filter((r) => r.recordId !== SETTINGS_ID));
    });

    test('every fixture id is one isSampleId claims, so removal can be exact', () => {
        // Two things ride on this: a second load updates rather than duplicating
        // (an id that looked ordinary would overwrite a real record instead), and
        // the removal can find what was written without storing a manifest.
        for (const rec of sampleRecords(SAMPLE_SEED)) {
            assert.equal(isSampleId(rec.recordId), true, `${rec.recordId} is not claimed as sample data`);
        }
    });

    test('isSampleId claims nothing the rest of the app mints', () => {
        // §4 newRecordId, ppimport's derived ids, and — the one that matters —
        // fx.js's own ECB rows, which cover the same PAIR-DAYS as the fixture's
        // and would be deleted with it if the two shapes were confused.
        assert.equal(isSampleId(newRecordId(RECORD.transaction, 1750000000000)), false);
        assert.equal(isSampleId('security_pp_9f2c1a0b3d4e5f60'), false);
        assert.equal(isSampleId('fx_EURUSD_2024-05-03'), false, 'the ECB fetcher\'s rows are not sample data');
        assert.equal(isSampleId(SETTINGS_ID), false);
        assert.equal(isSampleId(undefined), false);
    });

    test('sampleLoaded reads the real fixture off state, not a restated id', () => {
        const rows = sampleRecords(SAMPLE_SEED);
        const byType = (t) => rows.filter((r) => r.recordType === t);
        assert.equal(sampleLoaded({ securities: byType(RECORD.security) }), true);
        assert.equal(sampleLoaded({ accounts: byType(RECORD.account) }), true);
        assert.equal(sampleLoaded({ transactions: byType(RECORD.transaction) }), true);
        assert.equal(sampleLoaded({}), false);
        assert.equal(sampleLoaded(), false);
        assert.equal(sampleLoaded({ securities: [{ recordId: 'security_1234' }] }), false);
    });
});

describe('sample portfolio — the fixture\'s invented FX must not reach real holdings', () => {
    // The bug codex review found, and the reason the `fx` records are
    // conditional. An `fx` record is looked up by (pair, date) and never by
    // recordId, so the fixture's five years of EURUSD fixings are the one part of
    // it that its id namespace does not isolate.

    test('a fixture rate silently beats the real ECB fixing for the same day', () => {
        // Not a claim about fx.js — a call into it. fx.js's refresh writes
        // `fx_EURUSD_<iso>`; demo.js writes `fx_eurusd_<yyyymmdd>` for the same
        // pair-day, so the ids differ and no re-fetch ever overwrites it.
        const real = {
            recordId: 'fx_EURUSD_2024-05-03', pair: 'EURUSD', date: '2024-05-03', rate: 107000000,
        };
        const fake = {
            recordId: 'fx_eurusd_20240503', pair: 'EURUSD', date: '2024-05-03', rate: 119000000,
        };
        const issues = [];
        const both = createFxRates([real, fake], (code, id, msg) => issues.push({ code, id, msg }));
        assert.deepEqual(issues, [], 'a duplicate pair-day is not reported as a problem');
        assert.notDeepEqual(
            both.rate('USD', 'EUR', '2024-05-03'),
            createFxRates([real]).rate('USD', 'EUR', '2024-05-03'),
            'if a duplicate pair-day were harmless the fx conditional would be unnecessary'
        );
    });

    test('the rates are withheld when the user holds a foreign currency', () => {
        const mine = { securities: [{ recordId: 'security_pp_abc', name: 'Apple', currency: 'USD' }] };
        assert.equal(ownForeignCurrency(mine, 'EUR'), 'USD');

        const rows = sampleRecords(SAMPLE_SEED, { fx: !ownForeignCurrency(mine, 'EUR') });
        assert.deepEqual(rows.filter((r) => r.recordType === RECORD.fx), []);
        // And nothing else is dropped with them.
        assert.deepEqual(rows, sampleRecords(SAMPLE_SEED).filter((r) => r.recordType !== RECORD.fx));
    });

    test('a pure-EUR vault keeps them, so the sample still demonstrates conversion', () => {
        const mine = {
            accounts: [{ recordId: 'account_pp_1', currency: 'EUR' }],
            securities: [{ recordId: 'security_pp_1', currency: 'EUR' }],
            transactions: [{ recordId: 'transaction_pp_1', currency: 'EUR' }],
        };
        assert.equal(ownForeignCurrency(mine, 'EUR'), null);
        const rows = sampleRecords(SAMPLE_SEED, { fx: !ownForeignCurrency(mine, 'EUR') });
        assert.ok(rows.some((r) => r.recordType === RECORD.fx));
        assert.deepEqual(rows, sampleRecords(SAMPLE_SEED));
    });

    test('a previously loaded sample is not mistaken for the user\'s own USD holding', () => {
        // The fixture itself holds a USD security. Counting it would make every
        // reload drop the rates the first load wrote, and the sample would go
        // unconverted for no reason at all.
        const rows = sampleRecords(SAMPLE_SEED);
        const asState = {
            accounts: rows.filter((r) => r.recordType === RECORD.account),
            securities: rows.filter((r) => r.recordType === RECORD.security),
            transactions: rows.filter((r) => r.recordType === RECORD.transaction),
        };
        assert.ok(
            asState.securities.some((s) => s.currency === 'USD'),
            'the fixture no longer holds a foreign security — this test guards nothing'
        );
        assert.equal(ownForeignCurrency(asState, 'EUR'), null);
    });

    test('a non-EUR reporting currency counts the user\'s EUR records as foreign', () => {
        // Correct, and deliberately blunt: the fixture can convert nothing into
        // CHF anyway, so withholding is both safe and no loss.
        assert.equal(ownForeignCurrency({ accounts: [{ recordId: 'account_pp_1', currency: 'EUR' }] }, 'CHF'), 'EUR');
    });
});

describe('sample portfolio — the confirmation', () => {
    test('it names the real count, calls the data invented, and says how to undo it', () => {
        const count = sampleRecords(SAMPLE_SEED).length;
        const { title, message, confirmLabel } = sampleConfirm({ count, hasData: false });
        assert.match(title, /sample portfolio/i);
        assert.ok(confirmLabel);
        // The count, not a rounded "~1900": a user agreeing to write into a vault
        // that syncs is told the actual number.
        assert.ok(message.includes(String(count)), `the count ${count} is not in the message`);
        assert.match(message, /invented|made-up|fabricated/i);
        assert.match(message, /sync/i);
        assert.match(message, /remove/i);
        assert.match(message, /none of it is real/i);
        // The rates are written in this branch, so the copy must not claim the
        // sample will show unconverted.
        assert.doesNotMatch(message, /unconverted/i);
    });

    test('withholding the rates is stated, not silent', () => {
        const plain = sampleConfirm({ count: 10, hasData: true }).message;
        const held = sampleConfirm({ count: 10, hasData: true, withheldFx: 'USD' }).message;
        assert.notEqual(plain, held);
        assert.match(held, /USD/);
        assert.match(held, /unconverted/i);
        // The reassurance that matters: their own numbers do not move.
        assert.match(held, /nothing of yours changes value/i);
        // …which is only true because a withholding load also cleans up rates an
        // earlier load wrote. The copy has to promise that, because it is the
        // difference between a protection and a wish.
        assert.match(held, /an earlier load left behind are deleted/i);
    });

    test('with data already in the vault it says so instead of staying quiet', () => {
        const count = sampleRecords(SAMPLE_SEED).length;
        const empty = sampleConfirm({ count, hasData: false }).message;
        const full = sampleConfirm({ count, hasData: true }).message;
        assert.notEqual(empty, full);
        assert.match(full, /nothing you already have is deleted/i);
        assert.match(full, /mixed together/i);
    });

    test('the removal confirmation names the count and what it spares', () => {
        const { message } = sampleRemoveConfirm(7);
        assert.ok(message.includes('7'));
        assert.match(message, /untouched|stays/i);
    });
});

describe('sample portfolio — through the shipped importRecords and the real port', () => {
    // store.js keeps the port behind a module-level `impl`; useRecords is the
    // documented swap. Restore the default afterwards so the rest of the suite
    // is unaffected.
    async function withPort(seedRows, fn) {
        const port = memoryRecords();
        for (const rec of seedRows) await port.put(rec.recordType, rec.recordId, bodyOf(rec));
        store.useRecords(port);
        try {
            return await fn(port);
        } finally {
            store.useRecords(localRecords);
        }
    }

    test('the written set is exactly sampleRecords(demoRecords())', async () => {
        const want = sampleRecords(SAMPLE_SEED);
        await withPort([], async (port) => {
            const written = await store.importRecords(want);
            assert.equal(written, want.length);
            // refresh() swallows its own failures into state.error, so a domain
            // that could not read this back would otherwise pass silently.
            assert.equal(store.state.error, null);

            const live = await liveRows(port);
            assert.deepEqual(idsOf(live), idsOf(want));
            const byId = new Map(live.map((r) => [r.recordId, r]));
            for (const rec of want) {
                assert.deepEqual(bodyOf(byId.get(rec.recordId)), bodyOf(rec), rec.recordId);
                assert.equal(byId.get(rec.recordId).recordType, rec.recordType);
            }
            // The settings singleton was never created.
            assert.deepEqual(await port.list(RECORD.settings), []);
        });
    });

    test('a second load updates in place instead of duplicating', async () => {
        const want = sampleRecords(SAMPLE_SEED);
        await withPort([], async (port) => {
            await store.importRecords(want);
            const first = await liveRows(port);
            await store.importRecords(want);
            const second = await liveRows(port);
            assert.equal(second.length, first.length);
            assert.deepEqual(idsOf(second), idsOf(first));
            // Same bodies too — demoRecords is deterministic for a given `today`,
            // so a second press must be a no-op in everything but clientTs.
            const byId = new Map(first.map((r) => [r.recordId, bodyOf(r)]));
            for (const rec of second) assert.deepEqual(bodyOf(rec), byId.get(rec.recordId), rec.recordId);
        });
    });

    test('loading over existing data destroys none of it, including the API keys', async () => {
        // A real portfolio: the user's settings (with a credential in them), an
        // account, a security and a transaction, all with ordinary ids.
        const mine = [
            {
                recordId: SETTINGS_ID, recordType: RECORD.settings, clientTs: 1, deleted: false,
                reportingCurrency: 'CHF', quoteProviders: { twelvedata: { apiKey: 'MY-REAL-KEY' } },
            },
            {
                recordId: 'account_mine', recordType: RECORD.account, clientTs: 2, deleted: false,
                name: 'My cash', kind: 'cash', currency: 'CHF', closed: false,
            },
            {
                recordId: 'security_mine', recordType: RECORD.security, clientTs: 3, deleted: false,
                name: 'My ETF', ticker: 'MINE', currency: 'CHF', quote: {},
            },
            {
                recordId: 'tx_mine', recordType: RECORD.transaction, clientTs: 4, deleted: false,
                type: 'deposit', accountId: 'account_mine', date: '2025-01-02',
                amount: 500000, currency: 'CHF',
            },
        ];

        await withPort(mine, async (port) => {
            await store.importRecords(sampleRecords(SAMPLE_SEED));
            const live = await liveRows(port);
            const byId = new Map(live.map((r) => [r.recordId, r]));
            for (const rec of mine) {
                assert.ok(byId.has(rec.recordId), `${rec.recordId} was destroyed`);
                assert.deepEqual(bodyOf(byId.get(rec.recordId)), bodyOf(rec), rec.recordId);
            }
            // The one that would otherwise have been silently rewritten.
            assert.equal(byId.get(SETTINGS_ID).reportingCurrency, 'CHF');
            assert.deepEqual(
                byId.get(SETTINGS_ID).quoteProviders,
                { twelvedata: { apiKey: 'MY-REAL-KEY' } }
            );
        });
    });

    /** The card's remove ceremony: read the vault, tombstone what is claimed. */
    async function removeSample(port) {
        const lists = await Promise.all(Object.values(RECORD).map((t) => port.list(t)));
        const rows = lists.flat().filter((r) => isSampleId(r.recordId));
        for (const rec of rows) await port.del(rec.recordType, rec.recordId);
        return rows.length;
    }

    test('the removal takes the sample out and leaves the rest', async () => {
        const mine = [
            {
                recordId: SETTINGS_ID, recordType: RECORD.settings, clientTs: 1, deleted: false,
                reportingCurrency: 'EUR',
            },
            {
                recordId: 'tx_mine', recordType: RECORD.transaction, clientTs: 2, deleted: false,
                type: 'deposit', accountId: 'account_mine', date: '2025-01-02',
                amount: 500000, currency: 'EUR',
            },
            // The user's own ECB rate for a day the fixture also covers. It must
            // survive: the fixture's row for the same pair-day is a different
            // record, and confusing the two shapes would delete a real fixing.
            {
                recordId: 'fx_EURUSD_2024-05-03', recordType: RECORD.fx, clientTs: 3, deleted: false,
                pair: 'EURUSD', date: '2024-05-03', rate: 107000000,
            },
        ];
        await withPort(mine, async (port) => {
            const want = sampleRecords(SAMPLE_SEED);
            await store.importRecords(want);
            assert.equal(await removeSample(port), want.length);
            assert.deepEqual(idsOf(await liveRows(port)), idsOf(mine));
        });
    });

    test('reloading after acquiring a foreign holding purges the rates already written', async () => {
        // The hole codex found in the first fix: withholding the rates from the
        // new seed does nothing about the ones a pure-EUR load already wrote, and
        // those are exactly the rows that revalue the holding the user just
        // acquired. The load path is the cure, not just a non-cause.
        const withFx = sampleRecords(SAMPLE_SEED);
        const withoutFx = sampleRecords(SAMPLE_SEED, { fx: false });
        assert.ok(withFx.length > withoutFx.length, 'the fixture ships no fx records to withhold');

        await withPort([], async (port) => {
            // Day one: a pure-EUR vault, so the rates are written.
            await store.importRecords(withFx);
            assert.ok((await port.list(RECORD.fx)).length > 0);

            // Day two: the user imports a dollar holding, then presses reload.
            // What the card's plan + apply do, in that order.
            const mine = { securities: [{ recordId: 'security_pp_abc', currency: 'USD' }] };
            const foreign = ownForeignCurrency(mine, 'EUR');
            assert.equal(foreign, 'USD');
            const purge = (await Promise.all([RECORD.fx].map((t) => port.list(t))))
                .flat().filter((r) => isSampleId(r.recordId));
            assert.ok(purge.length > 0, 'nothing to purge — the setup did not write the rates');
            for (const rec of purge) await port.del(rec.recordType, rec.recordId);
            await store.importRecords(sampleRecords(SAMPLE_SEED, { fx: !foreign }));

            // No invented rate is left anywhere in the vault.
            assert.deepEqual(await port.list(RECORD.fx), []);
            // …and nothing else of the sample was collateral damage.
            assert.deepEqual(idsOf(await liveRows(port)), idsOf(withoutFx));
        });
    });

    test('a sample loaded on one day and removed on a later one leaves nothing behind', async () => {
        // The fixture's `fx` ids carry a date, so the five-year window moves with
        // `today`. Rebuilding today's fixture to decide what to delete would leave
        // the days that fell off the back behind — invented rates, permanently,
        // with the Remove button gone because the securities went.
        const march = sampleRecords(demoRecords({ today: '2026-03-17' }));
        const june = sampleRecords(demoRecords({ today: '2026-06-30' }));
        const stale = march.filter((r) => !june.some((s) => s.recordId === r.recordId));
        assert.ok(stale.length > 0, 'the fixture is no longer date-derived — this test guards nothing');

        await withPort([], async (port) => {
            await store.importRecords(march);
            assert.equal(await removeSample(port), march.length);
            assert.deepEqual(await liveRows(port), []);
        });
    });
});

describe('sample portfolio — the card is wired to these functions', () => {
    const source = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
    // Just this card, so a match cannot be satisfied by some other card's code.
    const section = stripped.slice(
        stripped.indexOf('export function isSampleId'),
        stripped.indexOf('function exportCard(')
    );

    test('the card is rendered', () => {
        assert.match(stripped, /sampleCard\(rerender\),/);
        assert.ok(section.length > 0);
    });

    test('nothing is written outside the confirmation', () => {
        // Every write in this card happens inside an `apply`, and ceremony() calls
        // apply() only from ui.confirm's onConfirm. Move either write out of its
        // apply, or apply() out of onConfirm, and these fail.
        assert.equal(section.split('importRecords(').length - 1, 1);
        assert.equal(section.split('records.del(').length - 1, 2, 'the purge and the removal');
        assert.match(section, /async \(\{ rows, purge \}\) => \{[\s\S]*?records\.del\([\s\S]*?importRecords\(rows\)/);
        assert.match(section, /async \(\{ rows \}\) => \{[\s\S]*?records\.del\(/);

        const ceremony = section.slice(
            section.indexOf('const ceremony ='),
            section.indexOf('const loaded =')
        );
        assert.equal(ceremony.split('apply(').length - 1, 1);
        assert.ok(ceremony.includes('ui.confirm('));
        assert.ok(
            ceremony.indexOf('onConfirm:') < ceremony.indexOf('apply('),
            'apply() must only run from ui.confirm\'s onConfirm'
        );
        assert.ok(
            ceremony.indexOf('ui.confirm(') < ceremony.indexOf('apply('),
            'the rows must not be written before the dialog opens'
        );
    });

    test('the settings singleton and the FX conditional come from the shipped filter', () => {
        assert.match(section, /sampleRecords\(seed, \{ fx: !foreign \}\)/);
        assert.match(section, /ownForeignCurrency\(state, reportingCurrency\(\)\)/);
        // The withheld-rate copy comes from sampleConfirm, not a second wording
        // built here.
        assert.match(section, /withheldFx: foreign/);
    });

    test('withholding the rates also purges the ones already in the vault', () => {
        assert.match(section, /purge: foreign \? await loadedSampleRows\(\[RECORD\.fx\]\) : \[\]/);
        // The purge is a WRITE, so it must sit inside apply with the rest — not in
        // the plan, which runs before the user has confirmed anything.
        const plan = section.slice(section.indexOf('const foreign ='), section.indexOf('async ({ rows, purge })'));
        assert.doesNotMatch(plan, /records\.del\(/, 'the plan must not delete anything');
    });

    test('both paths read the vault instead of rebuilding today\'s fixture', () => {
        assert.match(section, /await loadedSampleRows\(Object\.values\(RECORD\)\)/);
        assert.match(section, /\.filter\(\(r\) => isSampleId\(r\.recordId\)\)/);
        // The load path is the only place the fixture is built.
        assert.equal(section.split('demoRecords(').length - 1, 1, 'the fixture is built in one place');
    });

    test('the fixture is a dynamic import and never a static one', () => {
        // §12: demo.js is deliberately absent from PRECACHE so a user who never
        // presses this never downloads it. A static import would pull the whole
        // fixture into the shell's module closure.
        assert.match(section, /await import\('\.\/demo\.js'\)/);
        assert.doesNotMatch(source, /^import[^\n]*['"]\.\/demo\.js['"]/m);
    });

    test('`today` is the same expression boot.js\'s demo branch passes', () => {
        // A fixture seeded against a wrong "today" ends its performance range in
        // the past (bd myportfolio-cnd.5). Read out of boot.js rather than
        // restated here, so the two cannot drift apart.
        const boot = fs.readFileSync(path.join(REPO_ROOT, 'web/static/js/features/boot.js'), 'utf8');
        const today = boot.match(/today:\s*(new Date\(\)[^\n]*?\(0, 10\))/);
        assert.ok(today, 'boot.js no longer passes `today` in a shape this can compare against');
        assert.ok(
            section.includes(`today: ${today[1]}`),
            `the card must pass the same today as boot.js: ${today[1]}`
        );
    });

    test('the removal goes through the §3 port, not a bespoke upload', () => {
        assert.match(section, /records\.del\(rec\.recordType, rec\.recordId\)/);
        assert.doesNotMatch(section, /fetch\(|\/api\//);
    });
});
