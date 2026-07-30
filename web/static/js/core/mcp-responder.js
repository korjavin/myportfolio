// The browser half of the AI connector: THIS TAB is the responder
// (ARCHITECTURE.md §11, bd myportfolio-ybp.4).
//
//   Claude Desktop/Code --stdio-- mcpshim --wss:// ciphertext--> relay --> this tab
//                                 (holds the pairing key)       (blind)   (decrypts, answers)
//
// The server holds only ciphertext, so it cannot answer a single MCP query. It
// pipes opaque frames between the shim's leg and this tab's leg, and everything
// that turns a question into a number happens here, against the unlocked vault.
//
// Ported from ../medicationtrackerbot's web/cloud/js/mcp-responder.js, minus
// three things it needs and we do not:
//
//   * the generated 106-operation catalog          -> mcp-catalog.js, hand-written
//   * warn-only input validation + write modes     -> v1 is READ-ONLY, so there is
//                                                     no mode, no intent, no body
//   * the persistent seen-nonce anti-replay ring   -> it exists there to stop a
//     relayed WRITE frame being replayed. Every operation here is a query, and a
//     replayed query is idempotent, so the ring would cost an IndexedDB round
//     trip per frame to protect nothing. It comes back with the first write op.
//
// TWO TOOLS, and there is deliberately no third: mcp_help discovers, mcp_call
// runs one operation. See the mcp_execute branch in handle() for why.

import { openMCPFrame, sealMCPFrame, utf8, fromBase64 } from './crypto.js';
import { CATALOG, TOPICS, operation, createRunner } from './mcp-catalog.js';

const decoder = new TextDecoder();

// --- Frame budget -----------------------------------------------------------
//
// internal/server/mcp_relay.go caps a frame at 64 KiB and internal/mcpshim's
// FrameOverheadBytes is what a frame costs on top of its payload (nonce ‖ GCM
// tag). The cap is on the FRAME, so the largest payload that survives it is the
// difference — a responder that budgets a full 64 KiB payload drops precisely
// the largest answers and the shim reports it as a device-offline timeout, which
// is the hardest possible symptom to attribute.
//
// These two numbers are the Go side's, not re-derived: mcp-responder.test.mjs
// reads internal/mcpshim/frame.go and internal/mcpshim/shim.go and fails if
// either drifts, and it also checks the overhead against what sealMCPFrame
// actually produces.
export const MAX_FRAME_BYTES = 64 * 1024;
export const FRAME_OVERHEAD_BYTES = 28;
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES;

// --- The pairing vault record -----------------------------------------------
//
// §11: "The key is stored as a vault record so any unlocked device can answer."
// It is a singleton at a fixed recordId, the same shape settings uses.
//
// The type is deliberately NOT in web/domain/schema.js's RECORD map, and that is
// load-bearing rather than an omission: store.exportAll() enumerates
// Object.values(RECORD), so a pairing living under one of those types would be
// written into every plaintext export file the user downloads — and this record
// carries the one secret in the whole design that the server never sees. It is
// still an ordinary record to the §3 port, so it syncs like everything else and
// a second unlocked device can answer without re-pairing.
//
// C5 (bd myportfolio-ybp.5, Settings › Connect Claude) writes it. This file only
// reads it and, on 4404, deletes it.
export const MCP_PAIRING_TYPE = 'mcp_pairing';
export const MCP_PAIRING_ID = 'mcp_pairing';

/** The pairing this device holds, or null. `key` is base64 in the record. */
export async function readPairing(records) {
    const rows = await records.list(MCP_PAIRING_TYPE);
    const rec = rows.find((r) => r.recordId === MCP_PAIRING_ID);
    if (!rec || !rec.pairingId || !rec.key) return null;
    return { pairingId: String(rec.pairingId), key: String(rec.key) };
}

/**
 * Drop the pairing record. Called on close code 4404 (the relay has no pairing
 * for this account at all, so the record is a tombstone pointing at nothing) and
 * by C5's Disconnect. NEVER on 4409 — see onclose.
 */
export function purgePairing(records) {
    return records.del(MCP_PAIRING_TYPE, MCP_PAIRING_ID);
}

// --- Close codes ------------------------------------------------------------
//
// Scar tissue, ARCHITECTURE.md §11 — do not re-derive, and do not swap them.

