// The encrypted state blob protocol of ARCHITECTURE.md §6: one opaque blob per
// account, compare-and-swap versioned, merged client-side on 409.
//
// This file deliberately knows nothing about Dexie. It is handed a record set
// and hands back the remote one; vault-records.js owns the mirror. That seam is
// what lets mergeRecords — the one place in this app where a portfolio can
// silently lose a trade — be tested as a pure function against fixtures, with
// no server and no database.
//
// Wire contract, already pinned by crypto.js and web/static/js/core/tests/
// vectors.json, NOT re-decided here:
//
//   PUT body `version` .... the version the client LAST READ (the CAS token)
//   AAD      `version` .... the version the blob WILL BE STORED AS, last-read+1
//
// The two differ by one and that is not an off-by-one: encryptState binds the
// stored version, so a server cannot re-label an old blob as a newer one.

import {
  encryptState,
  decryptState,
  gzip,
  gunzip,
  isGzip,
  utf8,
  toBase64,
  fromBase64,
} from './crypto.js';

const STATE_PATH = '/api/state';

// A bare fetch() hangs forever on a half-open connection — a captive portal, a
// dozing phone, a proxy that accepted the SYN and died. That is not the clean
// "airplane mode" failure people test with, and an upload that never settles
// blocks every later flush behind it.
const DEFAULT_TIMEOUT_MS = 20_000;

// §6: bounded, then a real surfaced error. Never an unbounded retry.
export const MAX_MERGE_ATTEMPTS = 5;

// §3: past this the device's clock is wrong enough that the user should be told.
export const CLOCK_WARN_MS = 2 * 60 * 1000;

// One error shape for everything this module can fail with. `code` is what the
// UI branches on; `retriable` is what stops a permanently-doomed upload from
// being re-attempted on every write forever (the sibling project shipped
// exactly that, re-POSTing a batch that could never succeed, once per open,
// silently, for months).
export function syncError(code, message, { retriable = false, cause } = {}) {
  const err = new Error(message);
  err.code = code;
  err.retriable = retriable;
  if (cause !== undefined) err.cause = cause;
  return err;
}

// Stable serialization used only as a merge tiebreaker, so it must be
// key-order independent: two devices that built the same record by different
// code paths hold the same fields in different insertion order.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// Does `a` beat `b` for the same recordId?
//
// Higher clientTs wins — a tombstone is an ordinary record and wins or loses on
// clientTs like any other (§6), which is why `deleted` is not consulted here.
//
// The tie is not a formality. Without a DETERMINISTIC tiebreak, each device
// keeps its own side of a tie, so a merge that changes nothing locally never
// schedules a push, and the two devices sit on permanently different data with
// nothing to detect it. Comparing canonical forms picks the same winner on both
// sides for free; the choice is arbitrary, its determinism is not.
function beats(a, b) {
  if (a.clientTs !== b.clientTs) return a.clientTs > b.clientTs;
  return canonical(a) > canonical(b);
}

// The heart of §6. Union by recordId, each collision resolved by higher
// clientTs. Commutative: merge(a, b) and merge(b, a) produce the same set, so
// two devices converge without either being the authority.
//
// Returned entries are the SAME OBJECTS that came in, which lets a caller tell
// which side won by identity alone — vault-records.js uses that to write back
// only the rows that actually changed.
export function mergeRecords(local, remote) {
  const byId = new Map();
  for (const record of local) byId.set(record.recordId, record);
  for (const record of remote) {
    const mine = byId.get(record.recordId);
    if (!mine || beats(record, mine)) byId.set(record.recordId, record);
  }
  return [...byId.values()];
}

// gzip BEFORE encrypt (§6), ~10x smaller body. `version` here is the version
// the blob will be STORED as.
export async function sealState({ kData, accountId, version, records }) {
  const plaintext = await gzip(utf8(JSON.stringify(records)));
  const { nonce, ct } = await encryptState({ kData, accountId, version, plaintext });
  return { nonce: toBase64(nonce), ct: toBase64(ct) };
}

// Inverse of sealState. `version` is the version the server says the blob is
// stored as; a mismatch fails the AEAD rather than returning wrong records.
export async function openState({ kData, accountId, version, nonce, ct }) {
  const plaintext = await decryptState({
    kData,
    accountId,
    version,
    nonce: fromBase64(nonce),
    ct: fromBase64(ct),
  });
  // isGzip sniffs the magic, so an uncompressed blob (an older or hand-made
  // one) still reads — no wire field spent on it.
  const json = isGzip(plaintext) ? await gunzip(plaintext) : plaintext;
  const records = JSON.parse(new TextDecoder().decode(json));
  if (!Array.isArray(records)) {
    throw syncError('corrupt', 'sync: state blob did not decode to an array of records');
  }
  return records;
}

