// The LDK (local device key) cache: what makes launching the app silent.
//
// A non-extractable AES-GCM key wraps the DEK on this device, and both the key
// and the wrapped DEK are structured-cloned into IndexedDB. Non-extractable
// CryptoKeys clone directly, so the DEK never sits in storage as bytes and no
// export/import round-trip is needed.
//
// HONEST SCOPE, and this must not be overstated in user-facing copy: the
// non-extractable key is a SCRIPT-level guarantee. It stops JavaScript on this
// origin from reading the key out. It is not disk-forensics protection — an
// attacker with the device and the profile directory can drive the browser's
// key store. Locally, the vault is protected by device unlock and OS disk
// encryption, exactly like any other local database (ARCHITECTURE.md 8).
//
// This uses its OWN IndexedDB database rather than joining the Dexie handle in
// localdb.js. Two reasons: the device key is not a record and has no business
// in the records store, and adding a store to that database would mean bumping
// its version from a second module — the exact collision localdb.js's comment
// warns about.

const DB_NAME = 'myportfolio-device';
const DB_VERSION = 1;
const STORE_NAME = 'device';
const LDK_RECORD_KEY = 'ldk';
const LDK_AAD = new TextEncoder().encode('mp/v1/ldk');

function openDeviceDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // A tab holding an older version open blocks the upgrade forever; without
    // this the promise never settles and the unlock screen hangs blank.
    req.onblocked = () => reject(new Error('another tab is holding an older version of the device database open'));
  });
}

// Runs one write against the device store and resolves when the transaction
// actually COMMITS, not when the request succeeds — a request can succeed into
// a transaction that then aborts on quota, and "I saved the key" must not
// resolve in that case.
async function write(fn) {
  const db = await openDeviceDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Wraps dek under a fresh non-extractable LDK and stores both.
//
// Callers must invoke this at the moment the user actually ENTERS the app, not
// as soon as a passkey exists. Writing it earlier means a user who abandons
// signup at the Emergency Kit reloads into a fully unlocked vault with no
// recovery code — the sibling project's scar (bead A3).
export async function establishLdkCache(dek, accountId) {
  const ldk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: LDK_AAD }, ldk, dek)
  );
  await write((store) => store.put({ ldk, nonce, ct, accountId }, LDK_RECORD_KEY));
}

export function readLdkRecord() {
  return new Promise((resolve, reject) => {
    openDeviceDb().then((db) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(LDK_RECORD_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    }, reject);
  });
}

export function clearLdkCache() {
  return write((store) => store.delete(LDK_RECORD_KEY));
}

// Warm unlock in one step: returns { accountId, dek } from the cache, or null
// when there is no cache (a fresh or cleared device) so the caller can fall
// through to the passkey ceremony.
//
// A cache that exists but will not open is NOT treated as absent — it throws.
// Silently continuing there would present an empty vault as if it were the
// user's real, empty portfolio.
export async function warmUnlock() {
  const cached = await readLdkRecord();
  if (!cached) return null;
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: cached.nonce, additionalData: LDK_AAD },
    cached.ldk,
    cached.ct
  );
  return { accountId: cached.accountId, dek: new Uint8Array(pt) };
}