/** 4404: the account has no pairing at all. Stop AND purge the vault record. */
export const STATUS_NO_PAIRING = 4404;

/**
 * 4409: a live pairing exists, but this leg is not serving it (a stale id, a
 * newer device leg took the slot, the pairing was re-minted). Stop and DO NOT
 * PURGE: the pairing record is CRDT-synced, so a tab purging here deletes the
 * pairing every other device just adopted. Release the election instead, so the
 * tab holding the current key — already queued on the lock — takes over.
 */
export const STATUS_PAIRING_REPLACED = 4409;

// --- mcp_help ---------------------------------------------------------------

export const USAGE_PROTOCOL = 'Decision rule: (1) Discover — call mcp_help with no arguments for the '
    + 'whole catalog (it is small), or pass operation_id for one operation\'s parameters. '
    + '(2) Run exactly ONE operation per call with mcp_call({operation_id, params}). '
    + 'This connector is READ-ONLY: it can answer questions about the portfolio and cannot '
    + 'modify it — there is no operation that writes, imports or deletes anything. '
    + 'There is no mcp_execute and there is no server-side runtime: every call is answered by '
    + 'YOUR OWN unlocked browser tab over an end-to-end encrypted channel, and the relay server '
    + 'in between sees only frame sizes and timing. If no device is unlocked and online, a call '
    + 'returns an actionable error instead of hanging. MONEY: every amount appears twice — the '
    + 'plain field is the authoritative exact decimal string, <field>Units is the same value as a '
    + 'fixed-point integer (amounts x100, shares x1e8, prices x1e8). Quote the plain field. '
    + 'Call portfolio.issues before giving advice: a total computed with a missing FX rate or an '
    + 'unpriced holding behind it is not the portfolio\'s value.';

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

// The terse projection. Our whole catalog fits in one frame many times over, so
// unlike the sibling there is no size budget and no compact/full distinction to
// get wrong — the only thing an id drill-in adds is the parameter list.
const compact = (op) => ({ id: op.id, topic: op.topic, description: op.description });
const full = (op) => ({ id: op.id, topic: op.topic, description: op.description, params: op.params });

export function buildHelp(params) {
    const p = params || {};
    const requested = [p.operation_id, ...(Array.isArray(p.operation_ids) ? p.operation_ids : [])]
        .map((id) => String(id ?? '').trim())
        .filter(Boolean);

    if (requested.length > 0) {
        const found = requested.map(operation).filter(Boolean);
        const missing = requested.filter((id) => !operation(id));
        if (found.length === 0) {
            return {
                count: 0,
                operations: CATALOG.map(compact),
                topics: TOPICS,
                next_step: `No operation named ${missing.join(', ')}. The whole catalog is listed above — pick an id from it.`,
            };
        }
        return {
            count: found.length,
            operations: found.map(full),
            topics: TOPICS,
            note: missing.length ? `Not found: ${missing.join(', ')}.` : undefined,
            next_step: `Run one with mcp_call({operation_id: "${found[0].id}", params: {…}}).`,
        };
    }

    const query = lower(p.query);
    if (query) {
        const matches = CATALOG.filter((op) => `${op.id} ${op.topic} ${op.description}`.toLowerCase().includes(query));
        if (matches.length === 0) {
            return {
                count: 0,
                operations: CATALOG.map(compact),
                topics: TOPICS,
                note: `Nothing matched "${query}", so the whole catalog is listed instead — it is small.`,
                next_step: 'Pick an id above and run it with mcp_call. Do not search again.',
            };
        }
        return {
            count: matches.length,
            operations: matches.map(full),
            topics: TOPICS,
            next_step: `ACT NOW — do not search again: mcp_call({operation_id: "${matches[0].id}", params: {…}}).`,
        };
    }

    const topic = lower(p.topic);
    if (topic && topic !== 'all') {
        const ops = CATALOG.filter((op) => op.topic === topic);
        if (ops.length === 0) {
            return {
                count: 0,
                operations: CATALOG.map(compact),
                topics: TOPICS,
                next_step: `No topic "${topic}". The topics are: ${TOPICS.join(', ')}.`,
            };
        }
        return {
            count: ops.length,
            operations: ops.map(full),
            topics: TOPICS,
            next_step: `Run one with mcp_call({operation_id: "${ops[0].id}", params: {…}}).`,
        };
    }

    // The default: everything, with parameters. Eight operations is small enough
    // that making a model take two round trips to see them is pure friction.
    return {
        count: CATALOG.length,
        operations: CATALOG.map(full),
        topics: TOPICS,
        usage_protocol: USAGE_PROTOCOL,
        next_step: 'Start with mcp_call({operation_id: "portfolio.summary"}), then drill in.',
    };
}