const META_DB = 'myportfolio-sync';
const META_STORE = 'meta';
const META_KEY = 'state';

// Sync metadata is DEVICE-LOCAL — the clock offset and the versions this device
// has seen mean nothing on another device and must never enter the blob. So it
// lives in its own tiny database rather than in the Dexie records store, the
// same reasoning ldk.js used for the device key.
//
// ONE record, not one per account, and that is deliberate: it shadows the
// records mirror, which is also one per origin. Keying it by account id would
// let a second account start with clean versions on top of the first account's
// records — trading a loud stop for a silent cross-vault upload. See ready().
//
// Opened per operation and closed again: there are two of these per sync, and a
// handle held open across a session is a handle that blocks account deletion
// and schema upgrades. The versionchange handler covers the window where one is
// genuinely open.
function withMetaDb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(META_STORE)) req.result.createObjectStore(META_STORE);
    };
    req.onerror = () => reject(req.error);
    // A tab on an older version blocks the upgrade forever; without this the
    // promise never settles and sync silently never runs again.
    req.onblocked = () => reject(new Error('sync: another tab is holding an older version of the sync database open'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      const tx = db.transaction(META_STORE, mode);
      const request = fn(tx.objectStore(META_STORE));
      // Resolve on COMMIT, not on request success: a request can succeed into a
      // transaction that then aborts on quota, and "the version is persisted"
      // must not resolve in that case — it is what rollback detection rests on.
      tx.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

export function createIdbMeta() {
  return {
    get: () => withMetaDb('readonly', (store) => store.get(META_KEY)),
    set: (value) => withMetaDb('readwrite', (store) => store.put(value, META_KEY)),
  };
}

const EMPTY_META = {
  // Which vault this device's mirror belongs to. See ready() — this is the
  // guard, not a label.
  accountId: null,
  // The version this device last read, i.e. the CAS token for the next PUT.
  lastVersion: 0,
  // The highest version this device has EVER seen. Only ever moves up: a server
  // answering with less than this served stale state (§6) and is refused.
  highestVersion: 0,
  // §3 guard 1: how far ahead of the server this device's clock runs.
  clockSkewMs: 0,
};

// The sync engine. Owns the wire, the CAS loop and the metadata; owns no
// storage of records.
//
//   pull()                    -> {version, records} | null   (null: no blob yet)
//   push(records, onConflict) -> the record set actually uploaded
//
// `onConflict(remoteRecords)` is called on every 409 and must return the full
// record set to retry with — that is the caller's chance to merge the remote
// side into its mirror before the next attempt.
export function createStateSync({
  kData,
  accountId,
  meta = createIdbMeta(),
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}) {
  let state = null;

  // Loads the device-local metadata, and refuses to run against a mirror that
  // belongs to a different vault.
  //
  // The records mirror (localdb.js) is ONE un-scoped Dexie database per origin
  // — it has no account id in it anywhere. So unlocking a second account in the
  // same browser lands on the first account's records, and the first sync would
  // merge one user's portfolio into the other user's vault and upload it. The
  // versions would be wrong too, which is the visible half of the same bug.
  //
  // Refusing here is the half this file can honestly fix: it turns a silent
  // cross-vault upload into a loud, actionable stop.
  //
  // ponytail: the real fix is for the mirror to be cleared (or namespaced) when
  // the unlocked account changes, which belongs to localdb.js and the boot
  // path, not here. Until then, one account per browser profile.
  async function ready() {
    if (state) return state;
    const stored = await meta.get();
    if (stored && stored.accountId && stored.accountId !== accountId) {
      throw syncError(
        'wrong-account',
        `sync: this device already holds data for vault ${stored.accountId}. ` +
          'Refusing to sync it into a different vault — clear this browser\'s site data first.'
      );
    }
    state = { ...EMPTY_META, ...(stored || {}), accountId };
    return state;
  }

  async function persist(patch) {
    Object.assign(state, patch);
    await meta.set({ ...state });
  }

  // §3 guard 1: every sync response carries a Date header; the offset between
  // it and this device's clock is subtracted from every write timestamp, so all
  // devices stamp on one scale. The header has one-second granularity and the
  // round trip adds more, so this is only ever good to a second or two — which
  // is why the per-record monotonic guard in records.js exists as well.
  function noteServerTime(res) {
    const header = res.headers.get('Date');
    if (!header) return null;
    const serverMs = Date.parse(header);
    if (!Number.isFinite(serverMs)) return null;
    return now() - serverMs;
  }

  async function request(method, body) {
    let res;
    try {
      res = await fetchImpl(STATE_PATH, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // Offline, DNS, TLS, or the timeout above. All retriable: nothing was
      // dropped, the records are still in the mirror.
      throw syncError('network', `sync: ${method} ${STATE_PATH} did not complete (${cause.message || cause})`, {
        retriable: true,
        cause,
      });
    }
    const skew = noteServerTime(res);
    if (skew !== null && skew !== state.clockSkewMs) await persist({ clockSkewMs: skew });
    if (res.status === 401) {
      // NOT the same as being offline: the session expired, the user has to run
      // the passkey ceremony again. Pending writes stay pending either way, but
      // retrying on a timer would just burn requests until they do.
      throw syncError('auth', 'sync: the vault session expired — unlock with your passkey to keep syncing');
    }
    return res;
  }

  function rollback(seen, highest) {
    return syncError(
      'rollback',
      `sync: the server returned state version ${seen} after this device had already seen ${highest}. ` +
        'Refusing to apply it — this would silently undo changes.'
    );
  }

  function serverError(res) {
    if (res.status === 413) {
      return syncError('quota', 'sync: this vault has exceeded the server storage quota');
    }
    // 5xx is worth retrying; a 4xx we did not name is a client bug and retrying
    // it forever is the failure mode this whole file is written against.
    return syncError('server', `sync: ${STATE_PATH} answered ${res.status}`, { retriable: res.status >= 500 });
  }

  async function pull() {
    await ready();
    const res = await request('GET');
    if (res.status === 204) {
      // No blob at all. If this device has seen one, the server lost or rolled
      // back the account — applying "nothing" here would wipe the mirror on the
      // next merge.
      if (state.highestVersion > 0) throw rollback(0, state.highestVersion);
      await persist({ lastVersion: 0 });
      return null;
    }
    if (!res.ok) throw serverError(res);
    const blob = await res.json();
    if (blob.version < state.highestVersion) throw rollback(blob.version, state.highestVersion);
    const records = await openState({ kData, accountId, version: blob.version, nonce: blob.nonce, ct: blob.ct });
    await persist({ lastVersion: blob.version, highestVersion: Math.max(state.highestVersion, blob.version) });
    return { version: blob.version, records };
  }

  async function push(records, onConflict) {
    await ready();
    let current = records;
    for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
      // CAS makes this deterministic: if the PUT is accepted at last-read, the
      // blob is stored as last-read + 1, so that is what the AAD binds.
      const storedAs = state.lastVersion + 1;
      const blob = await sealState({ kData, accountId, version: storedAs, records: current });
      const res = await request('PUT', { version: state.lastVersion, ...blob });

      if (res.status === 204) {
        await persist({ lastVersion: storedAs, highestVersion: Math.max(state.highestVersion, storedAs) });
        return current;
      }
      if (res.status !== 409) throw serverError(res);

      const conflict = await res.json();
      let remote = [];
      if (conflict.ct) {
        if (conflict.version < state.highestVersion) throw rollback(conflict.version, state.highestVersion);
        remote = await openState({
          kData,
          accountId,
          version: conflict.version,
          nonce: conflict.nonce,
          ct: conflict.ct,
        });
        await persist({
          lastVersion: conflict.version,
          highestVersion: Math.max(state.highestVersion, conflict.version),
        });
      } else {
        // 409 with no blob: we claimed a version for state that does not exist.
        // Either this account was reset, or we are talking to the wrong one.
        if (state.highestVersion > 0) throw rollback(0, state.highestVersion);
        await persist({ lastVersion: 0 });
      }
      current = await onConflict(remote);
    }
    // Five losing races in a row is not contention, it is a wedge. Surface it —
    // the records are still in the mirror, nothing was dropped.
    throw syncError(
      'conflict',
      `sync: gave up after ${MAX_MERGE_ATTEMPTS} merge attempts — another device is writing continuously, or the vault is wedged`,
      { retriable: true }
    );
  }

  return {
    ready,
    pull,
    push,
    clockSkewMs: () => (state ? state.clockSkewMs : 0),
    lastVersion: () => (state ? state.lastVersion : 0),
  };
}
