// myportfolio service worker — the offline guarantee and the code pin.
//
// Two jobs, and the second one is the reason the first is written the way it is:
//
//  1. OFFLINE. "The app works with the network unplugged, forever"
//     (ARCHITECTURE.md, principle 1). PRECACHE below is fetched at install
//     time, so an airplane-mode cold start paints the shell and reads the
//     portfolio out of IndexedDB without a single successful request.
//
//  2. PINNING. E2EE cannot protect against the origin serving poisoned
//     JavaScript (ARCHITECTURE.md §8, code-serving caveat). Serving cache-first
//     from a versioned cache means a running session keeps executing the
//     generation it started with: a redeploy cannot swap code under an open
//     app, and when the app is open the user is asked before it does.
//     skipWaiting() appears exactly once below, in the message handler the
//     update prompt posts.
//
//     WHAT THIS DOES NOT BUY — measured, not assumed (see the bead report):
//     dismiss the prompt, close every window, reopen, and the waiting worker
//     has activated itself. That is the service-worker lifecycle, not a bug
//     here: a waiting worker activates once the last controlled client goes
//     away. So the property is "no swap mid-session, and a prompt while you
//     are looking", NOT "code never changes without consent".
//
//     ponytail: not closing that gap on purpose. The obvious fix — have the
//     worker keep serving a pinned `acceptedVersion` cache until a client
//     consents — does not bind the adversary §8 names, because the origin also
//     serves THIS file and a hostile build simply ships a worker that ignores
//     acceptedVersion. It would only defend against accidental rollouts, where
//     updating on relaunch is the behaviour you want anyway. If the threat
//     model ever grows a way to authenticate the worker script itself (signed
//     bundles, a pinned key), revisit — until then this is honest, and README's
//     "real residual risk, not a solved problem" is the accurate framing.
//
// Bump CACHE_VERSION whenever a shipped asset changes. The bump changes these
// bytes, so the browser sees a new worker, installs it into a fresh cache,
// parks it in the waiting state, and the page prompts. That is the entire
// "versioned immutable assets" mechanism — there is no build step to
// fingerprint filenames, and the server sends `Cache-Control: no-store` so the
// HTTP cache never second-guesses the version we asked for.
const CACHE_VERSION = 'v14';
const CACHE = `myportfolio-shell-${CACHE_VERSION}`;

