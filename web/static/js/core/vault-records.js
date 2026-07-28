// vaultRecords — the second implementation of the ARCHITECTURE.md §3 records
// port: the same Dexie mirror localRecords writes to, plus encrypted state-blob
// sync (§6).
//
//   records.list(recordType)                -> Promise<Record[]>  (no tombstones)
//   records.put(recordType, recordId, body)  -> Promise<void>
//   records.del(recordType, recordId)        -> Promise<void>      (tombstone)
//
// Nothing in web/domain/ can tell the difference, and that is the entire point
// of the seam. Signing up swaps this in underneath a running app; the rows are
// already in the right store, so "migrating existing local rows into the vault"
// is just the first sync() — the union of local and remote is what gets
// uploaded, so an offline-built portfolio survives signing up.
//
// The list/put/del bodies themselves are NOT reimplemented here. localRecords
// already implements the contract, including both halves of §3's clientTs
// discipline, and it takes its clock as a port precisely so this file can hand
// it a server-corrected one. A second copy of the tombstone and
// field-ownership rules is a second place for them to drift.

import { createLocalRecords } from './records.js';
import { deriveKData } from './crypto.js';
import { createStateSync, mergeRecords, canonical, createIdbMeta, CLOCK_WARN_MS } from './state-sync.js';

const STORE = 'records';

// "A few seconds" (§6). Long enough that typing a transaction form is one
// upload rather than eight, short enough that closing the tab afterwards does
// not lose the last edit.
const DEFAULT_DEBOUNCE_MS = 3000;

