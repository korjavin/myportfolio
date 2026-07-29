/**
 * features.sync.test.js
 *
 * The wire itself (bd myportfolio-18h.13): which implementation of the
 * ARCHITECTURE.md §3 records port the shell runs on, when it pulls, and what a
 * user is told when sync stops working.
 *
 * Everything below the seam is real — the real vaultRecords, the real
 * state-sync engine, real AES-GCM and real gzip against the fake /api/state
 * from core/tests/sync-fakes.mjs, which implements the compare-and-swap
 * semantics of internal/server/state.go. Only the three things a node process
 * cannot have are faked: Dexie, the passkey ceremony, and window.
 *
 * The test that matters most is "records written before signup are in the vault
 * after signup". "My data vanished when I signed up" is unrecoverable, and the
 * sync layer's claim that it needs no migration code is exactly the kind of
 * claim that is true right up until someone changes applyRemote.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

globalThis.crypto ??= nodeCrypto.webcrypto;

const sync = await import('../features/sync.js');
const { createLocalRecords } = await import('../core/records.js');
const { openState, syncError } = await import('../core/state-sync.js');
const { deriveKData } = await import('../core/crypto.js');
const { fakeDb, fakeServer, fakeMeta, until } = await import('../core/tests/sync-fakes.mjs');
// The REAL pre-signup migration. localdb.js is imported for it rather than
// reimplemented here: the one thing this suite must not do is prove that a copy
// of the migration works while the shipped one does not.
const { claim } = await import('../core/localdb.js');

const { startSync, watchFocus, describeSync, syncState, syncNow } = sync;

const ACCOUNT = 'amber-falcon-8k3q9x';
const OTHER_ACCOUNT = 'copper-heron-2p7w4m';
const DEK = new Uint8Array(32).fill(3);
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

// sync.js keeps one module-level vault, exactly as the real shell does. Each
// test gets a clean one; without this the second test inherits the first's.
async function reset() {
    await startSync({ warm: async () => null, adopt: () => {} });
}

/**
 * The shell's half of the wiring, in the shape boot.js uses it.
 *
 * `meta: null` opts out of the injected metadata so startSync's own openMeta
 * decides — which is how the real shell runs, one metadata record per account.
 */
async function boot(server, { db = fakeDb(), meta = fakeMeta(), warm, ...rest } = {}) {
    let adopted = null;
    let refreshes = 0;
    const vault = await startSync({
        db,
        adopt: (impl) => { adopted = impl; },
        onRecords: async () => { refreshes += 1; },
        warm: warm ?? (async () => ({ accountId: ACCOUNT, dek: DEK })),
        ...(meta ? { meta } : {}),
        fetch: server.fetch,
        debounceMs: 0,
        now: () => BASE,
        ...rest,
    });
    return { vault, db, meta, adopted, refreshes: () => refreshes };
}

async function serverRecords(server) {
    const kData = await deriveKData(DEK);
    return openState({
        kData,
        accountId: ACCOUNT,
        version: server.blob.version,
        nonce: server.blob.nonce,
        ct: server.blob.ct,
    });
}

beforeEach(reset);

describe('boot picks the §3 port implementation', () => {
    test('no vault on the device: the port is left alone and nothing is an error', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        const { vault, adopted } = await boot(server, { warm: async () => null });

        assert.equal(vault, null);
        // The store keeps localRecords. Adopting anything here would swap a
        // working offline app for a vault that does not exist.
        assert.equal(adopted, null);
        assert.equal(server.requests.length, 0, 'a device with no vault must not touch the network');

        const desc = describeSync(syncState(), { online: true });
        assert.equal(desc.tone, 'local');
        assert.equal(desc.ambient, false, 'having no account is not a problem to nag about');
        assert.equal(desc.action.href, '/vault.html');
    });

    test('a warm vault: the port is swapped for vaultRecords and it pulls on open', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        const { vault, adopted, refreshes } = await boot(server);

        assert.ok(vault, 'a device holding a vault must run the vault port');
        assert.equal(adopted, vault, 'the store must be handed the SAME object the sync layer drives');
        // The §3 contract, so web/domain/ cannot tell the two apart.
        for (const method of ['list', 'put', 'del']) assert.equal(typeof adopted[method], 'function');
        assert.equal(server.requests[0].method, 'GET', 'open must pull before anything else');
        assert.ok(refreshes() > 0, 'the screens must be re-derived after a pull');
        assert.equal(syncState().connected, true);
    });

    test('writes through the adopted port reach the server', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        const { adopted } = await boot(server);

        await adopted.put('account', 'acct_1', { name: 'Broker', kind: 'cash', currency: 'EUR' });
        await until(() => server.blob !== null);

        const remote = await serverRecords(server);
        assert.deepEqual(remote.map((r) => r.recordId), ['acct_1']);
    });
});

