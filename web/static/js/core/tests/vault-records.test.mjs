// vaultRecords end to end: two simulated devices, one fake server with the real
// compare-and-swap semantics of internal/server/state.go, real crypto and real
// gzip. Everything here is a bug the sibling project actually shipped.
//
// The clocks are injected, so nothing sleeps and nothing races: a sync test
// that depends on wall time is a flake that gets deleted six months later.
//
// See the note at the top of state-sync.test.mjs about the file split — node
// 18's runner wedges past a certain amount of async work in one child.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

globalThis.crypto ??= nodeCrypto.webcrypto;

const { createVaultRecords } = await import('../vault-records.js');
const { openState } = await import('../state-sync.js');
const { deriveKData } = await import('../crypto.js');
const { fakeDb, fakeServer, fakeMeta, clock, tick, until } = await import('./sync-fakes.mjs');

const ACCOUNT = 'amber-falcon-8k3q9x';
const DEK = new Uint8Array(32).fill(3);
// A whole second: the Date header carries no milliseconds, so a device clock on
// a whole second measures its offset from the server exactly.
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

// One device: its own mirror, its own sync metadata, its own clock.
async function device(server, { now, debounceMs = 0 } = {}) {
  const db = fakeDb();
  const vault = await createVaultRecords({
    db,
    dek: DEK,
    accountId: ACCOUNT,
    meta: fakeMeta(),
    fetch: server.fetch,
    debounceMs,
    now,
  });
  return { db, vault, rows: () => [...db.rows.values()] };
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

const find = (records, id) => records.find((r) => r.recordId === id);

describe('vaultRecords as the §3 port', () => {
  it('put, list and del behave exactly as localRecords does', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault, db } = await device(server, { now: () => BASE });

    await vault.put('account', 'acct_1', { name: 'Broker', kind: 'securities', currency: 'EUR' });
    assert.deepEqual(await vault.list('account'), [{
      name: 'Broker',
      kind: 'securities',
      currency: 'EUR',
      recordId: 'acct_1',
      recordType: 'account',
      clientTs: BASE,
      deleted: false,
    }]);

    await vault.del('account', 'acct_1');
    assert.deepEqual(await vault.list('account'), []);
    // A tombstone, never a hard delete: the row stays so the next merge cannot
    // resurrect the record from another device's copy.
    assert.equal(db.rows.get('acct_1').deleted, true);
  });

  it('coalesces a burst of writes into ONE upload', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault } = await device(server, { now: () => BASE });

    await vault.put('account', 'acct_1', { name: 'a' });
    await vault.put('security', 'sec_1', { name: 's' });
    await vault.put('transaction', 'tx_1', { type: 'buy', amount: 100 });
    // Nothing but the debounce timer triggers this upload.
    await until(() => server.blob !== null);

    const puts = server.requests.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 1, 'a form that writes three records must upload once');
    assert.deepEqual((await serverRecords(server)).map((r) => r.recordId).sort(), ['acct_1', 'sec_1', 'tx_1']);
  });
});

