// Bootstrap for the installable shell: mount the bottom nav, run the hash
// router, register the service worker, and prompt — never auto-apply — when a
// new worker is waiting.
//
// A module rather than an inline <script>: the served CSP is
// `script-src 'self'` with no 'unsafe-inline' (internal/server/server.go), so
// an inline block is dropped without a console error.
//
// PERMISSION PROMPTS: there are none, anywhere, and that is deliberate. The
// bead's landmine is that on iOS a permission prompt only works inside an
// installed app and needs a user gesture there, so install must come first.
// This app has nothing to ask for — ARCHITECTURE.md §8 drops push entirely, and
// storage is plain IndexedDB, which needs no grant. If a later bead ever adds
// one (persistent-storage, notifications), it belongs behind an explicit
// in-app control on an installed client, never on boot.

import { renderScreen, resolveScreenId, screenTitle } from './screens.js';
import { refresh, subscribe, useRecords } from './store.js';
import { db, openMirror, openSyncMeta } from '../core/localdb.js';
import { startSync, watchFocus, subscribeSync, syncState, describeSync } from './sync.js';
import { syncNotice } from './ui.js';

const screenEl = document.getElementById('screen');
const navMountEl = document.getElementById('nav-mount');
const promptEl = document.getElementById('update-prompt');

let nav = null;

function currentScreenId() {
    // Hash routing, not History API: it needs no server-side rewrite, so an
    // offline cold start of any screen resolves to the one cached document.
    return resolveScreenId(window.location.hash.replace(/^#\/?/, ''));
}

function render(focus) {
    const id = currentScreenId();
    document.title = `${screenTitle(id)} · myportfolio`;
    if (nav) nav.setActive(id);
    // Move focus on navigation only: doing it on first paint would steal focus
    // from the address bar before the user has done anything.
    if (focus) screenEl.focus({ preventScroll: true });
    // Screens paint synchronously and only the domain-backed tail is awaited,
    // so a rejection here is a bug in a screen, not a slow database.
    renderScreen(screenEl, id)
        .then(paintNotice)
        .catch((err) => console.error('boot: screen render failed', err));
}

// ---------------------------------------------------------------------------
// The sync affordance
// ---------------------------------------------------------------------------

// A sync that has stopped working while the app looks fine is the failure this
// whole design exists to avoid, so the states a human has to act on are put in
// front of them: an expired session, a wedged vault, a server that has been
// unreachable for more than one attempt. Settings carries the full picture,
// including the states that are NOT problems.
//
// There is deliberately no reassuring green tick here. An indicator that says
// "synced" is only worth anything if it can be trusted, and one that is drawn
// from a status nobody re-checks is worse than nothing.
let noticeEl = null;

function paintNotice() {
    const desc = describeSync(syncState(), { online: navigator.onLine });
    // Replaced rather than re-rendered through the store: a status change must
    // not re-render the whole screen, or a debounced flush landing three seconds
    // after a keystroke wipes the form the user is still typing into.
    if (noticeEl) noticeEl.remove();
    noticeEl = desc.ambient ? syncNotice(desc) : null;
    if (noticeEl) screenEl.prepend(noticeEl);
}

function mountNav() {
    if (!window.WGBottomNav) {
        throw new Error('boot: wg-bottom-nav.js must load before boot.js');
    }
    nav = window.WGBottomNav.mount(navMountEl, {
        active: currentScreenId(),
        onChange(id) {
            window.location.hash = `#/${id}`;
        },
    });
}

// Every write goes through store.refresh(), which emits when the derived state
// is settled — so a screen re-renders off completed writes only, never an
// optimistic guess that a failed put would leave on screen.
subscribe(() => render(false));

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

// Set only when the user presses Reload. `controllerchange` also fires on the
// very first install (the worker calls clients.claim()), and reloading there
// would be a spurious refresh; more importantly, reloading on ANY controller
// change would turn a background swap into a silent code update, which is the
// thing ARCHITECTURE.md §8 says not to do.
let updateAccepted = false;
let waitingWorker = null;

// Bounded honesty about what "Later" means: it keeps the current session on
// the code it started with, and the prompt returns next time the app is open
// with a worker still waiting. It is NOT a veto — if every window closes, the
// waiting worker activates on its own and the next launch runs the new build.
// The reasoning for not fighting that is in the sw.js header.
function showUpdatePrompt(worker) {
    if (!promptEl || !worker) return;
    waitingWorker = worker;
    promptEl.classList.remove('hidden');
}

document.getElementById('update-reload').addEventListener('click', () => {
    if (!waitingWorker) return;
    updateAccepted = true;
    promptEl.classList.add('hidden');
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
});

document.getElementById('update-dismiss').addEventListener('click', () => {
    // Keeps THIS session on the bundle it started with. See the note above
    // showUpdatePrompt for what it does not promise.
    promptEl.classList.add('hidden');
});

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            // Never let the HTTP cache answer for sw.js itself: the worker is
            // what pins every other asset, so a stale copy of it pins the
            // wrong generation indefinitely.
            updateViaCache: 'none',
        });

        // Already waiting from a previous visit the user did not accept.
        if (reg.waiting && navigator.serviceWorker.controller) {
            showUpdatePrompt(reg.waiting);
        }

        reg.addEventListener('updatefound', () => {
            const installing = reg.installing;
            if (!installing) return;
            installing.addEventListener('statechange', () => {
                // A controller already exists ⇒ this is an update, not the
                // first install. The first install must not prompt.
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdatePrompt(installing);
                }
            });
        });

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!updateAccepted) return;
            updateAccepted = false;
            window.location.reload();
        });
    } catch (err) {
        // No service worker means no offline mode, but the app still works for
        // this session — do not take the shell down over it.
        console.warn('boot: service worker registration failed', err);
    }
}

// ---------------------------------------------------------------------------

mountNav();
render(false);
window.addEventListener('hashchange', () => render(true));

// All of these are deliberately after the first paint: the shell must be on
// screen before either the database or the network is touched.
registerServiceWorker();

subscribeSync(paintNotice);
// navigator.onLine is the difference between "offline, will sync later" and
// "sync is broken", and it changes without any sync activity to notice it.
window.addEventListener('online', paintNotice);
window.addEventListener('offline', paintNotice);

// The wire (ARCHITECTURE.md §3): whether this app is backed up at all comes down
// to these two calls. startSync picks the port implementation — localRecords
// with no vault on the device, vaultRecords with one — hands it to the store,
// and then pulls. That first pull is also the signup migration: with no blob on
// the server yet, the union of local and remote is the whole offline-built
// portfolio, so it uploads intact.
//
// It also picks the DATABASE. `db` is the pre-signup mirror; openMirror gives an
// unlocked account its own namespaced one and moves any pre-signup rows into it,
// so two accounts can share a browser profile without either seeing the other's
// records (bd myportfolio-18h.12). The first refresh() is startSync's job for
// the same reason — it fires through onRecords the moment that choice is made,
// and refreshing before it would paint the empty pre-signup mirror over a
// signed-in user's portfolio. refresh() cannot reject: it records the failure on
// state.error and the screens render it.
startSync({ db, openMirror, openMeta: openSyncMeta, adopt: useRecords, onRecords: refresh }).catch((err) => {
    // startSync reports its own failures through describeSync; anything that
    // escapes it is a bug in this file, not a sync state. The screens still have
    // to come off "Opening your portfolio…" — a shell that never paints because
    // the sync wiring threw is worse than one with no sync.
    console.error('boot: sync wiring failed', err);
    refresh();
});
watchFocus({ onRecords: refresh });