describe('signing up must not lose an offline-built portfolio', () => {
    test('records written before signup are in the vault after signup', async () => {
        // Before: no account at all, so localRecords over the one per-device
        // mirror. This is a real portfolio somebody typed in on a plane.
        const db = fakeDb();
        const local = createLocalRecords({ db, now: () => BASE });
        await local.put('account', 'acct_1', { name: 'Broker', kind: 'cash', currency: 'EUR' });
        await local.put('security', 'sec_1', { name: 'FTSE All-World', ticker: 'VWCE', currency: 'EUR' });
        await local.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1000000 });
        await local.del('transaction', 'tx_1');
        await local.put('transaction', 'tx_2', { type: 'buy', date: '2024-03-15', amount: 123456 });

        // Signup happened: the ceremony wrote an LDK cache, redirected to '/',
        // and the shell boots warm onto the SAME mirror.
        const server = fakeServer({ serverNow: () => BASE });
        const { adopted } = await boot(server, { db });

        assert.ok(server.blob, 'the first sync after signup must upload the existing rows');
        const remote = await serverRecords(server);
        const ids = remote.map((r) => r.recordId).sort();
        assert.deepEqual(ids, ['acct_1', 'sec_1', 'tx_1', 'tx_2']);
        // §6: the tombstone travels too, or the delete comes back from the dead
        // on the next device.
        assert.equal(remote.find((r) => r.recordId === 'tx_1').deleted, true);
        assert.equal(remote.find((r) => r.recordId === 'tx_2').amount, 123456);
        // And the live rows are still readable through the port, unchanged.
        assert.deepEqual((await adopted.list('transaction')).map((r) => r.recordId), ['tx_2']);
    });

    test('a second device pulls that portfolio down', async () => {
        const db = fakeDb();
        const local = createLocalRecords({ db, now: () => BASE });
        await local.put('account', 'acct_1', { name: 'Broker', kind: 'cash', currency: 'EUR' });

        const server = fakeServer({ serverNow: () => BASE });
        await boot(server, { db });
        assert.ok(server.blob);

        // A different browser: empty mirror, empty sync metadata, same account.
        await reset();
        const second = fakeDb();
        const { adopted } = await boot(server, { db: second, meta: fakeMeta() });

        assert.deepEqual((await adopted.list('account')).map((r) => r.name), ['Broker']);
    });
});

/**
 * One browser profile, in memory: the pre-signup mirror plus a mirror and a
 * metadata record per account, exactly the layout localdb.js names on disk. The
 * migration is the real one; only Dexie and IndexedDB are doubles.
 */
function fakeDevice() {
    const mirrors = new Map();
    const metas = new Map();
    return {
        db: fakeDb(),
        mirror: (id) => mirrors.get(id),
        openMirror: async (accountId, from) => {
            if (!mirrors.has(accountId)) mirrors.set(accountId, fakeDb());
            const mirror = mirrors.get(accountId);
            await claim(from, mirror);
            return mirror;
        },
        openMeta: (accountId) => {
            if (!metas.has(accountId)) metas.set(accountId, fakeMeta());
            return metas.get(accountId);
        },
    };
}

