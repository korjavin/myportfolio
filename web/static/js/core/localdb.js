// The single per-device Dexie handle. ARCHITECTURE.md §3: localRecords (here)
// and Track A's vaultRecords back onto this same mirror, so the database name,
// version and schema live in exactly one file and adding a store can never
// collide with another module opening an older version.

// Dexie ships as UMD. Imported for side effect: under an ES module the wrapper's
// `this` is undefined, so it falls through to assigning globalThis.Dexie.
import '../../vendor/dexie.min.js';

import { createLocalRecords } from './records.js';

const Dexie = globalThis.Dexie;

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
