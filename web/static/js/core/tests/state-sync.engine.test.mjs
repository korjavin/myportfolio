// The sync engine of ARCHITECTURE.md 6 driven over a fake server: the
// compare-and-swap loop, merge-on-409, rollback detection, the 401/timeout
// split, and the server-referenced clock.
//
// Split out of state-sync.test.mjs on purpose — see the note at the top of that
// file: node 18's test runner wedges when both halves run in one child.
//
// Nothing here needs a live server. The fake in sync-fakes.mjs implements the
// same compare-and-swap semantics as internal/server/state.go, which is what
// makes a two-device conflict reproducible in a unit test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

globalThis.crypto ??= nodeCrypto.webcrypto;

const { mergeRecords, sealState, openState, createStateSync, createIdbMeta, MAX_MERGE_ATTEMPTS } =
  await import('../state-sync.js');
const { fakeServer, fakeMeta, clock } = await import('./sync-fakes.mjs');

const ACCOUNT = 'amber-falcon-8k3q9x';
const K_DATA = new Uint8Array(32).fill(7);

const rec = (recordId, clientTs, body = {}) => ({
  recordId,
  recordType: 'transaction',
  clientTs,
  deleted: false,
  ...body,
});
const ids = (records) => records.map((r) => r.recordId).sort();

function newSync(server, meta = fakeMeta(), extra = {}) {
  return createStateSync({
    kData: K_DATA,
    accountId: ACCOUNT,
    meta,
    fetch: server.fetch,
    ...extra,
  });
}

describe('createStateSync', () => {
  it('returns null from pull when the server has no blob yet', async () => {
    assert.equal(await newSync(fakeServer()).pull(), null);
  });

  // The version the client PUTs is the one it last read; the version it binds
  // into the AAD is the one the blob will be STORED as. They differ by one and
  // the server is the arbiter of which is which.
  it('PUTs the last-read version and seals against last-read + 1', async () => {
    const server = fakeServer();
    const sync = newSync(server);

    await sync.push([rec('tx_1', 100)], () => []);

    assert.deepEqual(server.requests.at(-1).body.version, 0);
    assert.equal(server.blob.version, 1);
    // The proof: the stored blob only opens at the version the server stored it as.
    const back = await openState({ kData: K_DATA, accountId: ACCOUNT, version: 1, nonce: server.blob.nonce, ct: server.blob.ct });
    assert.deepEqual(ids(back), ['tx_1']);

    await sync.push([rec('tx_1', 100), rec('tx_2', 200)], () => []);
    assert.equal(server.requests.at(-1).body.version, 1);
    assert.equal(server.blob.version, 2);
  });

  it('merges and retries on 409, then leaves the union on the server', async () => {
    const server = fakeServer();
    const winner = newSync(server);
    const loser = newSync(server);

    await winner.push([rec('tx_1', 100)], () => []);

    // `loser` still thinks the server is at version 0.
    let sawConflict = null;
    const merged = await loser.push([rec('tx_2', 200)], (remote) => {
      sawConflict = remote;
      return mergeRecords([rec('tx_2', 200)], remote);
    });

    assert.deepEqual(ids(sawConflict), ['tx_1'], 'the 409 body was decrypted and handed back');
    assert.deepEqual(ids(merged), ['tx_1', 'tx_2']);
    assert.equal(server.blob.version, 2);
    const stored = await openState({ kData: K_DATA, accountId: ACCOUNT, version: 2, nonce: server.blob.nonce, ct: server.blob.ct });
    assert.deepEqual(ids(stored), ['tx_1', 'tx_2']);
  });

  it('gives up with a real error after the retry bound rather than looping', async () => {
    const server = fakeServer();
    const sync = newSync(server);
    let attempts = 0;

    // A rival that writes between every attempt, so every PUT loses.
    const rival = newSync(server, fakeMeta());
    await rival.push([rec('rival_0', 100)], () => []);

    const err = await sync.push([rec('tx_1', 100)], async (remote) => {
      attempts += 1;
      await rival.pull();
      await rival.push([...remote, rec(`rival_${attempts}`, 100 + attempts)], () => []);
      return [rec('tx_1', 100)];
    }).then(() => null, (e) => e);

    assert.ok(err, 'a wedged sync must surface, not spin');
    assert.equal(err.code, 'conflict');
    assert.equal(attempts, MAX_MERGE_ATTEMPTS);
    assert.match(err.message, /5 merge attempts/);
  });

  it('refuses a GET that rolls the version backwards', async () => {
    const server = fakeServer();
    const meta = fakeMeta();
    const sync = newSync(server, meta);

    await sync.push([rec('tx_1', 100)], () => []);
    await sync.push([rec('tx_1', 100), rec('tx_2', 200)], () => []);
    assert.equal(meta.peek().highestVersion, 2);

    // The operator serves an older matched (version, nonce, ct) triple.
    const stale = await sealState({ kData: K_DATA, accountId: ACCOUNT, version: 1, records: [rec('tx_1', 100)] });
    server.blob = { version: 1, ...stale };

    const err = await sync.pull().then(() => null, (e) => e);
    assert.equal(err?.code, 'rollback');
    assert.match(err.message, /version 1 after this device had already seen 2/);
  });

  it('refuses a 204 from a server that has already served a blob', async () => {
    const server = fakeServer();
    const sync = newSync(server);
    await sync.push([rec('tx_1', 100)], () => []);

    server.blob = null; // the account was wiped, or we are talking to the wrong one
    const err = await sync.pull().then(() => null, (e) => e);
    assert.equal(err?.code, 'rollback');
  });

  it('remembers the highest version across a restart', async () => {
    const server = fakeServer();
    const meta = fakeMeta();
    await newSync(server, meta).push([rec('tx_1', 100)], () => []);

    // A fresh engine, same device: the persisted metadata is what keeps
    // rollback detection alive across a page load.
    server.blob = null;
    const err = await newSync(server, meta).pull().then(() => null, (e) => e);
    assert.equal(err?.code, 'rollback');
  });

  // The records mirror is one un-scoped database per origin, so a second
  // account in the same browser would otherwise merge one user's portfolio into
  // the other user's vault and upload it.
  it('refuses to run against a mirror that belongs to another vault', async () => {
    const server = fakeServer();
    const meta = fakeMeta();
    await newSync(server, meta).push([rec('tx_1', 100)], () => []);

    const other = createStateSync({ kData: K_DATA, accountId: 'someone-else', meta, fetch: server.fetch });
    const err = await other.pull().then(() => null, (e) => e);
    assert.equal(err?.code, 'wrong-account');
    assert.match(err.message, /Refusing to sync it into a different vault/);
    assert.equal(server.requests.filter((r) => r.method === 'GET').length, 0, 'it must refuse before touching the wire');
  });

  it('reports a 401 as an auth failure, not as being offline', async () => {
    const server = fakeServer();
    server.failWith = 401;
    server.failCount = -1;

    const err = await newSync(server).pull().then(() => null, (e) => e);
    assert.equal(err?.code, 'auth');
    assert.equal(err.retriable, false, 'retrying a 401 without a passkey ceremony just burns requests');
  });

  it('times out instead of hanging forever on a half-open connection', async () => {
    const server = fakeServer();
    server.failWith = 'hang';
    server.failCount = -1;

    const err = await newSync(server, fakeMeta(), { timeoutMs: 20 }).pull().then(() => null, (e) => e);
    assert.equal(err?.code, 'network');
    assert.equal(err.retriable, true, 'nothing was dropped — this one is worth retrying');
  });

  it('treats a 5xx as retriable and a 413 as a wedge', async () => {
    const server = fakeServer();
    server.failWith = 503;
    server.failCount = -1;
    const transient = await newSync(server).pull().then(() => null, (e) => e);
    assert.equal(transient.retriable, true);

    server.failWith = 413;
    const quota = await newSync(server).push([rec('tx_1', 100)], () => []).then(() => null, (e) => e);
    assert.equal(quota.code, 'quota');
    assert.equal(quota.retriable, false, 'a doomed upload must not be re-POSTed forever');
  });

  it('records the server clock offset from the Date header', async () => {
    const serverClock = clock(Date.UTC(2026, 0, 1, 12, 0, 0));
    const deviceClock = clock(serverClock.now() + 10 * 60_000); // ten minutes fast
    const server = fakeServer({ serverNow: serverClock.now });
    const meta = fakeMeta();
    const sync = newSync(server, meta, { now: deviceClock.now });

    await sync.pull();

    assert.equal(sync.clockSkewMs(), 10 * 60_000);
    assert.equal(meta.peek().clockSkewMs, 10 * 60_000, 'the offset has to survive a reload');
  });

  it('leaves the offset at zero when the response carries no Date', async () => {
    const server = fakeServer();
    const bare = { fetch: async () => ({ status: 204, ok: false, headers: { get: () => null }, json: async () => null }) };
    const sync = newSync(bare);
    await sync.pull();
    assert.equal(sync.clockSkewMs(), 0);
  });
});