// createVaultRecords wires the port over:
//   db        — the Dexie handle from localdb.js (the SAME mirror localRecords uses)
//   dek       — the vault key from unlock.js / signup.js
//   accountId — bound into the blob's AAD, so a blob cannot be replayed at another account
//   onStatus  — called on every state change. This is the surface that stops a
//               wedged sync from being silent; a UI that ignores it will lose
//               the property, not the data.
export async function createVaultRecords({
  db,
  dek,
  accountId,
  meta = createIdbMeta(),
  fetch: fetchImpl,
  timeoutMs,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  now = Date.now,
  onStatus = () => {},
}) {
  const kData = await deriveKData(dek);
  const sync = createStateSync({ kData, accountId, meta, fetch: fetchImpl, timeoutMs, now });
  // Load the persisted clock offset before the first write can be stamped:
  // otherwise the first edit after every launch is stamped on the uncorrected
  // clock.
  await sync.ready();

  const table = () => db[STORE];

  // §3 guard 1. localRecords applies guard 2 (per-record monotonic) on top of
  // whatever clock it is given, so both guards are live with no code here.
  const local = createLocalRecords({ db, now: () => now() - sync.clockSkewMs() });

  const status = {
    // A write is waiting to reach the server. Never cleared by an error.
    pending: false,
    syncing: false,
    // The last failure, still unresolved. Cleared only by a successful sync.
    lastError: null,
    // Sync cannot make progress by retrying (quota, rollback, a 4xx bug). The
    // data is safe in the mirror, but a human has to look.
    wedged: false,
    // The session expired. Not offline — re-run the passkey ceremony.
    needsAuth: false,
    clockSkewMs: 0,
    clockWarning: false,
    version: 0,
  };

  function emit(patch) {
    Object.assign(status, patch, {
      clockSkewMs: sync.clockSkewMs(),
      clockWarning: Math.abs(sync.clockSkewMs()) > CLOCK_WARN_MS,
      version: sync.lastVersion(),
    });
    onStatus({ ...status });
  }

  let dirty = false;
  let timer = null;
  let queue = Promise.resolve();

  function schedule() {
    dirty = true;
    emit({ pending: true });
    // Coalescing: one timer, restarted by nothing. A burst of writes rides the
    // first one, so a form that writes eight records uploads once.
    if (timer !== null || status.wedged) return;
    timer = setTimeout(() => {
      timer = null;
      // The rejection is already carried in status.lastError; an unhandled
      // rejection from a timer is noise on top of a surfaced error.
      flush().catch(() => {});
    }, debounceMs);
  }

  // Applies a decrypted remote record set to the mirror and reports whether
  // this device holds anything the remote does not.
  //
  // Read, merge and write-back happen in ONE transaction, so a concurrent
  // put() cannot land between the read and the write and be overwritten by a
  // stale merge result. The decryption deliberately happened before this call:
  // awaiting anything non-Dexie inside a Dexie transaction commits it early.
  async function applyRemote(remote) {
    return db.transaction('rw', table(), async () => {
      const localRows = await table().toArray();
      if (remote.length === 0) return { merged: localRows, ahead: localRows.length > 0 };

      const merged = mergeRecords(localRows, remote);
      // mergeRecords returns the winning OBJECTS, so identity says which side
      // won and only the rows that actually changed get written back.
      const mine = new Set(localRows);
      const incoming = merged.filter((r) => !mine.has(r));
      if (incoming.length > 0) await table().bulkPut(incoming);

      // `ahead` decides whether to push, so it has to be a CONTENT comparison,
      // not identity: in the steady state every record ties on clientTs and the
      // local object wins by being there first, which would otherwise look like
      // a change and re-upload the whole blob on every focus. The canonical
      // compare only runs where the remote did not already win outright.
      const theirs = new Map(remote.map((r) => [r.recordId, r]));
      const ahead = merged.some((r) => {
        const t = theirs.get(r.recordId);
        return !t || (t !== r && canonical(t) !== canonical(r));
      });
      return { merged, ahead };
    });
  }

  async function upload() {
    // Cleared BEFORE the read, so a write that lands during the upload marks
    // the mirror dirty again and gets its own flush rather than being silently
    // included-or-not depending on timing.
    dirty = false;
    // Every row, tombstones included: they are retained indefinitely (§6), and
    // dropping one resurrects a deleted transaction on a device that was
    // offline across the GC.
    const rows = await table().toArray();
    await sync.push(rows, async (remote) => (await applyRemote(remote)).merged);
  }

  function failed(err) {
    // The write is NOT dropped. It stays in the mirror and stays pending; the
    // next trigger picks it up. What must never happen is this failing quietly.
    dirty = true;
    emit({
      syncing: false,
      pending: true,
      lastError: err,
      wedged: !err.retriable,
      needsAuth: err.code === 'auth',
    });
  }

  async function attempt(work) {
    emit({ syncing: true });
    try {
      await work();
      emit({ syncing: false, pending: dirty, lastError: null, wedged: false, needsAuth: false });
    } catch (err) {
      failed(err);
      throw err;
    }
  }

  // Sync operations run one at a time, in the order they were asked for.
  //
  // Returning early while an upload is in flight is NOT good enough: the
  // debounced flush and an on-focus pull would then race into the same
  // compare-and-swap version, and — worse — a caller that awaited flush() would
  // be told the write had gone when it was still in the air. Queueing costs a
  // few lines and removes a whole class of "it works on my machine".
  function serialize(work) {
    const next = queue.then(() => attempt(work));
    // A failed operation must not poison the queue for the next one; the caller
    // still gets the rejection through `next`.
    queue = next.catch(() => {});
    return next;
  }

  // Uploads the mirror if anything is waiting. Rejects — loudly — on failure.
  async function flush() {
    return serialize(async () => {
      // A write that lands mid-upload sets dirty again; loop rather than wait
      // for the next trigger, so the last edit before a tab closes still goes.
      while (dirty) await upload();
    });
  }

  // Pull, merge, then push if this device holds anything the server does not.
  // This is the "on open and on focus" entry point (§6) and it is also the
  // signup migration: the first call unions an offline-built portfolio into the
  // vault. Wiring it to window focus belongs to the shell, not here.
  async function syncNow() {
    return serialize(async () => {
      const remote = await sync.pull();
      const { ahead } = await applyRemote(remote ? remote.records : []);
      if (ahead) dirty = true;
      while (dirty) await upload();
    });
  }

  return {
    // The §3 port. Domain code sees these three and nothing else.
    list: local.list,
    async put(recordType, recordId, body) {
      await local.put(recordType, recordId, body);
      schedule();
    },
    async del(recordType, recordId) {
      await local.del(recordType, recordId);
      schedule();
    },

    // The shell's half.
    sync: syncNow,
    flush,
    status: () => ({ ...status }),
  };
}