// --- Dispatch ---------------------------------------------------------------

class MCPError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * What an agent probably meant by an id that does not exist.
 *
 * The sibling ports a Levenshtein ranker here, and at 106 operations it needs
 * one. At eight it does not: an agent that guessed "portfolio.positions" is
 * three edits away from nothing and would get an empty suggestion list, which
 * is exactly the dead end that makes it retry its guess forever. So the
 * fallback is the whole catalog — eight ids cost less to print than the ranker
 * costs to maintain, and they are always the right answer.
 */
export function suggestOperations(opId) {
    const q = lower(opId);
    const topic = q.split('.')[0];
    const near = CATALOG.filter((op) => (q && (op.id.includes(q) || q.includes(op.id))) || op.topic === topic);
    return (near.length > 0 ? near : CATALOG).map((op) => op.id);
}

/**
 * The method table behind one relay connection. `run` is mcp-catalog's runner,
 * injected so the dispatcher can be exercised without a vault, a socket or a
 * single byte of crypto.
 */
export function createDispatcher({ run }) {
    if (typeof run !== 'function') throw new TypeError('mcp-responder: createDispatcher needs a run(opId, params)');

    return async function handle(method, params) {
        if (method === 'mcp_help') return buildHelp(params);

        if (method === 'mcp_call') {
            const p = params || {};
            const opId = p.operation_id;
            const op = operation(opId);
            if (!op) {
                throw new MCPError(-32602, `unknown operation "${opId}" — did you mean: `
                    + `${suggestOperations(opId).join(', ')}? Call mcp_help for their parameters.`);
            }
            try {
                return { status: 'ok', operation_id: op.id, result: await run(op.id, p.params) };
            } catch (e) {
                // A domain refusal (a missing securityId, a from after a to) is the
                // agent's to correct, so it comes back as invalid-params with the
                // engine's own wording rather than as an internal error.
                if (e instanceof RangeError || e instanceof TypeError) throw new MCPError(-32602, e.message);
                throw e;
            }
        }

        // §11: there is deliberately no mcp_execute. The sibling's third tool runs
        // a Python script server-side; here the server holds only ciphertext, so a
        // server-side runner would have nothing to read — and giving it something
        // to read is the one property this whole design exists to prevent.
        //
        // This has to be a sentence the MODEL reads, not an opaque "unknown
        // method" it retries forever. It reaches the model because
        // internal/mcpshim/shim.go flattens a JSON-RPC error into a plain Go error
        // before handing it to the SDK: returned as the *jsonrpc.Error it arrived
        // as, the SDK re-emits it as a protocol error on the outer stdio
        // connection, where the client reads "the connector is broken" and the
        // text never reaches the model at all.
        if (method === 'mcp_execute') {
            throw new MCPError(-32601, 'mcp_execute does not exist in this connector, and cannot: it would need a '
                + 'server-side script runtime, and this connector is zero-knowledge — the server holds only '
                + 'ciphertext and has nothing to run a script against. Every answer comes from your own unlocked '
                + 'browser tab. Chain mcp_call instead, one operation per call; see mcp_help for the catalog.');
        }

        throw new MCPError(-32601, `unknown method "${method}" — this connector has exactly two: mcp_help and mcp_call.`);
    };
}

/**
 * One decoded JSON-RPC request in, one response object out. Pure: no socket, no
 * crypto, no vault, which is what lets the whole dispatch surface be tested
 * under `node --test`.
 */
