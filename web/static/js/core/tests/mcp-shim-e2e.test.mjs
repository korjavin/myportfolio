// The whole chain, end to end, with nothing simulated between the model and the
// numbers (bd myportfolio-ybp.4, ARCHITECTURE.md §11):
//
//   MCP client (this test, over stdio)
//     -> the REAL cmd/mcpshim binary, built here
//        -> a real WebSocket, carrying real sealed frames
//           -> a blind byte pipe
//              -> this file's responder + hand-written catalog
//                 -> the real web/domain/ engines over a fixture portfolio
//
// Every piece is production code except the pipe in the middle, and that one is
// already proven against the real binary from the other side by
// internal/server's TestTheRealShimBinaryReachesADeviceThroughThisRelay, which
// drove the same shim through the real relay to a Go stand-in for this
// responder. Between the two, no leg of the chain is simulated on both sides at
// once — which is the property that makes either test worth running.
//
// The pipe here is a ~70-line RFC 6455 server rather than the Go relay because
// the relay's device leg is session-cookie-authenticated: reaching it from Node
// would mean replaying the whole passkey ceremony to prove something the relay's
// own suite already proves. What this file is for is the cross-language contract
// — pairing code, frame crypto, JSON-RPC envelope, catalog dispatch — and a
// blind pipe cannot affect any of it. If it could, it would not be blind.
//
// The shim is a Go binary, so this suite is skipped where there is no toolchain.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

globalThis.crypto ??= nodeCrypto.webcrypto;

const HAVE_GO = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
const REPO = path.resolve(new URL('../../../../../', import.meta.url).pathname);

// --- A blind byte pipe over RFC 6455 ---------------------------------------
//
// Server-side only, binary frames only, no fragmentation and no extensions —
// which is all coder/websocket's client sends for a single Write. It never looks
// at a payload, which is the one property the real relay has that matters here.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
    return nodeCrypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Encode one unmasked binary frame (server -> client). */
function encodeFrame(payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x82, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x82; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x82; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Pull every complete frame out of `buf`, returning the unconsumed tail.
 * `onBinary` is called with the unmasked payload of each binary frame; control
 * frames are counted and dropped, which is enough for a pipe that never pings.
 */
function drainFrames(buf, onBinary) {
    for (;;) {
        if (buf.length < 2) return buf;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (buf.length < offset + 2) return buf;
            len = buf.readUInt16BE(offset); offset += 2;
        } else if (len === 127) {
            if (buf.length < offset + 8) return buf;
            len = Number(buf.readBigUInt64BE(offset)); offset += 8;
        }
        let mask = null;
        if (masked) {
            if (buf.length < offset + 4) return buf;
            mask = buf.subarray(offset, offset + 4); offset += 4;
        }
        if (buf.length < offset + len) return buf;
        const payload = Buffer.from(buf.subarray(offset, offset + len));
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        buf = buf.subarray(offset + len);
        if (opcode === 0x2) onBinary(payload);
    }
}

/**
 * A relay that only ever sees ciphertext: it hands each inbound frame to
 * `answer(bytes) -> Promise<Uint8Array|null>` and writes back whatever comes
 * out. It holds no key and parses no payload.
 */
function startBlindRelay(answer) {
    const seen = [];
    const server = http.createServer((_, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket) => {
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
            '', '',
        ].join('\r\n'));
        // Serialized: one in-flight frame per direction, like the real relay.
        let queue = Promise.resolve();
        let buf = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buf = drainFrames(Buffer.concat([buf, chunk]), (payload) => {
                seen.push({ url: req.url, bytes: payload.length, payload });
                queue = queue.then(async () => {
                    const reply = await answer(new Uint8Array(payload));
                    if (reply && !socket.destroyed) socket.write(encodeFrame(reply));
                });
            });
        });
        socket.on('error', () => {});
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, seen, relayURL: `ws://127.0.0.1:${port}/api/mcp/relay` });
        });
    });
}

// --- The MCP client half ----------------------------------------------------

function startShim(binary, code) {
    const child = spawn(binary, [], { env: { ...process.env, MYPORTFOLIO_MCP_CODE: code } });
    let stdout = '';
    let stderr = '';
    const waiters = new Map();
    child.stdout.on('data', (d) => {
        stdout += d;
        for (;;) {
            const nl = stdout.indexOf('\n');
            if (nl < 0) break;
            const line = stdout.slice(0, nl).trim();
            stdout = stdout.slice(nl + 1);
            if (!line) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                throw new Error(`mcpshim wrote non-JSON to the MCP transport: ${line}`);
            }
            const w = waiters.get(msg.id);
            if (w) { waiters.delete(msg.id); w(msg); }
        }
    });
    child.stderr.on('data', (d) => { stderr += d; });

    let nextId = 0;
    return {
        child,
        stderr: () => stderr,
        notify(method, params) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
        },
        call(method, params) {
            nextId += 1;
            const id = nextId;
            const done = new Promise((resolve, reject) => {
                waiters.set(id, resolve);
                setTimeout(() => reject(new Error(`timed out on ${method}\nstderr:\n${stderr}`)), 40000).unref?.();
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            return done;
        },
    };
}

const toolText = (result) => (result.content || []).map((c) => c.text).join('\n');

// --- The test ---------------------------------------------------------------