describe('two devices', () => {
  it('carries a record from one device to the other', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const a = await device(server, { now: () => BASE });
    const b = await device(server, { now: () => BASE });

    await a.vault.put('transaction', 'tx_1', { type: 'buy', amount: 123456 });
    await a.vault.flush();
    await b.vault.sync();

    assert.equal(find(await b.vault.list('transaction'), 'tx_1').amount, 123456);
  });

  // The 409 path: both devices wrote against version 1, one loses the race and
  // has to merge instead of overwriting.
  it('keeps concurrent edits to DIFFERENT records from both devices', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const a = await device(server, { now: () => BASE });
    const b = await device(server, { now: () => BASE });

    await a.vault.put('transaction', 'tx_a', { amount: 1 });
    await a.vault.flush();
    await b.vault.sync();

    // Both edit while offline from each other.
    await a.vault.put('transaction', 'tx_a2', { amount: 2 });
    await b.vault.put('transaction', 'tx_b2', { amount: 3 });
    await a.vault.flush();
    await b.vault.flush(); // 409 -> merge -> retry

    assert.deepEqual(
      (await serverRecords(server)).map((r) => r.recordId).sort(),
      ['tx_a', 'tx_a2', 'tx_b2']
    );
    await a.vault.sync();
    assert.equal((await a.vault.list('transaction')).length, 3);
  });

  it('resolves a collision on the same record to the higher clientTs', async () => {
    const time = clock(BASE);
    const server = fakeServer({ serverNow: time.now });
    const a = await device(server, { now: time.now });
    const b = await device(server, { now: time.now });

    await a.vault.put('transaction', 'tx_1', { amount: 100 });
    await a.vault.flush();
    await b.vault.sync();

    time.advance(1000);
    await b.vault.put('transaction', 'tx_1', { amount: 200 });
    time.advance(1000);
    await a.vault.put('transaction', 'tx_1', { amount: 300 }); // the later edit

    await b.vault.flush();
    await a.vault.flush(); // 409 -> merge -> a's edit is newer and wins

    assert.equal(find(await serverRecords(server), 'tx_1').amount, 300);
    await b.vault.sync();
    assert.equal(find(await b.vault.list('transaction'), 'tx_1').amount, 300,
      'the losing device must end up showing the winner');
  });

  it('lets a delete on one device beat an older edit on another', async () => {
    const time = clock(BASE);
    const server = fakeServer({ serverNow: time.now });
    const a = await device(server, { now: time.now });
    const b = await device(server, { now: time.now });

    await a.vault.put('transaction', 'tx_1', { amount: 100 });
    await a.vault.flush();
    await b.vault.sync();

    await b.vault.put('transaction', 'tx_1', { amount: 999 }); // older edit
    time.advance(5000);
    await a.vault.del('transaction', 'tx_1'); // newer delete

    await b.vault.flush();
    await a.vault.flush();

    assert.equal(find(await serverRecords(server), 'tx_1').deleted, true);
    await b.vault.sync();
    assert.deepEqual(await b.vault.list('transaction'), [], 'the delete must reach the other device');
    // Retained indefinitely: dropping it resurrects the transaction on a device
    // that was offline across the GC.
    assert.equal(b.db.rows.get('tx_1').deleted, true);
  });

  // §3, the guard learned the hard way: a device whose clock is behind must not
  // lose the edits it makes, neither to a record it just pulled nor to a new one.
  it('does not lose the edits of a device whose clock is ten minutes slow', async () => {
    const time = clock(BASE);
    const server = fakeServer({ serverNow: time.now });
    const a = await device(server, { now: time.now });
    const slow = await device(server, { now: () => time.now() - 10 * 60_000 });

    await a.vault.put('transaction', 'tx_1', { amount: 100 });
    await a.vault.flush();
    await slow.vault.sync(); // learns the server's clock from the Date header

    await slow.vault.put('transaction', 'tx_1', { amount: 200 });
    await slow.vault.put('transaction', 'tx_2', { amount: 300 });
    await slow.vault.flush();

    // Guard 1 — server-referenced time: a brand-new record on the slow device is
    // stamped on the SERVER's scale, not ten minutes in the past.
    assert.equal(slow.db.rows.get('tx_2').clientTs, BASE);
    // Guard 2 — per-record monotonic: editing what you can see beats what you
    // are overwriting, whatever either clock says.
    assert.ok(slow.db.rows.get('tx_1').clientTs > a.db.rows.get('tx_1').clientTs);

    await a.vault.sync();
    assert.equal(find(await a.vault.list('transaction'), 'tx_1').amount, 200,
      'the slow device just lost an edit it made to a record it could see');
    assert.equal(slow.vault.status().clockSkewMs, -10 * 60_000);
    assert.equal(slow.vault.status().clockWarning, true);
  });
});