export async function handleRequest(handle, request) {
    // A frame decoding to JSON `null` would throw on `.id` outside this guard,
    // and onFrame swallows the throw — the agent then waits out a 30s
    // device-offline timeout instead of being told what was wrong.
    const req = request || {};
    const response = { jsonrpc: '2.0', id: req.id ?? null };
    try {
        response.result = await handle(req.method, req.params);
    } catch (e) {
        // JSON-RPC error.code MUST be numeric: the Go shim decodes it into an
        // int64 and drops the whole frame on a string, which surfaces as a bogus
        // offline-device timeout instead of the real error.
        const code = typeof e?.code === 'number' ? e.code : -32603;
        response.error = { code, message: String(e?.message ?? e) };
    }
    return response;
}

/**
 * Decode one inbound frame, answer it, and return the sealed reply — or null if
 * the frame was not ours to answer.
 *
 * Exported because it is the whole request path with none of the socket: the
 * end-to-end test drives the real mcpshim binary straight into this.
 */
export async function answerFrame({ key, pairingId, handle, bytes }) {
    let payload;
    try {
        payload = await openMCPFrame(key, pairingId, bytes);
    } catch {
        // Undecryptable: a tampered or foreign frame. The relay is untrusted by
        // design, so anything it injects that we cannot open is by definition not
        // from our paired shim. Dropped silently — there is no one to answer.
        return null;
    }
    let request;
    try {
        request = JSON.parse(decoder.decode(payload));
    } catch {
        return null;
    }

    let out = utf8(JSON.stringify(await handleRequest(handle, request)));
    if (out.length > MAX_PAYLOAD_BYTES) {
        // Over the relay's frame cap the relay closes this leg, the shim times
        // out, and the model is told the device is offline — which it is not.
        // Say what actually happened, and how to ask for less.
        out = utf8(JSON.stringify({
            jsonrpc: '2.0',
            id: request?.id ?? null,
            error: {
                code: -32603,
                message: `the answer was ${out.length} bytes and the encrypted channel carries at most `
                    + `${MAX_PAYLOAD_BYTES} per message. This is NOT a device-offline error. Ask for less: `
                    + 'narrow the date range with from/to, pass a smaller limit, or use portfolio.summary '
                    + 'instead of a full listing.',
            },
        }));
    }
    return sealMCPFrame(key, pairingId, out);
}

// --- The device leg ---------------------------------------------------------

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * A live connection to the relay's device leg.
 *
 * `relayURL` is the §11 endpoint — the full relay path, NOT an origin — so this
 * appends only "/device". Porting the sibling's line verbatim (it appends the
 * whole "/api/mcp/relay/device" to a bare origin) dials
 * ".../api/mcp/relay/api/mcp/relay/device", which 404s against every real
 * pairing while passing any test that mints its own URL. It did exactly that in
 * C3 before codex caught it.
 *
 * The pairing id is REQUIRED and query-escaped: the relay compares it against the
 * account's current pairing and closes a stale leg with 4409 rather than letting
 * it evict the tab that holds the live key. An id containing "&", "/" or "#"
 * would otherwise rewrite the URL — the browser chose the id, so escaping it is
 * not paranoia.
 *
 * The CSP needs no change for this socket and adding one would be wrong: §7's
 * connect-src is 'self' with no wss: token, and CSP3's 'self' covers a
 * same-origin wss: socket from an https: document. That was MEASURED in headless
 * Chrome against the built binary (§11), with a cross-origin ws:// on the same
 * page refused as the negative control. If this leg ever fails to connect,
 * re-check it first anyway: a CSP-blocked WebSocket surfaces as a bare onclose,
 * indistinguishable from "no device online".
 */
