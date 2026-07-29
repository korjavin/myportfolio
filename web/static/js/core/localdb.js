// Every IndexedDB database this app's records live in, and the only file that
// names one. ARCHITECTURE.md §3: localRecords (here) and Track A's vaultRecords
// back onto the same mirror, so the database name, version and schema live in
// exactly one place and adding a store can never collide with another module
// opening an older version.
//
// THE MIRROR IS NAMED PER ACCOUNT (bd myportfolio-18h.12). It used to be one
// un-scoped database per origin with no account id in it anywhere, so unlocking
// a second account in the same browser profile landed straight on the first
// account's records and the next sync merged one user's portfolio into the
// other user's vault. state-sync.js still refuses a mirror stamped with another
// account and that guard stays as a backstop, but with a database per account it
// is unreachable in normal use: each account reads and writes its own.

// Dexie ships as UMD, so it has no ES export to bind. Imported for side effect:
// with `exports`, `module` and `define` all undefined under an ES module — and
// `this` undefined too — the wrapper falls through to assigning globalThis.Dexie.
// ESM guarantees this import is fully evaluated before the body below runs.
import '../../vendor/dexie.min.js';

import { createLocalRecords } from './records.js';
// Only for reading the PRE-UPGRADE shared sync record, which decides whether the
// un-namespaced mirror is pre-signup data or somebody's portfolio. See mayClaim.
import { createIdbMeta } from './state-sync.js';

const Dexie = globalThis.Dexie;

// Swapping the vendored file for an ESM build of Dexie would leave the global
// unset and fail later as a confusing "Dexie is not a constructor"; say what
// actually went wrong instead.
if (typeof Dexie !== 'function') {
  throw new TypeError('vendor/dexie.min.js did not define globalThis.Dexie — expected the UMD build');
}

// The pre-signup mirror: where a user who has never had an account keeps their
// portfolio. It is not "account nobody" — it is the drafts of whoever is sitting
// at this browser, and openMirror() MOVES it into the first account that claims
// this device (see claim()).
const PRE_SIGNUP_DB = 'myportfolio';
const MIRROR_PREFIX = 'myportfolio_';
const META_PREFIX = 'myportfolio-sync';

// v1. `recordType` is indexed: without it every list(recordType) is a full-store
// getAll() + JS filter that structured-clones every record of every type
// (medtracker shipped exactly that and had to add the index).
//
// `deleted` is deliberately NOT indexed. IndexedDB cannot index boolean values
// and §3 fixes the field as a boolean, so list() filters tombstones in JS — but
// it does so over the recordType index, and therefore only ever clones the rows
// of the one type asked for.
const SCHEMA = { records: 'recordId, recordType' };

function openRecordsDb(name) {
  const handle = new Dexie(name);
  handle.version(1).stores(SCHEMA);
  return handle;
}

export const db = openRecordsDb(PRE_SIGNUP_DB);

// The offline-only implementation of the §3 port: plaintext Dexie, no server, no
// crypto. A user who never signs up runs this and has a complete, working app.
export const localRecords = createLocalRecords({ db });

/** The mirror an account's records live in. One database per account, per origin. */
export function mirrorName(accountId) {
  return `${MIRROR_PREFIX}${accountId}`;
}

/**
 * Move the pre-signup rows into the account's mirror.
 *
 * This is the signup migration and it is the single most important thing in this
 * file: "my data vanished when I signed up" is unrecoverable. Rows are COPIED
 * FIRST and only then dropped from the source, so a failure anywhere leaves them
 * readable in at least one place and the next open retries. Re-running it is
 * harmless — a row already in the destination with an equal or higher clientTs
 * is left alone, which is the same rule §6 merges by.
 *
 * It is a MOVE, not a copy, and that is the isolation half: rows typed with no
 * vault open belong to whoever claims this device, and leaving them behind would
 * hand them to the *next* account as well.
 *
 * Takes the two handles as arguments (Dexie-shaped, not Dexie-specific) so the
 * migration is tested under `node --test` rather than by signing up and hoping.
 */
export async function claim(from, to) {
  const pending = await from.records.toArray();
  if (pending.length === 0) return 0;
  const mine = new Map((await to.records.toArray()).map((r) => [r.recordId, r]));
  const incoming = pending.filter((r) => !(mine.get(r.recordId)?.clientTs >= r.clientTs));
  if (incoming.length > 0) await to.records.bulkPut(incoming);
  await from.records.clear();
  return incoming.length;
}

/**
 * May `accountId` claim the un-namespaced mirror as its own pre-signup rows?
 *
 * Only if nobody else already has. On a device upgrading from the build before
 * this one, `myportfolio` is NOT necessarily pre-signup data — it may be a
 * signed-in account's shared mirror, and the shared `myportfolio-sync` record
 * (state-sync.js) is stamped with whose. Claiming it for whoever unlocks first
 * after the upgrade would move one user's whole portfolio into another user's
 * namespace and, with the per-account metadata starting clean, upload it — the
 * exact cross-vault leak this file exists to close, reintroduced by its own
 * migration.
 *
 * Unstamped means genuinely pre-signup: nothing has ever claimed this device.
 *
 * The refusal is silent and conservative. The other account's rows stay where
 * they are and move into ITS namespace the next time it unlocks here; nobody
 * loses anything, and the wrong account never sees them.
 */