describe('two accounts in one browser profile (bd myportfolio-18h.12)', () => {
    const DEK_B = new Uint8Array(32).fill(7);

    /** Unlock `accountId` on `device`, the way a cold unlock replaces the LDK cache. */
    function unlock(server, device, accountId, dek) {
        return boot(server, {
            db: device.db,
            meta: null,
            openMirror: device.openMirror,
            openMeta: device.openMeta,
            warm: async () => ({ accountId, dek }),
        });
    }

    test('records written under A are invisible under B, and are still A\'s when A comes back', async () => {
        const device = fakeDevice();
        const serverA = fakeServer({ serverNow: () => BASE });
        const { adopted: a } = await unlock(serverA, device, ACCOUNT, DEK);
        await a.put('account', 'acct_a', { name: 'A broker', kind: 'cash', currency: 'EUR' });
        await until(() => serverA.blob !== null);

        // Same browser, second passkey. This is the case that used to land
        // straight on the first account's records.
        await reset();
        const serverB = fakeServer({ serverNow: () => BASE });
        const { vault: vaultB, adopted: b } = await unlock(serverB, device, OTHER_ACCOUNT, DEK_B);

        assert.ok(vaultB, 'the second account must OPEN, not be refused — that was the mitigation, not the fix');
        assert.deepEqual(await b.list('account'), [], 'B must not see A\'s portfolio');
        assert.equal(serverB.blob, null, 'and must never upload it into B\'s vault');

        await b.put('account', 'acct_b', { name: 'B broker', kind: 'cash', currency: 'EUR' });
        await until(() => serverB.blob !== null);

        // Switching back retains rather than re-downloads (the documented
        // decision in localdb.js) — and A still has exactly A's rows.
        await reset();
        const { adopted: again } = await unlock(serverA, device, ACCOUNT, DEK);
        assert.deepEqual((await again.list('account')).map((r) => r.recordId), ['acct_a']);
        assert.deepEqual(
            (await device.mirror(OTHER_ACCOUNT).records.toArray()).map((r) => r.recordId),
            ['acct_b'],
            'and B\'s mirror was never touched by A'
        );
    });

    test('the wrong-account refusal is unreachable in normal use, and still fires if reached', async () => {
        const device = fakeDevice();
        const server = fakeServer({ serverNow: () => BASE });
        await unlock(server, device, ACCOUNT, DEK);

        // A shares this device with B. Neither is refused, because neither is
        // reading the other's versions.
        await reset();
        const { vault } = await unlock(server, device, OTHER_ACCOUNT, DEK_B);
        assert.equal(vault !== null, true);
        assert.equal(syncState().fatal, null, 'per-account metadata means the guard never trips here');

        // The backstop is still armed: hand it a mirror stamped with another
        // vault and it refuses before touching the wire. (The copy and the
        // fallback behaviour are asserted in the wrong-account test below.)
        await reset();
        const stamped = fakeMeta({ accountId: 'someone-else', lastVersion: 4, highestVersion: 4, clockSkewMs: 0 });
        const { vault: refused } = await boot(server, {
            db: device.db,
            meta: stamped,
            openMirror: device.openMirror,
            warm: async () => ({ accountId: ACCOUNT, dek: DEK }),
        });
        assert.equal(refused, null);
        assert.equal(syncState().fatal.code, 'wrong-account');
    });

    test('pre-signup rows go to the account that signs up, and to no other', async () => {
        // Typed on a plane with no account at all.
        const device = fakeDevice();
        const local = createLocalRecords({ db: device.db, now: () => BASE });
        await local.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1000000 });

        const serverA = fakeServer({ serverNow: () => BASE });
        const { adopted: a } = await unlock(serverA, device, ACCOUNT, DEK);

        assert.deepEqual((await a.list('transaction')).map((r) => r.recordId), ['tx_1']);
        assert.deepEqual((await serverRecords(serverA)).map((r) => r.recordId), ['tx_1']);
        // Moved, not copied. A row left in the pre-signup mirror would be handed
        // to the next account to unlock here — the same leak, one signup later.
        assert.deepEqual(await device.db.records.toArray(), []);

        await reset();
        const serverB = fakeServer({ serverNow: () => BASE });
        const { adopted: b } = await unlock(serverB, device, OTHER_ACCOUNT, DEK_B);
        assert.deepEqual(await b.list('transaction'), []);
    });
});