describe('surfacing failures', () => {
  it('never drops a write when the upload fails', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault, db } = await device(server, { now: () => BASE });

    server.failWith = 503;
    server.failCount = 1;
    await vault.put('transaction', 'tx_1', { amount: 100 });
    await assert.rejects(() => vault.flush(), /answered 503/);

    const status = vault.status();
    assert.equal(status.pending, true, 'a failed upload must stay pending');
    assert.equal(status.wedged, false, 'a 503 is worth retrying');
    assert.equal(db.rows.get('tx_1').amount, 100, 'the record is still in the mirror');

    // The next trigger picks it up — nothing was lost and nothing was silent.
    await vault.flush();
    assert.equal(find(await serverRecords(server), 'tx_1').amount, 100);
    assert.equal(vault.status().pending, false);
    assert.equal(vault.status().lastError, null);
  });

  it('marks a doomed upload wedged instead of re-POSTing it forever', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault } = await device(server, { now: () => BASE });

    server.failWith = 413;
    server.failCount = -1;
    await vault.put('transaction', 'tx_1', { amount: 100 });
    await assert.rejects(() => vault.flush(), /quota/);

    assert.equal(vault.status().wedged, true);
    assert.equal(vault.status().pending, true);

    // The debounce timer from the write above was already armed before the
    // wedge was known, so let that one land before counting.
    await until(() => server.requests.length >= 2);
    const before = server.requests.length;
    // A wedged sync stops scheduling. It has surfaced; a human has to look.
    await vault.put('transaction', 'tx_2', { amount: 200 });
    await tick();
    await tick();
    assert.equal(server.requests.length, before, 'a wedged sync must not keep hammering');
  });

  it('reports a 401 as needing the passkey ceremony, not as being offline', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault, db } = await device(server, { now: () => BASE });

    server.failWith = 401;
    server.failCount = -1;
    await vault.put('transaction', 'tx_1', { amount: 100 });
    await assert.rejects(() => vault.flush(), /session expired/);

    assert.equal(vault.status().needsAuth, true);
    assert.equal(vault.status().pending, true);
    assert.equal(db.rows.get('tx_1').amount, 100);
  });

  it('refuses a rolled-back server and leaves the mirror alone', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault, db } = await device(server, { now: () => BASE });

    await vault.put('transaction', 'tx_1', { amount: 100 });
    await vault.flush();

    server.blob = null; // the account was wiped, or this is the wrong server
    await assert.rejects(() => vault.sync(), /Refusing to apply/);
    assert.equal(db.rows.get('tx_1').amount, 100, 'stale state must not be applied over real data');
    assert.equal(vault.status().wedged, true);
  });
});

describe('signup migration', () => {
  it('unions an offline-built portfolio into the vault on the first sync', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    // Another device already has a vault with one record.
    const other = await device(server, { now: () => BASE });
    await other.vault.put('transaction', 'tx_remote', { amount: 1 });
    await other.vault.flush();

    // This device used the app offline first: localRecords wrote straight into
    // the same mirror, and signing up swaps the port underneath it.
    const fresh = await device(server, { now: () => BASE });
    fresh.db.rows.set('tx_local', {
      recordId: 'tx_local', recordType: 'transaction', clientTs: BASE, deleted: false, amount: 2,
    });

    await fresh.vault.sync();

    assert.deepEqual(
      (await serverRecords(server)).map((r) => r.recordId).sort(),
      ['tx_local', 'tx_remote'],
      'signing up must not throw away what the user already entered'
    );
    assert.equal((await fresh.vault.list('transaction')).length, 2);
  });

  it('does not re-upload when a sync changed nothing', async () => {
    const server = fakeServer({ serverNow: () => BASE });
    const { vault } = await device(server, { now: () => BASE });

    await vault.put('transaction', 'tx_1', { amount: 100 });
    await vault.flush();
    const puts = server.requests.filter((r) => r.method === 'PUT').length;

    await vault.sync();
    await vault.sync();

    assert.equal(server.requests.filter((r) => r.method === 'PUT').length, puts,
      'an idle focus must not rewrite the whole blob');
  });
});
