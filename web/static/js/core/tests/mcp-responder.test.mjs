// The in-browser responder: dispatch, the frame budget, and the close-code scar
// tissue (bd myportfolio-ybp.4, ARCHITECTURE.md §11). `node --test` from web/.
//
// The socket is faked and the crypto is real. That split is deliberate: the wire
// format is already pinned cross-language by mcp-frame.test.mjs and driven
// end-to-end against the built shim binary by mcp-shim-e2e.test.mjs, so what is
// left worth testing here is the behaviour a real socket would only make slower
// to reach — what happens on each close code, what URL is dialled, and what a
// model can actually read when something goes wrong.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// Node 18 keeps globalThis.crypto behind a flag; the browser always has it.
globalThis.crypto ??= nodeCrypto.webcrypto;

const REPO = new URL('../../../../../', import.meta.url);
const src = (rel) => readFileSync(new URL(rel, REPO), 'utf8');

let R;
let C;
let catalog;
before(async () => {
    R = await import('../mcp-responder.js');
    C = await import('../crypto.js');
    catalog = await import('../mcp-catalog.js');
});

const enc = new TextEncoder();
const dec = new TextDecoder();

const KEY = new Uint8Array(32).fill(7);
const PAIRING = 'prg-7f3c1b9e42d05a68';

// A dispatcher over a stub runner: dispatch is what this file tests, not the
// domain. mcp-catalog.test.mjs runs the real engines.
const stubRun = async (opId, params) => ({ ran: opId, params: params ?? null });

// --- mcp_help ---------------------------------------------------------------

describe('mcp_help', () => {
    it('with no arguments returns the whole catalog with its parameters and the usage protocol', () => {
        const out = R.buildHelp({});
        assert.equal(out.count, catalog.CATALOG.length);
        assert.deepEqual(out.operations.map((o) => o.id), catalog.CATALOG.map((o) => o.id));
        for (const op of out.operations) assert.ok(op.params, `${op.id} came back with no params`);
        assert.equal(out.usage_protocol, R.USAGE_PROTOCOL);
        assert.deepEqual(out.topics, catalog.TOPICS);
    });

    it('the usage protocol states the three things a model cannot discover by trying', () => {
        assert.match(R.USAGE_PROTOCOL, /READ-ONLY/);
        assert.match(R.USAGE_PROTOCOL, /no mcp_execute/i);
        assert.match(R.USAGE_PROTOCOL, /unlocked browser tab/);
        // The money rule has to be here too: mcp_help with no args is the one
        // response every agent reads before it reads any operation description.
        assert.match(R.USAGE_PROTOCOL, /Units/);
    });

    it('drills into one operation by id', () => {
        const out = R.buildHelp({ operation_id: 'portfolio.summary' });
        assert.equal(out.count, 1);
        assert.equal(out.operations[0].id, 'portfolio.summary');
        assert.ok(out.operations[0].params.asOf);
    });

    it('filters by topic and by keyword', () => {
        const byTopic = R.buildHelp({ topic: 'performance' });
        assert.ok(byTopic.count >= 1);
        for (const op of byTopic.operations) assert.equal(op.topic, 'performance');

        const byQuery = R.buildHelp({ query: 'dividends' });
        assert.ok(byQuery.count >= 1);
    });

    it('a miss lists the whole catalog rather than dead-ending', () => {
        for (const params of [{ operation_id: 'nope' }, { topic: 'nope' }, { query: 'zzzzzz' }]) {
            const out = R.buildHelp(params);
            assert.equal(out.count, 0);
            assert.equal(out.operations.length, catalog.CATALOG.length,
                `${JSON.stringify(params)} returned an empty answer — a dead end is what makes an agent give up`);
            assert.match(out.next_step, /\S/);
        }
    });
});

// --- Dispatch ---------------------------------------------------------------

