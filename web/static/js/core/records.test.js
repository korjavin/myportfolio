import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalRecords } from './records.js';

// The slice of Dexie that records.js actually uses, in memory. Keeping the port
// free of a Dexie import is what makes this testable under plain `node --test`;
// localdb.js wires the same three call shapes to the real database.
function fakeDb() {
  const rows = new Map();
  const table = {
    async get(recordId) { return rows.get(recordId); },
    async put(record) { rows.set(record.recordId, { ...record }); },
    where(field) {
      return {
        equals(value) {
          return { async toArray() { return [...rows.values()].filter((r) => r[field] === value); } };
        },
      };
    },
  };
  return { records: table, rows, async transaction(_mode, _table, fn) { return fn(); } };
}

// A clock we control, so the monotonic guard is asserted rather than raced.
function clock(start) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; } };
}

test('put then list round-trips the body and stamps the port-owned fields', async () => {
  const db = fakeDb();
  const c = clock(1000);
  const records = createLocalRecords({ db, now: c.now });

  await records.put('account', 'acct_1', { name: 'Broker', kind: 'securities', currency: 'EUR' });

  assert.deepEqual(await records.list('account'), [{
    name: 'Broker',
    kind: 'securities',
    currency: 'EUR',
    recordId: 'acct_1',
    recordType: 'account',
    clientTs: 1000,
    deleted: false,
  }]);
});

test('list is scoped to one recordType', async () => {
  const db = fakeDb();
  const records = createLocalRecords({ db, now: clock(1).now });

  await records.put('account', 'acct_1', { name: 'A' });
  await records.put('security', 'sec_1', { name: 'S' });
  await records.put('transaction', 'tx_1', { type: 'buy' });

  assert.deepEqual((await records.list('account')).map((r) => r.recordId), ['acct_1']);
  assert.deepEqual((await records.list('security')).map((r) => r.recordId), ['sec_1']);
  assert.deepEqual(await records.list('price'), []);
});

test('the port owns recordId/recordType/clientTs/deleted, whatever the body says', async () => {
  const db = fakeDb();
  const records = createLocalRecords({ db, now: clock(5000).now });

  // The natural read-edit-write cycle hands the whole record back as a body.
  await records.put('account', 'acct_1', {
    name: 'Broker',
    recordId: 'spoofed',
    recordType: 'spoofed',
    clientTs: 999999,
    deleted: true,
  });

  const [row] = await records.list('account');
  assert.equal(row.recordId, 'acct_1');
  assert.equal(row.recordType, 'account');
  assert.equal(row.clientTs, 5000);
  assert.equal(row.deleted, false);
  assert.equal(row.name, 'Broker');
});

test('del writes a tombstone that list excludes but the store keeps', async () => {
  const db = fakeDb();
  const records = createLocalRecords({ db, now: clock(1000).now });

  await records.put('transaction', 'tx_1', { type: 'buy', amount: 100000 });
  await records.del('transaction', 'tx_1');

  assert.deepEqual(await records.list('transaction'), []);

  // A hard delete would resurrect the record on the next merge (§6), so the row
  // must still be there, flagged, and carrying a newer clientTs than the write.
  const tombstone = db.rows.get('tx_1');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.recordType, 'transaction');
  assert.equal(tombstone.clientTs, 1001);
  // The body is dropped; a tombstone only needs identity plus a clientTs.
  assert.equal(tombstone.amount, undefined);
  assert.equal(tombstone.type, undefined);
});

test('del on a record this device never saw still tombstones it', async () => {
  const db = fakeDb();
  const records = createLocalRecords({ db, now: clock(1000).now });

  await records.del('transaction', 'tx_never_seen');

  assert.equal(db.rows.get('tx_never_seen').deleted, true);
  assert.deepEqual(await records.list('transaction'), []);
});

test('clientTs advances monotonically per record even on a frozen clock', async () => {
  const db = fakeDb();
  const c = clock(1000);
  const records = createLocalRecords({ db, now: c.now });

  await records.put('account', 'acct_1', { name: 'a' });
  await records.put('account', 'acct_1', { name: 'b' });
  await records.put('account', 'acct_1', { name: 'c' });

  assert.equal(db.rows.get('acct_1').clientTs, 1002);
});

test('a clock that jumps backwards cannot lose an edit to a visible record', async () => {
  const db = fakeDb();
  const c = clock(10_000);
  const records = createLocalRecords({ db, now: c.now });

  await records.put('account', 'acct_1', { name: 'first' });
  assert.equal(db.rows.get('acct_1').clientTs, 10_000);

  // Device clock corrected backwards (or a skew correction lands) between writes.
  c.set(500);
  await records.put('account', 'acct_1', { name: 'second' });

  // Editing what you can see beats what you are overwriting, whatever the clock says.
  assert.equal(db.rows.get('acct_1').clientTs, 10_001);
  assert.equal(db.rows.get('acct_1').name, 'second');
});

test('the monotonic guard is per record, not global', async () => {
  const db = fakeDb();
  const c = clock(1000);
  const records = createLocalRecords({ db, now: c.now });

  await records.put('account', 'acct_1', { name: 'a' });
  await records.put('account', 'acct_1', { name: 'a2' });
  await records.put('account', 'acct_2', { name: 'b' });

  assert.equal(db.rows.get('acct_1').clientTs, 1001);
  // A record this device is writing for the first time takes the clock as-is.
  assert.equal(db.rows.get('acct_2').clientTs, 1000);
});

test('a clock that moves forward normally is used as-is', async () => {
  const db = fakeDb();
  const c = clock(1000);
  const records = createLocalRecords({ db, now: c.now });

  await records.put('account', 'acct_1', { name: 'a' });
  c.set(2000);
  await records.put('account', 'acct_1', { name: 'b' });

  assert.equal(db.rows.get('acct_1').clientTs, 2000);
});

test('rejects a write with no identity rather than storing a keyless row', async () => {
  const db = fakeDb();
  const records = createLocalRecords({ db, now: clock(1).now });

  await assert.rejects(() => records.put('', 'acct_1', {}), TypeError);
  await assert.rejects(() => records.put('account', '', {}), TypeError);
  await assert.rejects(() => records.put('account', undefined, {}), TypeError);
  await assert.rejects(() => records.del('account', ''), TypeError);
  assert.equal(db.rows.size, 0);
});

test('defaults to the wall clock when no clock is injected', async () => {
  const db = fakeDb();
  const records = createLocalRecords({ db });
  const before = Date.now();
  await records.put('account', 'acct_1', { name: 'a' });
  const after = Date.now();

  const { clientTs } = db.rows.get('acct_1');
  assert.ok(clientTs >= before && clientTs <= after, `${clientTs} within [${before}, ${after}]`);
});
