// The app's single seam onto the domain (ARCHITECTURE.md §3, §10).
//
// Screens never touch Dexie and never fold a transaction log themselves: they
// read `state` and call the mutators here, which write through the records port
// and then re-derive everything from web/domain/. That is what lets Track A
// swap `localRecords` for `vaultRecords` underneath without any screen noticing.
//
// The `../../../domain/…` specifier resolves the same way in both runtimes,
// which is the point of the sibling layout: on disk web/static/js/features →
// web/domain, and over the wire /js/features → /domain (URL resolution clamps
// at the origin root, and web/embed.go serves web/domain there). Change the
// depth of this directory and both break together, loudly.

import { localRecords } from '../core/localdb.js';
import { createPortfolioDomain } from '../../../domain/portfolio.js';
import { createPerformanceDomain } from '../../../domain/perf.js';
import { RECORD, SETTINGS_ID, newRecordId } from '../../../domain/schema.js';
import { buildPriceChunk } from './forms.js';

// The §3 port as a STABLE object. The domain factories below capture whatever
// they are handed once, at module load, and boot has not decided which
// implementation it is using by then — the vault is opened asynchronously, after
// the shell has painted. So the swap happens underneath this reference rather
// than by reassigning it: `records` never changes identity, `impl` does.
//
// Reassigning the export instead would leave both domain engines holding
// localRecords forever, which is a bug that looks exactly like working software
// — every screen renders, every write lands in the mirror, and nothing is ever
// backed up.
let impl = localRecords;

export const records = {
    list: (recordType) => impl.list(recordType),
    put: (recordType, recordId, body) => impl.put(recordType, recordId, body),
    del: (recordType, recordId) => impl.del(recordType, recordId),
};

/**
 * Swap the port implementation. Called once, by the vault wiring in sync.js,
 * with a vaultRecords that has already opened successfully — never speculatively,
 * because a half-open vault serving reads is how a user ends up staring at an
 * empty portfolio.
 */
export function useRecords(next) {
    impl = next;
}

/** Which implementation is live. Exported for the boot test, not for screens. */
export function isVaultBacked() {
    return impl !== localRecords;
}

const portfolio = createPortfolioDomain({ records });
const performance = createPerformanceDomain({ records });

/** Used when a user has not chosen one yet. Only ever a default, never implied. */
export const DEFAULT_CURRENCY = 'EUR';

/**
 * Everything the screens render from. `ready` stays false until the first load
 * resolves, and `error` carries the reason if IndexedDB is unavailable (private
 * browsing) — a screen must render *something* in that case rather than hang.
 */
export const state = {
    ready: false,
    error: null,
    snapshot: null,
    perf: null,
    settings: {},
    accounts: [],
    securities: [],
    transactions: [],
};

const listeners = new Set();

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    for (const fn of [...listeners]) fn(state);
}

export function reportingCurrency() {
    return state.settings.reportingCurrency || DEFAULT_CURRENCY;
}

// --- Reads -----------------------------------------------------------------

/**
 * Re-derive the whole world. Deliberately a full recompute after every write
 * rather than an incremental patch: portfolio.js already folds the entire log
 * in one pass, a personal portfolio is hundreds of records, and an incremental
 * cache is how two views start disagreeing about the same number.
 *
 * ponytail: full recompute per write, plus one perf() pass which is itself
 * O(boundaries × records). Fine to a few thousand transactions; past that the
 * upgrade path is the streaming snapshot API perf.js already asks for in its
 * own ponytail note — a change in web/domain/, not here.
 */
export async function refresh() {
    try {
        const [snapshot, accounts, securities, transactions, settingsRecs] = await Promise.all([
            portfolio.snapshot(),
            records.list(RECORD.account),
            records.list(RECORD.security),
            records.list(RECORD.transaction),
            records.list(RECORD.settings),
        ]);
        state.snapshot = snapshot;
        state.accounts = accounts;
        state.securities = securities;
        state.transactions = transactions;
        state.settings = settingsRecs.find((r) => r.recordId === SETTINGS_ID) ?? {};
        state.error = null;
    } catch (err) {
        // A shell that throws here shows a blank screen; one that records the
        // reason can say what happened.
        state.error = err;
        console.warn('store: could not read the local database', err);
    }
    state.ready = true;
    emit();
}

/**
 * TTWROR/IRR over a range. Kept off `refresh()` because only the Performance
 * and Dashboard screens need it and it is the expensive call.
 */
export async function loadPerformance(range) {
    try {
        state.perf = await performance.performance(range ?? {});
        return state.perf;
    } catch (err) {
        state.perf = { error: err };
        return state.perf;
    }
}

// --- Writes ----------------------------------------------------------------
//
// Every mutator ends in refresh(), so a screen's re-render always reflects a
// completed write rather than an optimistic guess.

async function write(type, recordId, body) {
    const id = recordId || newRecordId(type, Date.now());
    await records.put(type, id, body);
    await refresh();
    return id;
}

export const putTransaction = (id, body) => write(RECORD.transaction, id, body);
export const putAccount = (id, body) => write(RECORD.account, id, body);
export const putSecurity = (id, body) => write(RECORD.security, id, body);

export async function remove(type, recordId) {
    await records.del(type, recordId);
    await refresh();
}

/** Merge into the settings singleton (§4: fixed recordId). */
export async function putSettings(patch) {
    const { recordId, recordType, clientTs, deleted, ...current } = state.settings;
    await records.put(RECORD.settings, SETTINGS_ID, { ...current, ...patch });
    await refresh();
}

/**
 * Record a close for one security on one day. The chunk shaping — the §4
 * per-security-year record, the zero-padded MM-DD key, the merge that keeps the
 * year's history — lives in forms.buildPriceChunk, where it is unit-tested; all
 * this does is read the existing chunk and write the result back.
 *
 * ponytail: the deterministic id `price_<securityId>_<year>` means a device
 * that never saw the remote chunk overwrites it wholesale on merge (LWW at
 * security-year, exactly the granularity ARCHITECTURE.md §4 accepts and its own
 * ponytail note tracks). Prices are refetchable, so this loses nothing durable.
 */
export async function putPrice(securityId, day, closeUnits) {
    const year = String(day ?? '').slice(0, 4);
    const existing = (await records.list(RECORD.price))
        .find((r) => r.recordId === `${RECORD.price}_${securityId}_${year}`);
    const { errors, recordId, body } = buildPriceChunk({ existing, securityId, day, closeUnits });
    if (errors.length > 0) throw new RangeError(errors.join(' '));
    await records.put(RECORD.price, recordId, body);
    await refresh();
}

// --- Bulk ------------------------------------------------------------------

/**
 * Write parsed records (from ppimport.js) straight through the port. The
 * importer already minted deterministic ids, so re-importing the same file
 * overwrites rather than doubling the portfolio (§4) — that idempotence is the
 * importer's, and it only survives if we honour the id it chose.
 */
export async function importRecords(parsed) {
    let written = 0;
    for (const rec of parsed) {
        const { recordId, recordType, clientTs, deleted, ...body } = rec;
        if (!recordId || !recordType) continue;
        await records.put(recordType, recordId, body);
        written += 1;
    }
    await refresh();
    return written;
}

/** Every live record, for the export file. Tombstones are excluded by list(). */
export async function exportAll() {
    const types = Object.values(RECORD);
    const lists = await Promise.all(types.map((t) => records.list(t)));
    return { app: 'myportfolio', version: 1, records: lists.flat() };
}
