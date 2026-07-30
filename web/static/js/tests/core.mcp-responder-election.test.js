// The election controller in core/mcp-responder.js had no direct test, which is
// why it has accumulated four separate review-found bugs in the same twenty
// lines. These two pin the reconcile coalescing (bd myportfolio-ybp.11); both
// fail on the check-then-act it replaced, in opposite directions.
//
// Everything the controller touches is a global it does not inject —
// navigator.locks, WebSocket, location — so the stubs below are the seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refreshResponder, stopResponder, MCP_PAIRING_TYPE, MCP_PAIRING_ID } from '../core/mcp-responder.js';

const KEY_B64 = Buffer.alloc(32).toString('base64');

function define(name, value) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

/** A records port whose reads are observable and, when asked, slow. */
function fakeRecords() {
    const port = {
        rows: [],
        listCalls: 0,
        concurrentLists: 0,
        maxConcurrentLists: 0,
        gate: null, // set to a promise to hold every list() open
        setPairing(pairingId) {
            port.rows = [{ recordType: MCP_PAIRING_TYPE, recordId: MCP_PAIRING_ID, pairingId, key: KEY_B64 }];
        },
        async list() {
            port.listCalls += 1;
            port.concurrentLists += 1;
            port.maxConcurrentLists = Math.max(port.maxConcurrentLists, port.concurrentLists);
            try {
                if (port.gate) await port.gate;
                return port.rows.slice();
            } finally {
                port.concurrentLists -= 1;
            }
        },
        async del() { port.rows = []; },
        async put() {},
    };
    return port;
}

/** Sockets the controller opened. One live socket == one device leg. */
function stubEnvironment({ grantImmediately = true } = {}) {
    const sockets = [];
    define('WebSocket', class {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.closed = false;
            sockets.push(this);
        }
        close() { this.closed = true; this.readyState = 3; }
    });
    define('location', { protocol: 'https:', host: 'portfolio.test' });

    let grant = () => {};
    const granted = new Promise((resolve) => { grant = resolve; });
    define('navigator', {
        locks: {
            async request(_name, fn) {
                if (!grantImmediately) await granted;
                return fn();
            },
        },
    });
    return { sockets, grant };
}

test('a refresh that lands while the election is still queued is not lost', async () => {
    const records = fakeRecords();
    const { sockets, grant } = stubEnvironment({ grantImmediately: false });
    try {
        // Boot: no pairing yet, and the lock is held by another tab so this
        // election sits in the queue.
        refreshResponder({ records });

        // The user finishes Connect Claude while we are still queued. The old
        // code saw `electing` and returned an already-resolved promise, so this
        // write's refresh was dropped on the floor.
        records.setPairing('pair-finish');
        const second = refreshResponder({ records });

        let settledEarly = false;
        second.then(() => { settledEarly = true; });
        await Promise.resolve();
        assert.equal(settledEarly, false, 'refresh resolved before any reconcile ran');

        grant();
        await second;

        // The promise must not settle until the pairing that was written is
        // actually being answered.
        assert.equal(sockets.length, 1, 'expected exactly one device leg');
        assert.match(sockets[0].url, /pairing=pair-finish/);
    } finally {
        stopResponder();
    }
});

test('concurrent refreshes never run two reconciles at once', async () => {
    const records = fakeRecords();
    const { sockets } = stubEnvironment();
    try {
        records.setPairing('pair-a');
        await refreshResponder({ records });
        assert.equal(sockets.length, 1, 'precondition: elected and answering');

        // Now elected, so refreshes reconcile in place. Hold both reads open so
        // they would overlap if the controller let them: the loser's `finally`
        // would then release the lock after the winner stored `active`, leaving a
        // connected responder holding no lock.
        let open;
        records.gate = new Promise((resolve) => { open = resolve; });
        const a = refreshResponder({ records });
        records.setPairing('pair-b');
        const b = refreshResponder({ records });
        open();
        records.gate = null;
        await Promise.all([a, b]);

        assert.equal(records.maxConcurrentLists, 1, 'reconciles overlapped');
        // Coalesced, not dropped: the second write is the one being answered.
        const live = sockets.filter((s) => !s.closed);
        assert.equal(live.length, 1, 'expected exactly one live device leg');
        assert.match(live[0].url, /pairing=pair-b/);
    } finally {
        stopResponder();
    }
});
