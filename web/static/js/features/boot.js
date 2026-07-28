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

import { localRecords } from '../core/localdb.js';
import { renderScreen, resolveScreenId, screenTitle } from './screens.js';

// Record types whose counts the dashboard reports. Kept to the three the
// skeleton shows; g7e.7 replaces this with a real valuation read.
const COUNTED_TYPES = ['account', 'security', 'transaction'];

const screenEl = document.getElementById('screen');
const navMountEl = document.getElementById('nav-mount');
const promptEl = document.getElementById('update-prompt');

let nav = null;
let counts = null;

function currentScreenId() {
    // Hash routing, not History API: it needs no server-side rewrite, so an
    // offline cold start of any screen resolves to the one cached document.
    return resolveScreenId(window.location.hash.replace(/^#\/?/, ''));
}

function render(focus) {
    const id = renderScreen(screenEl, currentScreenId(), counts);
    document.title = `${screenTitle(id)} · myportfolio`;
    if (nav) nav.setActive(id);
    // Move focus on navigation only: doing it on first paint would steal focus
    // from the address bar before the user has done anything.
    if (focus) screenEl.focus({ preventScroll: true });
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

async function loadCounts() {
    // Wrapped: IndexedDB is unavailable in some private-browsing modes, and a
    // shell that throws there is a shell that shows a blank screen.
    try {
        const pairs = await Promise.all(
            COUNTED_TYPES.map(async (t) => [t, (await localRecords.list(t)).length])
        );
        counts = Object.fromEntries(pairs);
        render(false);
    } catch (err) {
        console.warn('boot: local store unavailable, rendering without counts', err);
    }
}

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

// Both are deliberately after the first paint: the shell must be on screen
// before either the database or the network is touched.
loadCounts();
registerServiceWorker();