export function createResponder({
    pairingId,
    key,
    run,
    relayURL,
    onStalePairing = () => {},
    openSocket = (url) => new WebSocket(url),
}) {
    const handle = createDispatcher({ run });

    let ws = null;
    let reconnectTimer = null;
    let reconnectDelay = RECONNECT_MIN_MS;
    let status = 'idle';
    let stopped = false;

    function socketURL() {
        // `location` is touched only when no relayURL was injected, so a
        // non-browser caller never evaluates it.
        const base = relayURL
            || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/mcp/relay`;
        return `${base.replace(/\/$/, '')}/device?pairing=${encodeURIComponent(pairingId)}`;
    }

    async function onFrame(data) {
        // Capture the socket this frame arrived on: answering awaits, and a
        // reconnect can rebind `ws` to a new CONNECTING socket meanwhile —
        // send()ing on that throws and loses the response.
        const sock = ws;
        const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(await data.arrayBuffer());
        const frame = await answerFrame({ key, pairingId, handle, bytes });
        if (frame && sock && sock.readyState === 1) sock.send(frame);
    }

    function scheduleReconnect() {
        if (stopped) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    function connect() {
        stopped = false;
        status = 'connecting';
        ws = openSocket(socketURL());
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => { status = 'linked'; reconnectDelay = RECONNECT_MIN_MS; };
        ws.onmessage = (ev) => { onFrame(ev.data).catch((e) => console.error('[mcp] frame failed', e)); };
        ws.onclose = (ev) => {
            status = 'idle';
            // Once this leg has been stopped, its fate is nobody's business —
            // and acting on a late close is destructive rather than merely
            // untidy. Re-pairing runs exactly into it: the relay closes the OLD
            // leg with 4409 when the new pairing is minted, reconcile() stops
            // that responder and starts the new one, and then the queued 4409
            // arrives. Without this guard it reaches onStalePairing, which calls
            // stopResponder() and tears down the responder that just took over —
            // leaving the tab idle on a pairing it holds the right key for.
            // Found by codex review.
            if (stopped) return;
            const code = ev?.code;
            // 4404 and 4409 are both terminal for THIS leg and mean opposite
            // things about the vault record — see the constants. Everything else,
            // notably 1006, is a transient drop: back off and redial.
            if (code === STATUS_NO_PAIRING || code === STATUS_PAIRING_REPLACED) {
                stopped = true;
                clearTimeout(reconnectTimer);
                onStalePairing(code);
                return;
            }
            scheduleReconnect();
        };
        ws.onerror = () => {};
    }

    function stop() {
        stopped = true;
        clearTimeout(reconnectTimer);
        status = 'idle';
        if (ws) ws.close();
    }

    return { connect, stop, getStatus: () => status, handle };
}

// --- The election -----------------------------------------------------------
//
// One Web Lock ('mcp-responder') elects a single answering tab per account: the
// relay allows one device leg per pairing (§11's standing limitation), so five
// open tabs racing to hold it would evict each other forever. The winner holds
// the lock for its lifetime and swaps its inner responder as the pairing changes;
// the losers queue on the lock and take over the moment it is released.

let controllerRecords = null;
let electing = false;
let electionPending = null; // the promise queued callers get while we wait for the lock
let releaseLock = null;
let active = null; // { pairingId, responder }
let reconciling = null; // the in-flight reconcile loop, or null
let reconcileDirty = false; // a reconcile was asked for while one was running

function releaseElection() {
    if (releaseLock) { releaseLock(); releaseLock = null; }
    electing = false;
    electionPending = null;
}

/**
 * Reconcile, coalesced. Never overlapping, never dropped — both failure modes
 * are real and they are opposites, so neither a bare call nor an `if (busy)
 * return` is correct here.
 *
 * NEVER OVERLAPPING: reconcileOnce awaits readPairing, so two runs interleave,
 * and then the loser's `finally` can release the lock a microtask after the
 * winner stored `active`. That breaks the one invariant this whole controller
 * rests on — THE LOCK IS HELD IF AND ONLY IF `active` IS A LIVE RESPONDER — and
 * leaves a connected responder holding no lock, so a second tab elects itself,
 * opens a second device leg, and the relay 4409s them in turn.
 *
 * NEVER DROPPED: returning early while one is in flight loses the later write.
 * That is the bug settings.js's Finish handler documents and routes around: a
 * boot reconcile that read "no pairing" swallowed the refresh for the pairing
 * the user had just saved, and the tab then answered nothing until a reload.
 *
 * So: coalesce. The last write always gets a reconcile that STARTED after it,
 * and callers get a promise that settles once that reconcile has finished.
 */
function reconcile() {
    reconcileDirty = true;
    if (reconciling) return reconciling;
    reconciling = (async () => {
        try {
            // Re-runs while another call landed during the previous pass. The
            // flag is cleared BEFORE awaiting, so a write that arrives mid-pass
            // sets it again and earns its own pass rather than being absorbed.
            while (reconcileDirty) {
                reconcileDirty = false;
                await reconcileOnce();
            }
        } finally {
            reconciling = null;
        }
    })();
    return reconciling;
}

async function reconcileOnce() {
    try {
        if (!controllerRecords) {
            if (active) { active.responder.stop(); active = null; }
            return;
        }
        const records = controllerRecords;
        const pairing = await readPairing(records);
        const nextId = pairing ? pairing.pairingId : null;
        if ((active && active.pairingId) === nextId) return; // unchanged
        if (active) { active.responder.stop(); active = null; }
        if (!pairing) return;

        const responder = createResponder({
            pairingId: pairing.pairingId,
            key: fromBase64(pairing.key),
            run: createRunner({ records }),
            onStalePairing: (code) => {
                // BOTH codes are terminal for this leg, so both step aside first.
                // That is what keeps the invariant this whole controller rests on:
                // THE LOCK IS HELD IF AND ONLY IF `active` IS A LIVE RESPONDER.
                // Leaving a stopped responder holding it queues every other tab
                // behind a dead holder — codex found that on the 4409 path and
                // then again on the 4404 one, which is why it is now unconditional
                // rather than a branch that can be forgotten a third time.
                stopResponder();
                // Only THEN does the difference between the two codes matter, and
                // it is the whole of the difference. 4409 means the account still
                // HAS a pairing — the vault record names it, or will once this
                // device syncs — so purging would delete the live pairing on every
                // synced device. 4404 means there is no pairing at all, so the
                // record is a tombstone pointing at nothing and it goes.
                if (code === STATUS_NO_PAIRING) {
                    purgePairing(records).catch((e) => console.error('[mcp] pairing purge failed', e));
                }
            },
        });
        active = { pairingId: pairing.pairingId, responder };
        responder.connect();
    } catch (e) {
        console.error('[mcp] responder reconcile failed', e);
    } finally {
        // NEVER hold the election with nothing to answer. Every user who has not
        // run Connect Claude reaches this — the first tab to boot would win the
        // lock, find no pairing, and squat it for the tab's lifetime with no
        // record-change hook to reconcile again. A second tab that then paired
        // would queue behind a no-op holder and no device leg would connect at
        // all until someone reloaded. `finally`, not a line after the try, so the
        // early returns above are covered too. Found by codex review.
        if (!active) releaseElection();
    }
}

/**
 * Reconcile the running responder to the vault's current pairing. Safe to call
 * repeatedly — boot calls it once the port is settled, and C5's Connect /
 * Disconnect call it again without a page reload.
 *
 * Returns a promise that settles once the reconcile it triggered has finished.
 * Production callers ignore it; tests must await it, or an un-awaited reconcile
 * outlives its test and logs its failure into whichever one is running next.
 */
export function refreshResponder({ records }) {
    controllerRecords = records;
    if (releaseLock || !globalThis.navigator?.locks?.request) {
        // Already elected, or Web Locks unsupported — reconcile in place. A
        // browser without Web Locks gets one responder per tab, which the relay
        // resolves by evicting all but the newest; that is worse than an election
        // and better than no connector.
        return reconcile();
    }
    if (electing) return electionPending ?? Promise.resolve(); // queued for the lock; its reconcile reads the latest state
    electing = true;
    // The lock is held for the tab's lifetime, so locks.request()'s own promise
    // does not settle until release — awaiting it would hang forever. Settle on
    // the reconcile instead.
    let settle;
    const reconciled = new Promise((resolve) => { settle = resolve; });
    // Handed to callers that arrive while we are still queued, so their refresh
    // settles on the election's reconcile instead of resolving immediately on a
    // reconcile that has not happened yet.
    electionPending = reconciled;
    navigator.locks.request('mcp-responder', () => new Promise((release) => {
        releaseLock = release;
        // reconcile() never rejects and releases the lock itself when there is
        // nothing to answer, so this promise can resolve before the tab dies.
        settle(reconcile());
    })).catch((e) => {
        electing = false;
        electionPending = null;
        console.error('[mcp] responder lock failed', e);
        settle();
    });
    return reconciled;
}

/** Stop any running responder and release the election so a later tab re-elects cleanly. */
export function stopResponder() {
    controllerRecords = null;
    if (active) { active.responder.stop(); active = null; }
    releaseElection();
}