// The metadata store is device-local state (versions seen, clock offset) and it
// is what rollback detection rests on across a reload, so the plumbing gets one
// runnable check rather than a code read. Minimal IndexedDB double: enough of
// the shape for open/transaction/get/put and the versionchange handler.
describe('createIdbMeta', () => {
  function fakeIndexedDb() {
    const stores = new Map();
    const opened = [];
    return {
      opened,
      open() {
        const req = {};
        queueMicrotask(() => {
          const db = {
            objectStoreNames: { contains: (n) => stores.has(n) },
            createObjectStore: (n) => stores.set(n, new Map()),
            closed: false,
            close() { this.closed = true; },
            transaction(name) {
              const tx = {};
              queueMicrotask(() => tx.oncomplete && tx.oncomplete());
              tx.objectStore = () => ({
                get: (k) => ({ result: stores.get(name).get(k) }),
                put: (v, k) => stores.get(name).set(k, v),
              });
              return tx;
            },
          };
          req.result = db;
          opened.push(db);
          if (!stores.size) req.onupgradeneeded();
          req.onsuccess();
        });
        return req;
      },
    };
  }

  it('round-trips the metadata and never leaves a handle blocking an upgrade', async () => {
    const idb = fakeIndexedDb();
    globalThis.indexedDB = idb;
    try {
      const meta = createIdbMeta();
      assert.equal(await meta.get(), undefined);
      await meta.set({ lastVersion: 4, highestVersion: 4, clockSkewMs: -12 });
      assert.deepEqual(await meta.get(), { lastVersion: 4, highestVersion: 4, clockSkewMs: -12 });

      assert.ok(idb.opened.length > 0);
      assert.ok(idb.opened.every((db) => db.closed), 'every open must be closed again');
      // A live handle that ignores versionchange blocks account deletion and
      // schema bumps for as long as the tab is open.
      const db = idb.opened[0];
      db.closed = false;
      db.onversionchange();
      assert.equal(db.closed, true);
    } finally {
      delete globalThis.indexedDB;
    }
  });
});