// Everything the shell needs to boot with no network. Kept in sync with
// index.html's transitive module graph and fonts.css by
// js/tests/architecture.sw-precache.test.js — that guard, not this comment, is
// what keeps the list honest.
//
// Deliberately NOT an enumeration of every file under web/static: other pages
// (the vault track's signup/unlock ceremonies, design.html) are cached on first
// visit by the runtime handler below, so they can land without touching this
// list.
const PRECACHE = [
    '/',
    '/manifest.json',
    '/css/fonts.css',
    '/css/styles.css',
    '/fonts/jetbrains-mono-latin.woff2',
    '/fonts/jetbrains-mono-latin-ext.woff2',
    '/fonts/space-grotesk-latin.woff2',
    '/fonts/space-grotesk-latin-ext.woff2',
    '/icons/icon.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png',
    '/js/components/wg-icons.js',
    '/js/components/wg-bottom-nav.js',
    '/js/components/wg-sparkline.js',
    '/js/components/wg-stale-badge.js',
    '/js/features/boot.js',
    '/js/features/screens.js',
    '/js/features/store.js',
    '/js/features/ui.js',
    '/js/features/fmt.js',
    '/js/features/forms.js',
    '/js/features/dashboard.js',
    '/js/features/holdings.js',
    '/js/features/pricechart.js',
    '/js/features/quotes.js',
    '/js/features/transactions.js',
    '/js/features/performance.js',
    '/js/features/settings.js',
    '/js/features/sync.js',
    '/js/core/localdb.js',
    '/js/core/records.js',
    // The vault half of the §3 port, pulled in by features/sync.js. These are
    // on the boot path even with no network: the port implementation is chosen
    // from the warm LDK cache, which needs no request at all, so a cold start
    // that could not load them would quietly fall back to an unsynced mirror.
    '/js/core/vault-records.js',
    '/js/core/state-sync.js',
    '/js/core/unlock.js',
    '/js/core/ldk.js',
    '/js/core/crypto.js',
    // The device leg of the AI connector (ARCHITECTURE.md §11), pulled in by
    // features/boot.js. It needs the network to do anything, so precaching it
    // looks pointless — it is not: without them in the cache, an offline cold
    // start fails to resolve the import graph of boot.js and the WHOLE SHELL is
    // gone, not just the connector.
    '/js/core/mcp-responder.js',
    '/js/core/mcp-catalog.js',
    '/vendor/dexie.min.js',
    // web/domain/, served at /domain/ by web/embed.go. These are the pure
    // engines — without them offline the shell paints and then every number is
    // missing, which is worse than not painting at all.
    '/domain/schema.js',
    '/domain/money.js',
    '/domain/fx.js',
    '/domain/portfolio.js',
    '/domain/perf.js',
    '/domain/prices.js',
    '/domain/ppimport.js',
    // Precached even though it is the one module that needs the network to do
    // anything: without it offline, Holdings fails to resolve its import graph
    // and the whole screen is gone. A refresh button that reports being offline
    // is strictly better than no Holdings screen at all.
    '/domain/quotes.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(
            // `cache: 'reload'` bypasses the HTTP cache for the precache pass,
            // so a version bump can never install a stale copy of an asset the
            // browser happens to be holding.
            PRECACHE.map((url) => new Request(url, { cache: 'reload' }))
        ))
        // No skipWaiting(): the new worker waits for the user. See the header.
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names.filter((n) => n.startsWith('myportfolio-shell-') && n !== CACHE)
                .map((n) => caches.delete(n))
        );
        // Claim so the very first visit is offline-capable without a reload.
        // boot.js ignores the resulting controllerchange unless the user asked
        // for the update, so this cannot become a silent refresh.
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    // The only way this worker ever activates ahead of schedule.
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    // The API is the vault track's encrypted state blob, the MCP relay, and the
    // pre-fetched quote universe. Caching a decrypted-adjacent response by
    // accident is a real risk, so the whole prefix is left to the network.
    //
    // The universe blob is the one /api/ response that IS cacheable, and it is
    // still excluded on purpose: the handler below is cache-first, which is the
    // code pin, so a cached blob would keep serving yesterday's closes until
    // CACHE_VERSION next changed. It carries `Cache-Control: public, max-age` and
    // an ETag, so the HTTP cache revalidates it correctly with no help from here
    // — and offline valuation never needed it anyway, because every close it has
    // ever produced is already in a `price` record.
    if (url.pathname.startsWith('/api/')) return;
    // Never cache the worker script. The browser's own update check bypasses
    // this handler, so caching it changes no behaviour — but a page-level
    // fetch('/sw.js') would then read a stale generation, which is exactly the
    // kind of thing someone debugging an update problem trips over.
    if (url.pathname === '/sw.js') return;

    event.respondWith(serve(req, url));
});

async function serve(req, url) {
    const cache = await caches.open(CACHE);

    // Cache-first: this is the pin. A response already in this version's cache
    // is the response we install-time verified, and it is what runs until the
    // user accepts a new worker.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    try {
        const res = await fetch(req);
        // Only same-origin, non-opaque, genuinely successful responses. A 404
        // page cached under an asset URL survives every later fix.
        if (res.ok && res.type === 'basic') {
            cache.put(req, res.clone());
        }
        return res;
    } catch (err) {
        // Offline and not in the cache. For a document request, fall back to
        // the app shell: hash routing means every screen lives at "/", so this
        // is the right document, not a generic offline page.
        if (req.mode === 'navigate') {
            const shell = await cache.match('/');
            if (shell) return shell;
        }
        throw err;
    }
}
