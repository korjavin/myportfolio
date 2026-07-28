// The single per-device Dexie handle. ARCHITECTURE.md §3: localRecords (here)
// and Track A's vaultRecords back onto this same mirror, so the database name,
// version and schema live in exactly one file and adding a store can never
// collide with another module opening an older version.

// Dexie ships as UMD, so it has no ES export to bind. Imported for side effect:
// with `exports`, `module` and `define` all undefined under an ES module — and
// `this` undefined too — the wrapper falls through to assigning globalThis.Dexie.
// ESM guarantees this import is fully evaluated before the body below runs.
import '../../vendor/dexie.min.js';

import { createLocalRecords } from './records.js';

const Dexie = globalThis.Dexie;

// Swapping the vendored file for an ESM build of Dexie would leave the global
// unset and fail later as a confusing "Dexie is not a constructor"; say what
// actually went wrong instead.
if (typeof Dexie !== 'function') {
  throw new TypeError('vendor/dexie.min.js did not define globalThis.Dexie — expected the UMD build');
}

export const db = new Dexie('myportfolio');

// v1. `recordType` is indexed: without it every list(recordType) is a full-store
// getAll() + JS filter that structured-clones every record of every type
// (medtracker shipped exactly that and had to add the index).
//
// `deleted` is deliberately NOT indexed. IndexedDB cannot index boolean values
// and §3 fixes the field as a boolean, so list() filters tombstones in JS — but
// it does so over the recordType index, and therefore only ever clones the rows
// of the one type asked for.
db.version(1).stores({ records: 'recordId, recordType' });

// The offline-only implementation of the §3 port: plaintext Dexie, no server, no
// crypto. A user who never signs up runs this and has a complete, working app.
export const localRecords = createLocalRecords({ db });