describe('mcp_call and the two-tool rule', () => {
    it('runs one operation and labels the answer with the id it ran', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        const out = await handle('mcp_call', { operation_id: 'portfolio.summary', params: { asOf: '2025-01-01' } });
        assert.deepEqual(out, {
            status: 'ok',
            operation_id: 'portfolio.summary',
            result: { ran: 'portfolio.summary', params: { asOf: '2025-01-01' } },
        });
    });

    it('an unknown operation comes back with the real id, not a shrug', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        await assert.rejects(
            () => handle('mcp_call', { operation_id: 'portfolio.positions' }),
            (e) => {
                assert.equal(e.code, -32602);
                assert.match(e.message, /portfolio\.holdings|portfolio\.securities/,
                    'the suggestion is what stops an agent retrying its guess forever');
                return true;
            },
        );
    });

    it('mcp_execute is refused in a sentence that says WHY, not as an unknown method', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        await assert.rejects(
            () => handle('mcp_execute', {}),
            (e) => {
                assert.equal(e.code, -32601);
                // The refusal must explain the architecture: an agent told only
                // "unknown method" retries, and an agent told "not implemented"
                // waits for a version that will never come.
                assert.match(e.message, /zero-knowledge|ciphertext/);
                assert.match(e.message, /mcp_call/);
                return true;
            },
        );
    });

    it('the refusal reaches the model as a numeric JSON-RPC error, which is what the shim can flatten', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        const resp = await R.handleRequest(handle, { jsonrpc: '2.0', id: 9, method: 'mcp_execute' });
        assert.equal(resp.id, 9);
        assert.equal(typeof resp.error.code, 'number');
        assert.equal(resp.result, undefined);
        // internal/mcpshim/shim.go rewrites a *jsonrpc.Error into a plain error
        // precisely so this text lands in a tool result the model reads. A string
        // code there is dropped on the floor and surfaces as a device-offline
        // timeout instead.
        assert.match(resp.error.message, /zero-knowledge|ciphertext/);
    });

    it('any other method is refused by naming the only two that exist', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        await assert.rejects(() => handle('tools/list', {}), /mcp_help and mcp_call/);
    });

    it('a domain refusal is invalid-params with the engine wording, not an internal error', async () => {
        const handle = R.createDispatcher({
            run: () => { throw new RangeError('prices.series needs a securityId'); },
        });
        await assert.rejects(
            () => handle('mcp_call', { operation_id: 'prices.series' }),
            (e) => (assert.equal(e.code, -32602), assert.match(e.message, /securityId/), true),
        );
    });

    it('handleRequest never throws and never emits a non-numeric code', async () => {
        const handle = R.createDispatcher({ run: () => { const e = new Error('boom'); e.code = 'empty_content'; throw e; } });
        const resp = await R.handleRequest(handle, { id: 3, method: 'mcp_call', params: { operation_id: 'portfolio.summary' } });
        assert.equal(resp.error.code, -32603);
        // A frame that decodes to JSON null used to throw on `.id` and be
        // swallowed, which the agent saw as a 30-second offline timeout.
        const nulled = await R.handleRequest(handle, null);
        assert.equal(nulled.id, null);
        assert.equal(typeof nulled.error.code, 'number');
    });
});

// --- The frame budget -------------------------------------------------------

describe('the frame budget is the Go side\'s, not re-derived', () => {
    it('matches internal/mcpshim exactly', () => {
        const frameGo = src('internal/mcpshim/frame.go');
        const shimGo = src('internal/mcpshim/shim.go');
        assert.match(frameGo, /nonceSize\s+=\s+12/);
        assert.match(frameGo, /FrameOverheadBytes = nonceSize \+ 16/);
        assert.equal(R.FRAME_OVERHEAD_BYTES, 12 + 16);
        assert.match(shimGo, /maxFrameBytes = 64 << 10/);
        assert.equal(R.MAX_FRAME_BYTES, 64 * 1024);
        assert.equal(R.MAX_PAYLOAD_BYTES, 65536 - 28);
    });

    it('matches what sealMCPFrame actually costs', async () => {
        const payload = enc.encode('x'.repeat(1000));
        const sealed = await C.sealMCPFrame(KEY, PAIRING, payload);
        assert.equal(sealed.length - payload.length, R.FRAME_OVERHEAD_BYTES);
    });

    it('an oversized answer is explained, not dropped into a device-offline timeout', async () => {
        const handle = R.createDispatcher({ run: async () => ({ blob: 'y'.repeat(R.MAX_PAYLOAD_BYTES) }) });
        const request = enc.encode(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'mcp_call', params: { operation_id: 'portfolio.summary' } }));
        const reply = await R.answerFrame({
            key: KEY, pairingId: PAIRING, handle,
            bytes: await C.sealMCPFrame(KEY, PAIRING, request),
        });
        assert.ok(reply.length <= R.MAX_FRAME_BYTES, 'the replacement answer must itself fit the frame');
        const decoded = JSON.parse(dec.decode(await C.openMCPFrame(KEY, PAIRING, reply)));
        assert.equal(decoded.id, 4);
        assert.match(decoded.error.message, /NOT a device-offline error/);
        assert.match(decoded.error.message, /limit|from\/to/);
    });
});

