// Doubles shared by state-sync.test.mjs and vault-records.test.mjs.
//
// Not a test file (no `.test.` in the name, so `node --test` does not run it).
// It exists so the two suites simulate the SAME server: the interesting bugs in
// §6 are two-device bugs, and two devices talking to two different fakes proves
// nothing.

// The slice of Dexie that records.js and vault-records.js actually use, in
// memory. Same shape as the double in records.test.js plus toArray/bulkPut.
export function fakeDb() {
  const rows = new Map();
  const table = {
    async get(recordId) { return rows.get(recordId); },
    async put(record) { rows.set(record.recordId, { ...record }); },
    async bulkPut(records) { for (const r of records) rows.set(r.recordId, { ...r }); },
    async toArray() { return [...rows.values()].map((r) => ({ ...r })); },
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

function response(status, body, serverNowMs) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      // Real HTTP dates carry whole seconds only — the sub-second truncation is
      // part of what makes clock-skew correction approximate.
      get: (name) => (name.toLowerCase() === 'date' ? new Date(serverNowMs).toUTCString() : null),
    },
    async json() { return body; },
  };
}

// An in-memory /api/state with the real compare-and-swap semantics of
// internal/server/state.go: PUT carries the version the caller LAST READ, a
// match stores last-read + 1, a mismatch answers 409 with the current blob.
export function fakeServer({ serverNow = () => Date.now() } = {}) {
  const server = {
    blob: null,
    requests: [],
    // Set to a status code (or 'hang') to make the next N requests fail.
    failWith: null,
    failCount: 0,
    serverNow,
  };

  server.fetch = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    server.requests.push({ path, method: init.method, body });

    if (server.failWith !== null && server.failCount !== 0) {
      if (server.failCount > 0) server.failCount -= 1;
      // A half-open connection: nothing ever arrives, and only the abort signal
      // ends it — which is the whole reason every fetch carries a timeout.
      if (server.failWith === 'hang') {
        return new Promise((_resolve, reject) => {
          // A real half-open socket keeps the event loop alive. The fake has to
          // as well, or the runner declares the loop empty and cancels the test
          // before AbortSignal.timeout (which is unref'd in Node) can fire.
          const keepAlive = setTimeout(() => {}, 60_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason ?? new Error('aborted'));
          });
        });
      }
      if (server.failWith === 'network') throw new Error('simulated network failure');
      return response(server.failWith, {}, server.serverNow());
    }

    if (init.method === 'GET') {
      return server.blob === null
        ? response(204, null, server.serverNow())
        : response(200, { ...server.blob }, server.serverNow());
    }

    const current = server.blob === null ? 0 : server.blob.version;
    if (body.version !== current) {
      const conflict = server.blob === null
        ? { version: 0, nonce: null, ct: null }
        : { ...server.blob };
      return response(409, conflict, server.serverNow());
    }
    server.blob = { version: current + 1, nonce: body.nonce, ct: body.ct };
    return response(204, null, server.serverNow());
  };

  return server;
}

// The device-local sync metadata store, in memory.
export function fakeMeta(initial = null) {
  let value = initial;
  return {
    async get() { return value; },
    async set(next) { value = { ...next }; },
    peek: () => value,
  };
}

// A clock we control, so skew is asserted rather than raced.
export function clock(start) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

// Lets the debounce timer fire without sleeping for it.
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for something the debounce timer will cause, without a sleep long
// enough to be a flake. gzip runs on Web Streams, so an upload spans several
// event-loop turns and "await tick()" twice is not enough on a slow machine.
export async function until(predicate, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick(1);
  }
  throw new Error('until: the condition never became true');
}