export function mayClaim(stamp, accountId) {
  return !stamp || !stamp.accountId || stamp.accountId === accountId;
}

/**
 * The mirror for `accountId`, with any pre-signup rows migrated into it.
 *
 * SWITCHING ACCOUNTS RETAINS, IT DOES NOT WIPE — decided here, because both
 * answers are surprising if unstated:
 *
 *   Account A's mirror stays on disk under its own database name when B unlocks.
 *   Neither account can read the other's through the app; a switch back to A is
 *   instant instead of re-downloading the whole vault, and — the half that
 *   actually matters — a device holding writes A has not synced yet does not
 *   destroy them because somebody logged in as B. Wiping on switch would make
 *   account switching a data-loss operation for any offline write.
 *
 *   The cost is honest and stated: A's plaintext mirror is still on this disk
 *   after the switch. Removing it is "clear this site's data" or the account
 *   deletion path (deleteAllMirrors below) — not a side effect of logging in as
 *   somebody else.
 */
export async function openMirror(accountId, from = db, { legacyMeta = createIdbMeta() } = {}) {
  if (!accountId) return from;
  const mirror = openRecordsDb(mirrorName(accountId));
  await mirror.open();
  // state-sync.js's own accessor rather than the database name written out a
  // second time: this reads the pre-upgrade shared record, and there must be
  // exactly one place that knows where it is. A device that cannot read it is
  // treated as stamped by nobody-knows-who — the safe direction is to leave the
  // rows alone, not to hand them over.
  const stamp = await legacyMeta.get().catch(() => ({ accountId: 'unreadable' }));
  if (mayClaim(stamp, accountId)) await claim(from, mirror);
  return mirror;
}

/**
 * The device-local sync metadata for one account (state-sync.js's `meta` port):
 * the clock offset and the versions this device has seen.
 *
 * Per account for the same reason the mirror is. state-sync.js's own
 * createIdbMeta keeps ONE record for the whole origin, which was right while the
 * mirror was shared — a second account starting with clean versions on top of
 * the first account's rows is exactly the silent cross-vault upload its
 * wrong-account guard exists to stop. With a mirror per account the versions
 * have to follow it, or account B compare-and-swaps against A's version numbers.
 *
 * Its own tiny database, not a table in the mirror: §3 pins that sync metadata
 * stays out of the records store. An existing single-account device has a record
 * under the old shared name; it is not read across, and the cost of that is one
 * 409 on the next push, which the CAS loop already handles. Nothing is lost.
 *
 * set() resolves on COMMIT, not on request success — a request can succeed into
 * a transaction that then aborts on quota, and rollback detection rests on
 * "the version is persisted" being true when this resolves.
 */
export function openSyncMeta(accountId) {
  const meta = new Dexie(`${META_PREFIX}_${accountId}`);
  // Outbound keys: one record, supplied key, no schema to keep in step.
  meta.version(1).stores({ meta: '' });
  const KEY = 'state';
  // .table(), not meta.meta: a store name that shadows a Dexie member would
  // fail as something unrelated, and this one only ever runs in a browser.
  const store = () => meta.table('meta');
  return {
    get: () => store().get(KEY),
    set: (value) => meta.transaction('rw', store(), () => store().put(value, KEY)),
  };
}

function drop(idb, name) {
  return new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(name);
    req.onsuccess = () => resolve(name);
    req.onerror = () => reject(req.error);
    // Another tab still holding a handle. Every open in this app closes on
    // `versionchange` (Dexie does it by default, ldk.js and state-sync.js do it
    // by hand), so this means a window this code cannot reach — and a deletion
    // that reports success while the data is still there is the one answer an
    // account-deletion flow must never get.
    req.onblocked = () => reject(new Error(`localdb: another tab is holding ${name} open`));
  });
}

/**
 * Erase every records mirror on this device and every account's sync metadata —
 * the pre-signup one, the active account's, and any other account that has ever
 * been unlocked in this browser profile.
 *
 * Account deletion has to clear ALL of them. Clearing only the active namespace
 * would be the same bug this file just fixed, wearing a different hat: the rows
 * are still on disk, under a name nothing in the UI mentions.
 *
 * Does NOT touch myportfolio-device (the LDK cache) — that is ldk.js's, and
 * clearLdkCache() is its erase.
 *
 * `indexedDB.databases()` is how the other namespaces are found; where it is
 * missing the known ones are still removed, so the active account is always
 * cleared even on a browser that will not enumerate.
 */
export async function deleteAllMirrors({ idb = globalThis.indexedDB, accountId = null } = {}) {
  const found = typeof idb.databases === 'function' ? await idb.databases() : [];
  const names = new Set([PRE_SIGNUP_DB, ...(accountId ? [mirrorName(accountId), `${META_PREFIX}_${accountId}`] : [])]);
  for (const { name } of found) {
    if (name === PRE_SIGNUP_DB || name.startsWith(MIRROR_PREFIX) || name.startsWith(META_PREFIX)) names.add(name);
  }
  // Sequential: a Dexie handle closes when the delete fires `versionchange`, and
  // a parallel storm of deletes on one origin is how `blocked` gets hit for no
  // reason.
  const deleted = [];
  for (const name of names) deleted.push(await drop(idb, name));
  return deleted;
}