describe('a sync that is not working must be visible', () => {
    test('a failing server surfaces rather than being swallowed', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        server.failWith = 500;
        server.failCount = -1;

        const { vault } = await boot(server);
        // startSync must not reject — a failed pull is a rendered state, not a
        // crashed shell.
        assert.ok(vault);

        const snapshot = syncState();
        assert.ok(snapshot.status.lastError, 'the engine error must reach the status the UI reads');
        assert.equal(snapshot.status.lastError.code, 'server');

        const desc = describeSync(snapshot, { online: true });
        assert.equal(desc.ambient, false, 'one 500 is a blip, not yet a banner');

        // The second failure is the one that means something.
        await syncNow();
        const after = describeSync(syncState(), { online: true });
        assert.equal(after.tone, 'warn');
        assert.equal(after.ambient, true);
        assert.match(after.detail, /saved on this device/);
    });

    test('a write is never dropped by a failed flush', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        const { adopted, db } = await boot(server);
        server.failWith = 500;
        server.failCount = -1;

        await adopted.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1000000 });
        await until(() => syncState().status?.lastError !== null);

        assert.equal(syncState().status.pending, true, 'the write must stay pending');
        assert.equal(db.rows.get('tx_1').amount, 1000000, 'and it must still be in the mirror');
        assert.equal(server.blob, null);

        // Once the server comes back the pending write goes, with no user action.
        server.failWith = null;
        await syncNow();
        const remote = await serverRecords(server);
        assert.deepEqual(remote.map((r) => r.recordId), ['tx_1']);
        assert.equal(syncState().status.pending, false);
        assert.equal(syncState().status.lastError, null);
    });

    test('a 401 routes to unlock, keeps the pending write, and is not read as offline', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        const { adopted, db } = await boot(server);
        server.failWith = 401;
        server.failCount = -1;

        await adopted.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1000000 });
        await until(() => syncState().status?.needsAuth === true);

        const snapshot = syncState();
        assert.equal(snapshot.status.needsAuth, true);
        assert.equal(snapshot.status.pending, true, 'an expired session must never drop a write');
        assert.equal(db.rows.get('tx_1').amount, 1000000);

        // Offline or not, an expired session needs the passkey ceremony — so
        // the copy must not change with navigator.onLine.
        for (const online of [true, false]) {
            const desc = describeSync(snapshot, { online });
            assert.equal(desc.tone, 'auth');
            assert.equal(desc.ambient, true);
            assert.equal(desc.action.href, '/vault.html', 'the user must be routed to unlock');
            assert.match(desc.headline, /expired/i);
            assert.doesNotMatch(desc.headline, /offline/i);
        }
    });

    test('offline reads as normal, and the same failure with a network reads as broken', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        const { adopted } = await boot(server);
        server.failWith = 'network';
        server.failCount = -1;

        await adopted.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1000000 });
        await until(() => syncState().status?.lastError !== null);
        await syncNow();

        const offline = describeSync(syncState(), { online: false });
        assert.equal(offline.tone, 'offline');
        assert.equal(offline.ambient, false, 'being offline is the expected case and must not nag');
        assert.match(offline.detail, /will sync when you are back online/);

        const online = describeSync(syncState(), { online: true });
        assert.equal(online.tone, 'warn');
        assert.equal(online.ambient, true, 'a reachable network that still cannot sync IS news');
    });

    test('wrong-account refuses to swap the port and says something actionable', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        // The mirror was claimed by a different vault (§3, one per profile).
        const meta = fakeMeta({ accountId: OTHER_ACCOUNT, lastVersion: 4, highestVersion: 4, clockSkewMs: 0 });
        const { vault, adopted } = await boot(server, { meta });

        assert.equal(vault, null);
        assert.equal(adopted, null, 'this device must keep serving its own rows, unsynced');
        assert.equal(server.requests.length, 0, 'and must never upload them into the other vault');

        const desc = describeSync(syncState(), { online: true });
        assert.equal(desc.tone, 'error');
        assert.equal(desc.ambient, true);
        // Actionable copy, not a raw error string.
        assert.doesNotMatch(desc.headline, /^sync:/);
        assert.doesNotMatch(desc.detail, /Refusing/);
        assert.match(desc.detail, /browser profile/);
        assert.match(desc.detail, /still saved on this device/);
    });
});

