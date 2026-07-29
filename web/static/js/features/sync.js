// The wire between the shell and the vault (ARCHITECTURE.md §3 and §6).
//
// Everything under web/domain/ is written against ONE records port with three
// methods. There are two implementations of it and this file picks between them
// at boot: localRecords when the device holds no vault, vaultRecords when it
// does. Nothing in web/domain/ changes or even notices — that invisibility is
// the whole reason §3 exists, and it is why the choice lives here rather than as
// a branch inside a screen.
//
// It also owns the two things the sync engine cannot own for itself:
//
//   WHEN to pull — on open and on focus (§6). Never a polling timer: a timer
//   burns battery to discover nothing on a device nobody is looking at, and it
//   still misses the case that matters, which is the user coming BACK.
//
//   HOW a failure reads — describeSync() below. A sync that has stopped working
//   while the app looks fine is the failure this entire design exists to avoid,
//   so every state the engine can reach has copy here, and the three that need a
//   human are marked `ambient` so the shell shows them without being asked.
//
// This file deliberately does not import localdb.js. The Dexie handle arrives as
// an argument, which keeps the whole decision testable under node without a
// browser — the part of a boot path that is normally only ever exercised by
// hand.

import { createVaultRecords } from '../core/vault-records.js';
import { tryWarmUnlock } from '../core/unlock.js';

// Two events fire for one alt-tab (focus, then visibilitychange), and a user
// flicking between windows fires them repeatedly. A pull is a network round trip
// plus a decrypt of the whole blob, so it is gated on an interval — this is a
// debounce on a user gesture, NOT a poll: with the app open and untouched,
// nothing here ever fires.
export const PULL_MIN_INTERVAL_MS = 10_000;

const listeners = new Set();

let vault = null;
let accountId = null;
let status = null;
let fatal = null;
let lastSyncedAt = null;
// Consecutive failed attempts. One failed request on a flaky connection is not
// news; the second is, and the difference is what keeps the banner from crying
// wolf on every tunnel.
let failures = 0;
let clockNow = Date.now;

/** Everything the UI renders sync from. A snapshot, never the live objects. */
export function syncState() {
    return { connected: vault !== null, accountId, status, fatal, lastSyncedAt, failures };
}

export function subscribeSync(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    const snapshot = syncState();
    for (const fn of [...listeners]) fn(snapshot);
}

// vaultRecords calls this on every state change. It is the surface that stops a
// wedged sync from being silent, so it records rather than filters: the error
// object is kept as-is and rendered by describeSync.
function onStatus(next) {
    const previous = status;
    if (next.lastError) {
        // Identity, not truthiness: the same unresolved error is re-emitted on
        // every subsequent write, and counting those would inflate one outage
        // into a dozen failures.
        if (!previous || previous.lastError !== next.lastError) failures += 1;
    } else {
        failures = 0;
        // An upload that just COMPLETED, and had something to upload.
        //
        // Both halves matter. schedule() emits `pending` with lastError still
        // null, so "no error" alone would date a sync that never ran — and
        // flush() with nothing dirty still emits syncing true then false
        // WITHOUT touching the network, so a bare syncing-transition would let
        // backgrounding the tab print "Synced just now" over a server that has
        // been unreachable for a week. That is the lying indicator this whole
        // bead is about. Pulls date themselves in pull(), where reaching the
        // wire is not in doubt.
        if (previous && previous.syncing && !next.syncing && previous.pending) {
            lastSyncedAt = clockNow();
        }
    }
    status = next;
    emit();
}

/**
 * Pull, merge, and push anything this device holds that the server does not.
 * Also the signup migration: with no blob on the server yet, the union of local
 * and remote is exactly the offline-built portfolio, so it uploads whole.
 *
 * The rejection is caught, NOT swallowed — vaultRecords has already routed it
 * through onStatus, so it is on screen before this returns. Rethrowing would
 * only add an unhandled rejection to a failure the user can already read.
 */
async function pull(onRecords) {
    if (!vault) return null;
    try {
        await vault.sync();
        // A pull always reaches the server, so this is the one place a sync can
        // be dated outright rather than inferred from a status transition.
        lastSyncedAt = clockNow();
        emit();
    } catch {
        // Deliberately empty: see above. status.lastError carries it.
    }
    // Remote rows may have landed in the mirror even if the push half failed,
    // so the screens are re-derived either way.
    await onRecords();
    return status;
}

/**
 * Choose the port implementation — and, now, the database it reads — and hand
 * it to the store.
 *
 * `adopt` is only ever called with a vault that OPENED. A device that fails
 * state-sync's wrong-account backstop keeps serving its records from
 * localRecords — unsynced, intact, and loudly flagged — rather than uploading
 * them into somebody else's vault.
 *
 * `db` is the PRE-SIGNUP mirror: what a user with no account has been typing
 * into. Which database an account actually reads is `openMirror(accountId, db)`,
 * and where its sync metadata lives is `openMeta(accountId)` — both supplied by
 * the caller, because storage names belong to localdb.js and this file stays
 * importable under `node --test` with no browser (bd myportfolio-18h.12).
 * The defaults are the un-namespaced behaviour, which is what the doubles in the
 * tests want; boot.js passes the real ones.
 *
 * `onRecords` is called as soon as the port is settled, on EVERY exit path,
 * before any network. The store starts on the pre-signup mirror, so re-deriving
 * the screens before this decision would paint an empty portfolio over a
 * signed-in user's real one until the vault opened.
 */
