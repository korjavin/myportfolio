// localRecords — the records port of ARCHITECTURE.md §3, backed by Dexie.
//
//   records.list(recordType)               -> Promise<Record[]>  (excludes tombstones)
//   records.put(recordType, recordId, body) -> Promise<void>
//   records.del(recordType, recordId)       -> Promise<void>     (writes a tombstone)
//
// This file holds no Dexie import: it takes the opened database as a port, which
// is what lets the clientTs / tombstone / field-ownership rules be tested under
// `node --test` with an in-memory double. localdb.js supplies the real Dexie
// instance; Track A's vaultRecords implements the same three methods over the
// same mirror plus state-blob sync (§6).

const STORE = 'records';

// createLocalRecords builds the port over:
//   db    — Dexie-shaped: db[STORE] table (get/put/where) and db.transaction()
//   now() — current time in ms. Injectable on purpose: §3's clock-skew
//           correction (sync_meta.clockSkewMs) is applied by passing a corrected
//           clock here, so swapping in the server-referenced time changes no
//           domain code and no code in this file.
export function createLocalRecords({ db, now = Date.now }) {
  const table = () => db[STORE];

  async function list(recordType) {
    // Indexed by recordType (see localdb.js). A full getAll() + JS filter would
    // structured-clone every record of every type on each list().
    const rows = await table().where('recordType').equals(recordType).toArray();
    return rows.filter((r) => r.deleted !== true);
  }

  // §3, per-record monotonic guard: a write to a record this device can already
  // see is stamped max(now, existing.clientTs + 1). Editing what you can see
  // always beats what you are overwriting, whatever either clock says — without
  // this, a device whose clock is behind silently loses every edit it makes to a
  // record it just pulled.
  function stamp(existing) {
    const t = now();
    return existing && existing.clientTs >= t ? existing.clientTs + 1 : t;
  }

  function write(recordType, recordId, record) {
    if (!recordType) throw new TypeError('records: recordType is required');
    if (!recordId) throw new TypeError('records: recordId is required');
    // Read-then-write under one transaction, so two concurrent puts to the same
    // record can't both read the same clientTs and lose one of the updates.
    return db.transaction('rw', table(), async () => {
      const existing = await table().get(recordId);
      await table().put({ ...record, clientTs: stamp(existing) });
    });
  }

  async function put(recordType, recordId, body) {
    // Spread body first: the port owns recordId/recordType/clientTs/deleted, so a
    // body that carries them (e.g. a record read back, edited, and put again)
    // has them overwritten rather than honoured. Structural, not a convention.
    await write(recordType, recordId, { ...body, recordId, recordType, deleted: false });
  }

  async function del(recordType, recordId) {
    // A tombstone, never a hard delete: on the next merge (§6) a record missing
    // locally but present remotely comes straight back, so a hard delete
    // resurrects it. The body is dropped — tombstones are retained indefinitely
    // and only need identity plus a clientTs to win or lose the merge.
    await write(recordType, recordId, { recordId, recordType, deleted: true });
  }

  return { list, put, del };
}