// --- The frame path ---------------------------------------------------------

describe('answerFrame', () => {
    it('opens a real frame, answers it, and seals a reply the same key opens', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        const request = enc.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mcp_help', params: { topic: 'prices' } }));
        const reply = await R.answerFrame({
            key: KEY, pairingId: PAIRING, handle,
            bytes: await C.sealMCPFrame(KEY, PAIRING, request),
        });
        const decoded = JSON.parse(dec.decode(await C.openMCPFrame(KEY, PAIRING, reply)));
        assert.equal(decoded.jsonrpc, '2.0');
        assert.equal(decoded.id, 1);
        assert.equal(decoded.result.operations[0].topic, 'prices');
    });

    it('drops a frame it cannot open rather than answering it', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        const foreign = await C.sealMCPFrame(new Uint8Array(32).fill(9), PAIRING, enc.encode('{}'));
        assert.equal(await R.answerFrame({ key: KEY, pairingId: PAIRING, handle, bytes: foreign }), null);

        // A frame sealed for another pairing is the cross-pairing replay the AAD
        // binding exists to stop; it must not be answered either.
        const otherPairing = await C.sealMCPFrame(KEY, 'prg-0000000000000000', enc.encode('{}'));
        assert.equal(await R.answerFrame({ key: KEY, pairingId: PAIRING, handle, bytes: otherPairing }), null);
    });

    it('drops a decryptable frame that is not JSON', async () => {
        const handle = R.createDispatcher({ run: stubRun });
        const junk = await C.sealMCPFrame(KEY, PAIRING, enc.encode('not json at all'));
        assert.equal(await R.answerFrame({ key: KEY, pairingId: PAIRING, handle, bytes: junk }), null);
    });
});

// --- The device leg ---------------------------------------------------------