export async function startSync({
    db,
    adopt,
    onRecords = () => {},
    warm = tryWarmUnlock,
    create = createVaultRecords,
    openMirror = async (_accountId, mirror) => mirror,
    openMeta = () => undefined,
    now = Date.now,
    ...options
} = {}) {
    // Called once per page load in the real shell. Resetting anyway keeps a
    // second call from inheriting the first's vault, which is the difference
    // between a test suite that isolates and one that passes in file order.
    vault = null;
    accountId = null;
    status = null;
    fatal = null;
    lastSyncedAt = null;
    failures = 0;
    clockNow = now;

    let ctx = null;
    try {
        ctx = await warm();
    } catch (err) {
        // tryWarmUnlock already treats a corrupt cache as cold, so anything
        // left is the device database itself being unavailable.
        fatal = err;
        emit();
        await onRecords();
        return null;
    }
    // No vault on this device. localRecords stays, and the app is complete
    // without it (§3) — this is not an error state and must not read as one.
    if (!ctx) {
        emit();
        await onRecords();
        return null;
    }

    try {
        // The account's own mirror, with anything typed before signup migrated
        // into it. Opening it can fail (private browsing, a blocked upgrade) and
        // that failure belongs in the same place as a vault that would not open:
        // the app keeps serving the pre-signup mirror rather than syncing rows
        // it cannot vouch for.
        const mirror = await openMirror(ctx.accountId, db);
        vault = await create({
            db: mirror,
            dek: ctx.dek,
            accountId: ctx.accountId,
            meta: openMeta(ctx.accountId),
            onStatus,
            now,
            ...options,
        });
    } catch (err) {
        // 'wrong-account' lands here: state-sync claims the mirror before it
        // touches the wire, precisely so a vault used entirely offline still
        // trips the guard. Per-account mirrors make it unreachable in normal
        // use; it stays as the backstop for the case they do not cover, a mirror
        // this build did not name.
        fatal = err;
        emit();
        await onRecords();
        return null;
    }

    accountId = ctx.accountId;
    adopt(vault);
    emit();
    // The port is settled: paint what is already in this account's mirror before
    // going near the network, so an offline launch shows the portfolio rather
    // than waiting out a pull that is going to fail.
    await onRecords();
    await pull(onRecords);
    return vault;
}

/** The manual "Sync now" button, and what the focus watcher calls. */
export function syncNow(onRecords = () => {}) {
    return pull(onRecords);
}

/**
 * Pull on focus (§6), and on the two other moments a stalled sync can start
 * working again. Returns an unsubscribe so a test can take its listeners back
 * off the target.
 *
 * Flushes on hide, with no interval gate: a debounced write that has not left
 * yet is safe in the mirror, but sending it while the tab is still alive is the
 * difference between syncing now and syncing whenever the user next opens this
 * device — which may be never.
 *
 * Pulls on `online`, also ungated. That event is the one reconnection signal
 * that arrives with the user sitting in the foreground doing nothing, so no
 * focus event follows it — and the offline copy has just promised that the
 * write will go when the network is back. Without this it would wait for the
 * next focus or the next write, which is a promise the UI cannot keep.
 */
export function watchFocus({
    target = globalThis,
    doc = globalThis.document,
    onRecords = () => {},
    minIntervalMs = PULL_MIN_INTERVAL_MS,
    now = Date.now,
} = {}) {
    let last = now();

    const onFocus = () => {
        if (!vault) return;
        if (doc && doc.visibilityState === 'hidden') return;
        if (now() - last < minIntervalMs) return;
        last = now();
        pull(onRecords);
    };

    const onVisibility = () => {
        if (!vault) return;
        if (doc && doc.visibilityState === 'hidden') {
            // Only when there is something to send. A flush with nothing dirty
            // does no work and reaches no server, so asking for one on every
            // tab switch is pure noise in the status stream.
            if (vault.status().pending) vault.flush().catch(() => {});
            return;
        }
        onFocus();
    };

    const onOnline = () => {
        if (!vault) return;
        last = now();
        pull(onRecords);
    };

    target.addEventListener('focus', onFocus);
    target.addEventListener('online', onOnline);
    (doc || target).addEventListener('visibilitychange', onVisibility);
    return () => {
        target.removeEventListener('focus', onFocus);
        target.removeEventListener('online', onOnline);
        (doc || target).removeEventListener('visibilitychange', onVisibility);
    };
}

// --- Copy -------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];