describe('pull on open and on focus', () => {
    test('focus pulls, and a burst of focus events does not', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        await boot(server);
        const afterOpen = server.requests.length;

        const target = new EventTarget();
        let clock = BASE;
        const stop = watchFocus({ target, doc: null, minIntervalMs: 10_000, now: () => clock });

        // One alt-tab fires focus and visibilitychange; that is one pull.
        clock += 20_000;
        target.dispatchEvent(new Event('focus'));
        target.dispatchEvent(new Event('visibilitychange'));
        await until(() => server.requests.length > afterOpen);
        const afterFirst = server.requests.length;

        clock += 500;
        target.dispatchEvent(new Event('focus'));
        target.dispatchEvent(new Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(server.requests.length, afterFirst, 'refocusing repeatedly must not hammer the server');

        // Past the interval it pulls again.
        clock += 20_000;
        target.dispatchEvent(new Event('focus'));
        await until(() => server.requests.length > afterFirst);
        stop();

        // …and once the listeners are off, nothing fires.
        const settled = server.requests.length;
        clock += 60_000;
        target.dispatchEvent(new Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(server.requests.length, settled);
    });

    test('coming back online retries the write that failed while offline', async () => {
        // The user never leaves the tab, so no focus event ever arrives. The
        // offline copy has promised this write will go when the network is
        // back; `online` is the only signal that says it is.
        const server = fakeServer({ serverNow: () => BASE });
        const { adopted, db } = await boot(server);
        server.failWith = 'network';
        server.failCount = -1;

        await adopted.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1000000 });
        await until(() => syncState().status?.lastError !== null);
        assert.equal(db.rows.get('tx_1').amount, 1000000);

        const target = new EventTarget();
        // The interval gate must NOT swallow this: the last pull was seconds
        // ago and it failed, which is exactly why the retry matters.
        const stop = watchFocus({ target, doc: null, minIntervalMs: 60_000, now: () => BASE });

        server.failWith = null;
        target.dispatchEvent(new Event('online'));
        await until(() => server.blob !== null);
        stop();

        assert.deepEqual((await serverRecords(server)).map((r) => r.recordId), ['tx_1']);
        assert.equal(syncState().status.pending, false);
    });

    test('a flush with nothing to send must not claim a fresh sync', async () => {
        // vaultRecords emits syncing true/false for a flush even when there is
        // nothing dirty, and that flush never touches the network. Dating a
        // sync from it would print "Synced just now" over a server that has
        // been unreachable for a week — the exact lie this affordance exists
        // to prevent.
        const server = fakeServer({ serverNow: () => BASE });
        let clock = BASE;
        const { vault } = await boot(server, { now: () => clock });
        assert.equal(syncState().lastSyncedAt, BASE);

        clock = BASE + 3 * 86_400_000;
        await vault.flush();
        assert.equal(syncState().lastSyncedAt, BASE, 'a no-op flush is not a sync');
        assert.match(describeSync(syncState(), { online: true, now: () => clock }).headline, /3 days ago/);

        // A flush that DOES carry a write is a sync, and dates itself.
        await vault.put('transaction', 'tx_1', { type: 'deposit', date: '2024-01-02', amount: 1 });
        await until(() => server.blob !== null);
        assert.equal(syncState().lastSyncedAt, clock);
    });

    test('no timer is armed: an idle app with a vault makes no requests', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        await boot(server);
        const afterOpen = server.requests.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(server.requests.length, afterOpen, '§6 says pull on open and on focus — never poll');
    });

    test('a device with no vault ignores focus entirely', async () => {
        const server = fakeServer({ serverNow: () => BASE });
        await boot(server, { warm: async () => null });

        const target = new EventTarget();
        watchFocus({ target, doc: null, minIntervalMs: 0, now: () => BASE });
        target.dispatchEvent(new Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(server.requests.length, 0);
    });
});

describe('describeSync copy', () => {
    const connected = (status) => ({
        connected: true, accountId: ACCOUNT, status, fatal: null, lastSyncedAt: null, failures: 0,
    });
    const idle = {
        pending: false, syncing: false, lastError: null, wedged: false, needsAuth: false,
        clockSkewMs: 0, clockWarning: false, version: 3,
    };

    test('a settled vault says so without a lie about when', () => {
        const desc = describeSync(connected(idle), { online: true });
        assert.equal(desc.tone, 'ok');
        assert.equal(desc.ambient, false);
        assert.equal(desc.headline, 'Synced');
    });

    test('"last synced" is a real relative time, which is the honest indicator', () => {
        const now = BASE + 3 * 86_400_000;
        const desc = describeSync(
            { ...connected(idle), lastSyncedAt: BASE },
            { online: true, now: () => now }
        );
        assert.match(desc.headline, /3 days ago/);
    });

    test('a wedged vault names the reason and never claims data was lost', () => {
        for (const code of ['quota', 'rollback', 'corrupt', 'server']) {
            const status = { ...idle, wedged: true, pending: true, lastError: syncError(code, `sync: ${code}`) };
            const desc = describeSync(connected(status), { online: true });
            assert.equal(desc.tone, 'error', code);
            assert.equal(desc.ambient, true, code);
            assert.match(desc.detail, /device/, code);
        }
    });

    test('a skewed clock is surfaced, whatever else is happening', () => {
        const status = { ...idle, clockWarning: true, clockSkewMs: 9 * 60_000 };
        const desc = describeSync(connected(status), { online: true });
        assert.match(desc.detail, /clock is off by about 9 minutes/);
    });

    test('a pending write is information, not an alarm', () => {
        const desc = describeSync(connected({ ...idle, pending: true }), { online: true });
        assert.equal(desc.tone, 'pending');
        assert.equal(desc.ambient, false);
    });

    test('losing five merge races in a row is shown immediately', () => {
        const status = { ...idle, pending: true, lastError: syncError('conflict', 'sync: gave up', { retriable: true }) };
        const desc = describeSync(connected(status), { online: true });
        assert.equal(desc.tone, 'warn');
        assert.equal(desc.ambient, true, 'a wedged merge loop must not wait for a second failure');
    });
});