// A WebSocket stand-in: records what was dialled and lets a test drive onclose.
function fakeSockets() {
    const dialled = [];
    const sockets = [];
    const openSocket = (url) => {
        dialled.push(url);
        const s = {
            url, readyState: 1, sent: [], closed: false,
            send(b) { this.sent.push(b); },
            close() { this.closed = true; },
        };
        sockets.push(s);
        return s;
    };
    return { dialled, sockets, openSocket };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the device leg', () => {
    it('appends only /device to the relay endpoint and escapes the pairing id', () => {
        const f = fakeSockets();
        // §11: relay_url is the full relay PATH, not an origin. Appending
        // "/api/mcp/relay/device" the way the sibling does dials
        // ".../api/mcp/relay/api/mcp/relay/device" and 404s every real pairing.
        R.createResponder({
            pairingId: 'a/b&c#d', key: KEY, run: stubRun,
            relayURL: 'wss://portfolio.example/api/mcp/relay',
            openSocket: f.openSocket,
        }).connect();
        assert.equal(f.dialled[0], 'wss://portfolio.example/api/mcp/relay/device?pairing=a%2Fb%26c%23d');
        assert.ok(!f.dialled[0].includes('relay/api/mcp/relay'));
    });

    it('tolerates a trailing slash on the relay endpoint', () => {
        const f = fakeSockets();
        R.createResponder({
            pairingId: 'p1', key: KEY, run: stubRun,
            relayURL: 'wss://portfolio.example/api/mcp/relay/',
            openSocket: f.openSocket,
        }).connect();
        assert.equal(f.dialled[0], 'wss://portfolio.example/api/mcp/relay/device?pairing=p1');
    });

    it('4404 and 4409 stop the leg; anything else is a transient drop and redials', async () => {
        const seen = [];
        const made = [];
        for (const code of [R.STATUS_NO_PAIRING, R.STATUS_PAIRING_REPLACED, 1006]) {
            const f = fakeSockets();
            const responder = R.createResponder({
                pairingId: 'p1', key: KEY, run: stubRun, relayURL: 'wss://x/api/mcp/relay',
                openSocket: f.openSocket,
                onStalePairing: (c) => seen.push(c),
            });
            responder.connect();
            f.sockets[0].onclose({ code });
            made.push({ code, f, responder });
        }
        // The two terminal codes report themselves and nothing else; 1006 does
        // not report at all, because there is nothing stale about it.
        assert.deepEqual(seen, [R.STATUS_NO_PAIRING, R.STATUS_PAIRING_REPLACED]);

        // RECONNECT_MIN_MS is 1s, so one wait covers all three.
        await sleep(1300);
        try {
            const [noPairing, replaced, dropped] = made;
            assert.equal(noPairing.f.dialled.length, 1, '4404 must not redial — the pairing is gone');
            assert.equal(replaced.f.dialled.length, 1, '4409 must not redial — a newer leg holds the slot');
            assert.equal(dropped.f.dialled.length, 2, '1006 is an ordinary drop and must redial');
        } finally {
            for (const m of made) m.responder.stop();
        }
    });

    it('answers a frame that arrives on the socket', async () => {
        const f = fakeSockets();
        const responder = R.createResponder({
            pairingId: PAIRING, key: KEY, run: stubRun, relayURL: 'wss://x/api/mcp/relay', openSocket: f.openSocket,
        });
        responder.connect();
        const sock = f.sockets[0];
        sock.onopen();
        assert.equal(responder.getStatus(), 'linked');
        const request = enc.encode(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'mcp_help', params: {} }));
        const frame = await C.sealMCPFrame(KEY, PAIRING, request);
        await new Promise((done) => {
            const original = sock.send.bind(sock);
            sock.send = (b) => { original(b); done(); };
            sock.onmessage({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
        });
        const out = JSON.parse(dec.decode(await C.openMCPFrame(KEY, PAIRING, new Uint8Array(sock.sent[0]))));
        assert.equal(out.id, 2);
        assert.equal(out.result.count, catalog.CATALOG.length);
        responder.stop();
    });
});

// --- The pairing vault record -----------------------------------------------

function memoryPort(rows = []) {
    const map = new Map(rows.map((r) => [r.recordId, r]));
    return {
        map,
        list: async (t) => [...map.values()].filter((r) => r.recordType === t && r.deleted !== true),
        put: async (t, id, body) => { map.set(id, { ...body, recordId: id, recordType: t, deleted: false }); },
        del: async (t, id) => { map.set(id, { recordId: id, recordType: t, deleted: true }); },
    };
}

describe('the pairing record', () => {
    it('is not one of schema.js\'s RECORD types, so a plaintext export cannot carry the key', async () => {
        const { RECORD } = await import('../../../../domain/schema.js');
        assert.ok(!Object.values(RECORD).includes(R.MCP_PAIRING_TYPE),
            'store.exportAll() enumerates Object.values(RECORD) and writes them to a downloaded file; '
            + 'the pairing record holds the one secret the server never sees');
    });

    it('reads back what C5 wrote, and ignores a half-written one', async () => {
        const port = memoryPort();
        assert.equal(await R.readPairing(port), null);
        await port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, { pairingId: 'p1', key: 'AAAA' });
        assert.deepEqual(await R.readPairing(port), { pairingId: 'p1', key: 'AAAA' });
        await port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, { pairingId: 'p1' });
        assert.equal(await R.readPairing(port), null);
    });

    it('purges by tombstone, so a sync cannot resurrect it', async () => {
        const port = memoryPort();
        await port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, { pairingId: 'p1', key: 'AAAA' });
        await R.purgePairing(port);
        assert.equal(await R.readPairing(port), null);
        assert.equal(port.map.get(R.MCP_PAIRING_ID).deleted, true);
    });

    it('the responder writes nothing but that one purge', () => {
        const source = readFileSync(new URL('../mcp-responder.js', import.meta.url), 'utf8');
        const writes = source.match(/records\.(put|del)\(/g) || [];
        assert.deepEqual(writes, ['records.del('],
            'the only write in the responder is purgePairing on 4404 — everything else is read-only');
    });
});