/** "3 days ago" — the honest form of a sync indicator (§6). */
export function ago(fromMs, nowMs) {
    const delta = Math.max(0, nowMs - fromMs);
    for (const [unit, size] of UNITS) {
        if (delta >= size) return RELATIVE.format(-Math.floor(delta / size), unit);
    }
    return 'just now';
}

const SAFE = 'Your changes are saved on this device — nothing has been lost.';

// What a non-retriable failure means, in words. The engine's own message is a
// developer's sentence; these are the user's.
const WEDGED = {
    quota: {
        headline: 'This vault is out of server storage',
        detail: `The server will not accept any more of your portfolio until the vault is back under quota. ${SAFE}`,
    },
    rollback: {
        headline: 'The server sent older data than this device already has',
        detail: 'myportfolio refused to apply it, because doing so would silently undo changes you have made. '
            + 'Sync is stopped until this is looked at. ' + SAFE,
    },
    corrupt: {
        headline: 'The vault\'s stored state could not be read',
        detail: `Sync is stopped rather than overwriting it with a guess. ${SAFE}`,
    },
};

/**
 * The one place a sync state becomes words. Pure, so every branch of it is
 * asserted in features.sync.test.js rather than discovered in production.
 *
 * `ambient` is the load-bearing field: true means the shell puts this in front
 * of the user unprompted. It is true for exactly the states a human has to act
 * on — and false for being offline, which in a local-first app is normal and
 * must never nag.
 */
export function describeSync(snapshot, { online = true, now = Date.now } = {}) {
    const { connected, status: s, fatal: err, lastSyncedAt: synced, failures: fails = 0 } = snapshot;

    if (err) {
        if (err.code === 'wrong-account') {
            return {
                tone: 'error',
                ambient: true,
                headline: 'Sync is off — this browser already holds a different vault',
                detail: 'myportfolio can keep one vault per browser profile for now. Everything you enter here '
                    + 'is still saved on this device, but it is not being backed up and will not reach your '
                    + 'other devices. Use a separate browser profile for this account, or clear this site\'s '
                    + 'data if you want to start fresh here.',
                action: null,
            };
        }
        return {
            tone: 'error',
            ambient: true,
            headline: 'Sync could not start',
            detail: `${err.message || String(err)} ${SAFE}`,
            action: { label: 'Open the vault page', href: '/vault.html' },
        };
    }

    if (!connected) {
        return {
            tone: 'local',
            ambient: false,
            headline: 'This device only',
            detail: 'Your portfolio is stored in this browser and is not backed up. Set up a vault to '
                + 'encrypt it and sync it to your other devices.',
            action: { label: 'Set up sync', href: '/vault.html' },
        };
    }

    if (!s) {
        return { tone: 'busy', ambient: false, headline: 'Opening your vault…', detail: null, action: null };
    }

    const clock = s.clockWarning
        ? ` This device's clock is off by about ${Math.round(Math.abs(s.clockSkewMs) / 60000)} minutes, `
          + 'which can order edits made on two devices wrongly.'
        : '';

    if (s.needsAuth) {
        return {
            tone: 'auth',
            ambient: true,
            headline: 'Your vault session expired',
            detail: `Unlock with your passkey to keep syncing. ${SAFE}${clock}`,
            action: { label: 'Unlock', href: '/vault.html' },
        };
    }

    if (s.wedged) {
        const known = WEDGED[s.lastError?.code];
        return {
            tone: 'error',
            ambient: true,
            headline: known ? known.headline : 'Sync is stuck',
            detail: (known ? known.detail : `${s.lastError?.message || 'The server refused this vault\'s state.'} ${SAFE}`)
                + clock,
            action: null,
        };
    }

    if (s.lastError) {
        // Retriable. Offline is the expected case for a local-first app, so it
        // is reported as a fact and never as a problem.
        if (!online) {
            return {
                tone: 'offline',
                ambient: false,
                headline: 'Offline',
                detail: `Changes are saved on this device and will sync when you are back online.${clock}`,
                action: null,
            };
        }
        return {
            tone: 'warn',
            // One failed request is a blip. A second one, with the network up,
            // is the beginning of the silent-failure this design fears.
            ambient: fails >= 2 || s.lastError.code === 'conflict',
            headline: s.lastError.code === 'conflict'
                ? 'Sync keeps losing a race with another device'
                : 'Can\'t reach the sync server',
            detail: `myportfolio will keep retrying. ${SAFE}${clock}`,
            action: null,
        };
    }

    if (s.syncing) {
        return { tone: 'busy', ambient: false, headline: 'Syncing…', detail: clock || null, action: null };
    }

    if (s.pending) {
        return {
            tone: 'pending',
            ambient: false,
            headline: 'Changes waiting to sync',
            detail: `They are already saved on this device.${clock}`,
            action: null,
        };
    }

    return {
        tone: 'ok',
        ambient: false,
        headline: synced ? `Synced ${ago(synced, now())}` : 'Synced',
        detail: clock || null,
        action: null,
    };
}