describe('end to end: the real mcpshim binary answered by this responder', { skip: HAVE_GO ? false : 'no Go toolchain' }, () => {
    let relay;
    let shim;
    let workdir;
    let code;

    before(async () => {
        const R = await import('../mcp-responder.js');
        const { formatPairingCode } = await import('../crypto.js');
        const { createRunner } = await import('../mcp-catalog.js');
        const { createDemoRecords, demoRecords } = await import('../../features/demo.js');

        const key = nodeCrypto.randomBytes(32);
        const pairingId = 'prg-e2e-0000000001';
        const records = createDemoRecords(demoRecords({ today: '2025-06-30' }));
        const handle = R.createDispatcher({ run: createRunner({ records }) });

        relay = await startBlindRelay((bytes) => R.answerFrame({ key: new Uint8Array(key), pairingId, handle, bytes }));

        // The pairing code is minted by THIS side's formatPairingCode and parsed
        // by Go's ParsePairingCode — the format agreement is part of what is
        // under test, not a fixture. relay_url carries the full relay path, so
        // the shim appends only "/shim" (§11).
        code = await formatPairingCode({ relayUrl: relay.relayURL, pairingId, key: new Uint8Array(key) });

        workdir = mkdtempSync(path.join(tmpdir(), 'mcpshim-e2e-'));
        const binary = path.join(workdir, 'mcpshim');
        const build = spawnSync('go', ['build', '-o', binary, './cmd/mcpshim'], { cwd: REPO, encoding: 'utf8' });
        assert.equal(build.status, 0, `go build ./cmd/mcpshim failed:\n${build.stderr}`);

        shim = startShim(binary, code);
        await shim.call('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'mcp-shim-e2e', version: '1' },
        });
        shim.notify('notifications/initialized', {});
    });

    after(() => {
        shim?.child.kill();
        relay?.server.close();
        if (workdir) rmSync(workdir, { recursive: true, force: true });
    });

    it('advertises exactly two tools — there is no third, by design', async () => {
        const { result } = await shim.call('tools/list', {});
        assert.deepEqual(result.tools.map((t) => t.name).sort(), ['mcp_call', 'mcp_help']);
    });

    it('mcp_help crosses the whole chain and returns this catalog', async () => {
        const { result, error } = await shim.call('tools/call', { name: 'mcp_help', arguments: {} });
        assert.equal(error, undefined, `protocol error: ${JSON.stringify(error)}`);
        const text = toolText(result);
        assert.match(text, /portfolio\.summary/);
        assert.match(text, /transactions\.list/);
        assert.match(text, /READ-ONLY/);
    });

    it('mcp_call returns real money as a decimal string, from the real domain engines', async () => {
        const { result, error } = await shim.call('tools/call', {
            name: 'mcp_call',
            arguments: { operation_id: 'portfolio.summary' },
        });
        assert.equal(error, undefined, `protocol error: ${JSON.stringify(error)}`);
        const payload = JSON.parse(toolText(result));
        assert.equal(payload.status, 'ok');
        assert.equal(payload.result.reportingCurrency, 'EUR');
        // The number a user would be told. If this is ever an integer, the model
        // is about to be off by a factor of a hundred.
        assert.match(payload.result.totals.total, /^-?\d+\.\d{2}$/);
        assert.equal(typeof payload.result.totals.totalUnits, 'number');
        assert.equal(Number(payload.result.totals.total).toFixed(2),
            (payload.result.totals.totalUnits / 100).toFixed(2));
    });

    it('a per-security answer carries shares, price and value through the same boundary', async () => {
        const { result } = await shim.call('tools/call', {
            name: 'mcp_call',
            arguments: { operation_id: 'portfolio.securities' },
        });
        const { result: out } = JSON.parse(toolText(result));
        assert.ok(out.securities.length > 0);
        const held = out.securities.find((s) => s.sharesUnits > 0);
        assert.ok(held, 'the fixture portfolio holds nothing — the chain proved nothing');
        assert.match(held.shares, /^\d+\.\d{8}$/);
        assert.match(held.price, /^\d+\.\d{8}$/);
        assert.match(held.marketValue, /^-?\d+\.\d{2}$/);
    });

    it('a responder error reaches the MODEL as a tool result, not a protocol failure', async () => {
        const { result, error } = await shim.call('tools/call', {
            name: 'mcp_call',
            arguments: { operation_id: 'portfolio.positions' },
        });
        // This is the mechanism §11's mcp_execute refusal rides on: the SDK
        // special-cases *jsonrpc.Error into a top-level protocol error the model
        // never sees, so internal/mcpshim flattens it first. If `error` is set
        // here, that flattening broke and every responder error is invisible.
        assert.equal(error, undefined, 'the responder error surfaced as a protocol failure the model cannot read');
        assert.equal(result.isError, true);
        assert.match(toolText(result), /unknown operation "portfolio.positions"/);
        assert.match(toolText(result), /portfolio\.holdings/, 'the error must name the ids that do exist');
    });

    it('the pipe in the middle never saw a plaintext byte', () => {
        assert.ok(relay.seen.length > 0, 'no frame crossed the relay');
        for (const frame of relay.seen) {
            assert.match(frame.url, /^\/api\/mcp\/relay\/shim\?pairing=/,
                'the shim must append only /shim to the §11 relay endpoint');
            const asText = frame.payload.toString('latin1');
            for (const needle of ['mcp_help', 'mcp_call', 'portfolio', 'jsonrpc', 'EUR']) {
                assert.ok(!asText.includes(needle),
                    `the relay could read ${needle} out of a frame — it is supposed to hold only ciphertext`);
            }
        }
    });

    it('the shim never logged the pairing code, which carries the key', () => {
        assert.ok(!shim.stderr().includes(code));
    });
});