// --- The election -----------------------------------------------------------

// Stands the real controller up over stubbed platform globals and returns the
// levers a test needs: the elected socket, whether the lock was released, and
// the port to inspect afterwards.
async function electedResponder() {
    const port = memoryPort();
    await port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, {
        pairingId: 'p1', key: Buffer.from(KEY).toString('base64'),
    });
    const state = { port, released: false, held: [], sockets: [] };
    globalThis.navigator = {
        locks: {
            request(name, fn) {
                state.held.push(name);
                return Promise.resolve(fn()).then(() => { state.released = true; });
            },
        },
    };
    globalThis.location = { protocol: 'https:', host: 'portfolio.example' };
    globalThis.WebSocket = function (url) {
        const s = { url, readyState: 1, send() {}, close() {} };
        state.sockets.push(s);
        return s;
    };
    state.teardown = () => {
        R.stopResponder();
        delete globalThis.navigator;
        delete globalThis.location;
        delete globalThis.WebSocket;
    };
    await R.refreshResponder({ records: port });
    return state;
}

// The close codes are not interchangeable and the difference is destructive:
// the pairing record is CRDT-synced, so a tab that purges on 4409 deletes the
// pairing every other device just adopted. Swap the two codes in
// mcp-responder.js's onStalePairing and both of these must go red.
describe('close codes, end to end through the controller', () => {
    it('4404 purges the pairing record — it points at nothing', async () => {
        const s = await electedResponder();
        try {
            s.sockets[0].onclose({ code: R.STATUS_NO_PAIRING });
            // The purge is a promise the close handler does not await.
            await new Promise((r) => setTimeout(r, 10));
            assert.equal(await R.readPairing(s.port), null);
            assert.equal(s.port.map.get(R.MCP_PAIRING_ID).deleted, true);
            // The lock is held IFF `active` is a live responder. 4404 is terminal
            // too, so it must step aside like 4409 does — a stopped responder that
            // keeps the lock queues every other tab behind a dead holder. Codex
            // caught this on the 4409 path and then again here; only the 4409 half
            // was asserted, so the 4404 half could regress silently.
            assert.equal(s.released, true, 'a terminal close must release the election, whichever code it was');
        } finally {
            s.teardown();
        }
    });

    it('4409 keeps the record and releases the election instead', async () => {
        const s = await electedResponder();
        try {
            s.sockets[0].onclose({ code: R.STATUS_PAIRING_REPLACED });
            await new Promise((r) => setTimeout(r, 10));
            assert.deepEqual(await R.readPairing(s.port), { pairingId: 'p1', key: Buffer.from(KEY).toString('base64') },
                'purging on 4409 deletes the live pairing on every synced device');
            assert.equal(s.released, true,
                'the tab holding the current key is queued on the lock and can only take over if this one steps aside');
        } finally {
            s.teardown();
        }
    });

    it('a 4409 that arrives after the leg was stopped does not tear down its replacement', async () => {
        // The re-pairing race, found by codex review. The relay closes the OLD
        // leg with 4409 the moment a new pairing is minted; reconcile() has
        // already stopped that responder and started the new one by the time the
        // event is delivered. Acting on it releases the election and leaves the
        // tab idle holding the right key.
        const s = await electedResponder();
        try {
            const stale = s.sockets[0];
            // Re-pair: the vault record now names a different pairing.
            await s.port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, {
                pairingId: 'p2', key: Buffer.from(KEY).toString('base64'),
            });
            await R.refreshResponder({ records: s.port });
            assert.equal(s.sockets.length, 2, 'the new pairing must get its own leg');
            assert.match(s.sockets[1].url, /pairing=p2$/);

            stale.onclose({ code: R.STATUS_PAIRING_REPLACED });
            await new Promise((r) => setTimeout(r, 10));

            assert.equal(s.released, false, 'the replacement leg lost the election to a dead one');
            assert.ok(await R.readPairing(s.port), 'and the pairing record must still be there');
        } finally {
            s.teardown();
        }
    });

    it('an ordinary drop touches neither the record nor the election', async () => {
        const s = await electedResponder();
        try {
            s.sockets[0].onclose({ code: 1006 });
            await new Promise((r) => setTimeout(r, 10));
            assert.ok(await R.readPairing(s.port));
            assert.equal(s.released, false, '1006 is a transient drop — stepping aside on it hands the slot away for nothing');
        } finally {
            s.teardown();
        }
    });
});

