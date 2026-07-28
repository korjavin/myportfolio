// §6's merge and blob encoding, tested as PURE FUNCTIONS against fixtures — no
// server, no database. The merge is the one place in this app where a portfolio
// can silently lose a trade, and a test that needs a live server is a test that
// stops being run.
//
// The engine that drives these over the wire (compare-and-swap, rollback
// detection, clock skew) is in state-sync.engine.test.mjs. The split is not
// cosmetic: node 18's test runner wedges — the file's tests all report `ok` and
// the child then never exits — when both halves run in one child process. Each
// half passes alone, in either order, and the whole file passes when run
// directly (`node <file>`) rather than under `--test`. Keep them separate.
//
// The .mjs extension is deliberate: ESM regardless of package.json scope, same
// as crypto.test.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

globalThis.crypto ??= nodeCrypto.webcrypto;

const { mergeRecords, canonical, sealState, openState } = await import('../state-sync.js');

const ACCOUNT = 'amber-falcon-8k3q9x';
const K_DATA = new Uint8Array(32).fill(7);

const rec = (recordId, clientTs, body = {}) => ({
  recordId,
  recordType: 'transaction',
  clientTs,
  deleted: false,
  ...body,
});
const tomb = (recordId, clientTs) => ({ recordId, recordType: 'transaction', clientTs, deleted: true });
const ids = (records) => records.map((r) => r.recordId).sort();
const byId = (records, id) => records.find((r) => r.recordId === id);

describe('mergeRecords', () => {
  it('keeps concurrent edits to DIFFERENT records from both devices', () => {
    const local = [rec('tx_1', 100, { amount: 100 }), rec('tx_2', 100, { amount: 200 })];
    const remote = [rec('tx_1', 100, { amount: 100 }), rec('tx_3', 150, { amount: 300 })];

    const merged = mergeRecords(local, remote);

    assert.deepEqual(ids(merged), ['tx_1', 'tx_2', 'tx_3']);
    assert.equal(byId(merged, 'tx_2').amount, 200);
    assert.equal(byId(merged, 'tx_3').amount, 300);
  });

  it('resolves a collision on the same record to the higher clientTs', () => {
    const older = rec('tx_1', 100, { amount: 100 });
    const newer = rec('tx_1', 101, { amount: 999 });

    assert.equal(byId(mergeRecords([older], [newer]), 'tx_1').amount, 999);
    assert.equal(byId(mergeRecords([newer], [older]), 'tx_1').amount, 999);
  });

  // A tombstone is an ordinary record and wins or loses on clientTs like any
  // other (§6). Both directions matter: the delete must win over an OLDER edit,
  // and must lose to a NEWER one — an unconditional "delete wins" would make
  // re-adding a transaction impossible.
  it('lets a delete beat an older edit on another device', () => {
    const edit = rec('tx_1', 100, { amount: 100 });
    const deletion = tomb('tx_1', 200);

    for (const merged of [mergeRecords([edit], [deletion]), mergeRecords([deletion], [edit])]) {
      assert.equal(byId(merged, 'tx_1').deleted, true);
    }
  });

  it('lets a newer edit beat an older delete', () => {
    const deletion = tomb('tx_1', 100);
    const edit = rec('tx_1', 200, { amount: 100 });

    for (const merged of [mergeRecords([deletion], [edit]), mergeRecords([edit], [deletion])]) {
      assert.equal(byId(merged, 'tx_1').deleted, false);
      assert.equal(byId(merged, 'tx_1').amount, 100);
    }
  });

  it('retains tombstones instead of GCing them', () => {
    // The device that was offline across a GC is the one that resurrects the
    // deleted transaction, so the tombstone has to survive every merge.
    const merged = mergeRecords([tomb('tx_1', 100)], [rec('tx_2', 100)]);
    assert.deepEqual(ids(merged), ['tx_1', 'tx_2']);
    assert.equal(byId(merged, 'tx_1').deleted, true);
  });

  // Without this, each device keeps its own side of a tie, neither sees a
  // change to push, and the two sit on permanently different data with nothing
  // to detect it.
  it('breaks a clientTs tie deterministically, so two devices converge', () => {
    const a = rec('tx_1', 100, { amount: 111 });
    const b = rec('tx_1', 100, { amount: 222 });

    const fromA = byId(mergeRecords([a], [b]), 'tx_1');
    const fromB = byId(mergeRecords([b], [a]), 'tx_1');
    assert.equal(canonical(fromA), canonical(fromB));
  });

  it('is commutative over a whole record set', () => {
    const a = [rec('tx_1', 100, { amount: 1 }), tomb('tx_2', 300), rec('tx_4', 100)];
    const b = [rec('tx_1', 200, { amount: 2 }), rec('tx_2', 200), rec('tx_3', 100)];

    const forward = mergeRecords(a, b).map(canonical).sort();
    const backward = mergeRecords(b, a).map(canonical).sort();
    assert.deepEqual(forward, backward);
  });

  it('takes remote-only records and never drops local-only ones', () => {
    const merged = mergeRecords([rec('tx_1', 100)], [rec('tx_2', 100)]);
    assert.deepEqual(ids(merged), ['tx_1', 'tx_2']);
  });

  it('returns the winning objects themselves, so callers can diff by identity', () => {
    const mine = rec('tx_1', 200);
    const theirs = rec('tx_2', 100);
    const merged = mergeRecords([mine], [theirs]);
    assert.ok(merged.includes(mine));
    assert.ok(merged.includes(theirs));
  });
});

describe('canonical', () => {
  it('is key-order independent, so two devices tie-break the same way', () => {
    assert.equal(canonical({ a: 1, b: { d: 4, c: 3 } }), canonical({ b: { c: 3, d: 4 }, a: 1 }));
  });

  it('distinguishes values a sloppy comparison would not', () => {
    assert.notEqual(canonical({ a: 1 }), canonical({ a: '1' }));
    assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
    assert.notEqual(canonical({ a: null }), canonical({}));
  });
});

describe('state blob encoding', () => {
  it('round-trips records through gzip + AES-GCM', async () => {
    const records = [rec('tx_1', 100, { amount: 123456 }), tomb('tx_2', 101)];
    const blob = await sealState({ kData: K_DATA, accountId: ACCOUNT, version: 3, records });
    const back = await openState({ kData: K_DATA, accountId: ACCOUNT, version: 3, ...blob });
    assert.deepEqual(back, records);
  });

  it('binds the version, so a re-labelled blob fails to open', async () => {
    const blob = await sealState({ kData: K_DATA, accountId: ACCOUNT, version: 3, records: [] });
    await assert.rejects(() => openState({ kData: K_DATA, accountId: ACCOUNT, version: 4, ...blob }));
  });

  it('binds the account, so a blob cannot be replayed into another vault', async () => {
    const blob = await sealState({ kData: K_DATA, accountId: ACCOUNT, version: 3, records: [] });
    await assert.rejects(() => openState({ kData: K_DATA, accountId: 'someone-else', version: 3, ...blob }));
  });

  it('compresses rather than shipping the JSON', async () => {
    const records = Array.from({ length: 200 }, (_, i) => rec(`tx_${i}`, 100, { amount: 100000 }));
    const blob = await sealState({ kData: K_DATA, accountId: ACCOUNT, version: 1, records });
    const rawJson = JSON.stringify(records).length;
    // base64 inflates by 4/3 and it is still far smaller than the plain JSON.
    assert.ok(blob.ct.length < rawJson / 2, `ct ${blob.ct.length} vs json ${rawJson}`);
  });
});