describe('the Web Lock election', () => {
    it('elects one tab, connects it, and hands the lock on when it steps aside', async () => {
        const port = memoryPort();
        await port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, {
            pairingId: 'p1', key: Buffer.from(KEY).toString('base64'),
        });

        let released = false;
        const held = [];
        // The real Web Locks API holds the lock until the callback's promise
        // settles — there is no release argument — so releasing is observed the
        // same way the browser observes it.
        globalThis.navigator = {
            locks: {
                request(name, fn) {
                    held.push(name);
                    return Promise.resolve(fn()).then(() => { released = true; });
                },
            },
        };
        // The relay endpoint comes from `location` in production, so this also
        // pins the same-origin default the CSP measurement in §11 was made on.
        globalThis.location = { protocol: 'https:', host: 'portfolio.example' };
        const dialled = [];
        globalThis.WebSocket = function (url) {
            dialled.push(url);
            return { readyState: 1, send() {}, close() {} };
        };
        try {
            await R.refreshResponder({ records: port });
            assert.deepEqual(held, ['mcp-responder'], 'the election must take the named lock');
            assert.deepEqual(dialled, ['wss://portfolio.example/api/mcp/relay/device?pairing=p1'],
                'winning the election is what connects the leg');
            R.stopResponder();
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(released, true, 'stepping aside must release the lock, or the next tab queues forever');
        } finally {
            delete globalThis.navigator;
            delete globalThis.location;
            delete globalThis.WebSocket;
        }
    });

    it('a tab with no pairing does not squat the election', async () => {
        // Found by codex review. Every user who has not run Connect Claude
        // reaches this: the first tab to boot wins the lock, finds no pairing,
        // and — before the fix — held it for the tab's lifetime with no
        // record-change hook to reconcile again. A second tab that then paired
        // queued behind a no-op holder, so NO device leg connected at all.
        const port = memoryPort();
        let holders = 0;
        let released = 0;
        globalThis.navigator = {
            locks: {
                request(_, fn) {
                    holders += 1;
                    return Promise.resolve(fn()).then(() => { released += 1; });
                },
            },
        };
        globalThis.location = { protocol: 'https:', host: 'portfolio.example' };
        const dialled = [];
        globalThis.WebSocket = function (url) {
            dialled.push(url);
            return { readyState: 1, send() {}, close() {} };
        };
        try {
            await R.refreshResponder({ records: port });
            await new Promise((r) => setTimeout(r, 5));
            assert.equal(released, 1, 'the lock must be handed back when there is nothing to answer');
            assert.deepEqual(dialled, []);

            // Now the pairing arrives (this tab pairs, or a sibling tab pairs and
            // it syncs). The election must be winnable again — before the fix,
            // `electing` stayed true and this call returned without doing
            // anything at all.
            await port.put(R.MCP_PAIRING_TYPE, R.MCP_PAIRING_ID, {
                pairingId: 'p9', key: Buffer.from(KEY).toString('base64'),
            });
            await R.refreshResponder({ records: port });
            assert.equal(holders, 2, 'the second election never ran');
            assert.deepEqual(dialled, ['wss://portfolio.example/api/mcp/relay/device?pairing=p9']);
        } finally {
            R.stopResponder();
            delete globalThis.navigator;
            delete globalThis.location;
            delete globalThis.WebSocket;
        }
    });

    it('with no pairing record it opens no socket at all', async () => {
        let dialled = 0;
        globalThis.WebSocket = function () { dialled += 1; return { readyState: 1, send() {}, close() {} }; };
        try {
            await R.refreshResponder({ records: memoryPort() });
            assert.equal(dialled, 0, 'a user who never ran Connect Claude must not open a relay socket');
        } finally {
            R.stopResponder();
            delete globalThis.WebSocket;
        }
    });
});
