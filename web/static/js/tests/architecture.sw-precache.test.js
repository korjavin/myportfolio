/**
 * architecture.sw-precache.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test) and rewritten around
 * this app's shape.
 *
 * The sibling compared the SW's precache list against the `<script src>` tags in
 * index.html. That worked there because it had no ES modules — every file the
 * page needed had its own tag. Here index.html loads ONE module
 * (js/features/boot.js) and the rest of the shell arrives through `import`
 * statements the sibling's scan cannot see. Comparing against the tags alone
 * would have declared a precache list complete while `js/core/records.js` and
 * `vendor/dexie.min.js` were missing from it — and the failure mode is invisible
 * until someone is on a plane.
 *
 * So this version computes the shell's real closure:
 *
 *     {'/'} ∪ {local src=/href= in index.html} ∪ {transitive ESM imports}
 *          ∪ {url() in css/fonts.css} ∪ {icons[].src in manifest.json}
 *
 * and pins PRECACHE to it in BOTH directions. Missing entries break offline;
 * orphan entries ship dead bytes and hide deletions (the sibling carried
 * features/settings.js in its cache for months after nothing loaded it).
 *
 * Deliberately closure-based rather than "every file under web/static": the
 * vault track is landing its own ceremony pages as sibling .html files, and
 * design.html already exists. Those are not part of the shell's boot path, they
 * are cached on first visit by the runtime handler in sw.js, and they must not
 * make this guard fail the moment they merge.
 *
 * Sanity check: delete '/js/core/records.js' from PRECACHE in web/static/sw.js
 * and re-run — the "covers the shell's closure" case must fail naming it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATIC_DIR = path.join(REPO_ROOT, 'web/static');
const INDEX_PATH = path.join(STATIC_DIR, 'index.html');
const SW_PATH = path.join(STATIC_DIR, 'sw.js');
const FONTS_CSS_PATH = path.join(STATIC_DIR, 'css/fonts.css');

/**
 * Map a served URL path onto the file that answers it. web/embed.go serves the
 * web/static tree at the root, so "/css/styles.css" is web/static/css/styles.css
 * and "/" is web/static/index.html — with ONE exception, which embed.go's
 * splitFS makes explicit: "/domain/..." is web/domain, not web/static/domain.
 *
 * The exception exists because ARCHITECTURE.md §2 puts the pure domain modules
 * outside web/static while §10 has the feature screens import them. This
 * function has to mirror the server's routing exactly or the guard measures a
 * different app than the one that ships.
 */
const WEB_DIR = path.join(REPO_ROOT, 'web');

function fileFor(urlPath) {
    if (urlPath === '/') return INDEX_PATH;
    const rel = urlPath.replace(/^\//, '');
    return rel.startsWith('domain/')
        ? path.join(WEB_DIR, rel)
        : path.join(STATIC_DIR, rel);
}

/**
 * Local asset URLs referenced by index.html: script src, stylesheet/manifest/
 * icon href — anything absolute-rooted with a file extension. Attribute-name
 * agnostic on purpose, so a new <link rel="…"> or a preload does not need this
 * scanner taught about it.
 */
function indexAssets(html) {
    const found = new Set();
    const re = /\b(?:src|href)\s*=\s*["'](\/[^"'#?]*\.[a-z0-9]+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) found.add(m[1]);
    return found;
}

/** Static import specifiers in an ES module: `from '…'` and bare `import '…'`. */
function importSpecifiers(source) {
    const specs = [];
    for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g]) {
        let m;
        while ((m = re.exec(source)) !== null) specs.push(m[1]);
    }
    return specs.filter((s) => s.startsWith('.') || s.startsWith('/'));
}

/** Walk the ESM graph from the .js entries in `roots`, returning every URL path. */
function moduleClosure(roots) {
    const seen = new Set();
    const queue = [...roots].filter((u) => u.endsWith('.js'));
    while (queue.length > 0) {
        const urlPath = queue.pop();
        if (seen.has(urlPath)) continue;
        seen.add(urlPath);
        const file = fileFor(urlPath);
        if (!fs.existsSync(file)) continue;
        for (const spec of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
            // Resolve against the *URL* path, not the filesystem path — they
            // differ by the web/static prefix and only the URL form is what the
            // service worker can cache.
            const resolved = spec.startsWith('/')
                ? spec
                : path.posix.resolve(path.posix.dirname(urlPath), spec);
            if (!seen.has(resolved)) queue.push(resolved);
        }
    }
    return seen;
}

/** Local icon paths declared by manifest.json — what the installer fetches. */
function manifestAssets(manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return new Set((manifest.icons || []).map((i) => i.src).filter((s) => s.startsWith('/')));
}

/** Local url(...) targets declared by fonts.css. */
function fontAssets(css) {
    const found = new Set();
    const re = /url\(\s*['"]?(\/[^'")]+)['"]?\s*\)/g;
    let m;
    while ((m = re.exec(css)) !== null) found.add(m[1]);
    return found;
}

/** The PRECACHE array in sw.js, as URL paths. */
function precacheEntries(swSource) {
    const arr = swSource.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(arr, 'sw.js does not declare `const PRECACHE = [...]`');
    return new Set([...arr[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
}

const html = fs.readFileSync(INDEX_PATH, 'utf8');
const swSource = fs.readFileSync(SW_PATH, 'utf8');
const precache = precacheEntries(swSource);

const tagged = indexAssets(html);
const expected = new Set([
    '/',
    ...tagged,
    ...moduleClosure(tagged),
    ...fontAssets(fs.readFileSync(FONTS_CSS_PATH, 'utf8')),
    // The install icons: index.html only tags the SVG favicon and the
    // apple-touch-icon, so without this the raster launcher icons look like
    // orphans in the cache.
    ...manifestAssets(path.join(STATIC_DIR, 'manifest.json')),
]);

describe('Architecture — service worker precache', () => {
    test('index.html references local assets and pulls in a module graph', () => {
        // Guards the guard: if either scanner silently stops matching, every
        // assertion below passes vacuously.
        assert.ok(tagged.size > 0, 'no local src=/href= assets found in index.html');
        assert.ok(
            [...expected].some((u) => u.endsWith('.js') && !tagged.has(u)),
            'the ESM walker found no imported modules — it has probably stopped resolving'
        );
    });

    test('PRECACHE covers the shell\'s closure', () => {
        const missing = [...expected].filter((u) => !precache.has(u)).sort();
        assert.deepEqual(
            missing,
            [],
            'These assets are needed to boot the shell but are not precached, so an ' +
            'offline cold start will fail on them. Add them to PRECACHE in ' +
            `web/static/sw.js:\n${missing.map((u) => `  • ${u}`).join('\n')}`
        );
    });

    test('PRECACHE has no entries outside the closure', () => {
        const orphans = [...precache].filter((u) => !expected.has(u)).sort();
        assert.deepEqual(
            orphans,
            [],
            'These are precached but nothing in the shell loads them — dead bytes in ' +
            'every install, and the way a deleted file keeps shipping. Remove them ' +
            'from PRECACHE in web/static/sw.js, or wire them into index.html if they ' +
            `were meant to be part of the shell:\n${orphans.map((u) => `  • ${u}`).join('\n')}`
        );
    });

    test('every precached path resolves to a file that actually ships', () => {
        const dangling = [...precache].filter((u) => !fs.existsSync(fileFor(u))).sort();
        assert.deepEqual(
            dangling,
            [],
            'PRECACHE names paths with no file behind them. cache.addAll() rejects as ' +
            'a unit, so ONE of these makes install fail and the app has no offline ' +
            `mode at all:\n${dangling.map((u) => `  • ${u}`).join('\n')}`
        );
    });

    test('the root document and the manifest are precached', () => {
        // "/" is what a home-screen launch requests, and the manifest is what
        // keeps it installable on a device that has never been online since.
        assert.ok(precache.has('/'), 'PRECACHE is missing the root document "/"');
        assert.ok(precache.has('/manifest.json'), 'PRECACHE is missing /manifest.json');
    });

    test('the worker never takes over an open session without being told to', () => {
        // The code-serving caveat (ARCHITECTURE.md §8). A bare skipWaiting() in
        // install or activate swaps the code under a running session and skips
        // the prompt entirely. (It does NOT follow that dismissing the prompt
        // pins forever — a waiting worker still activates once every client
        // closes. The sw.js header measures and documents that limit.)
        const skipWaitingCalls = [...swSource.matchAll(/self\.skipWaiting\(\)/g)].length;
        assert.equal(
            skipWaitingCalls,
            1,
            'sw.js must call self.skipWaiting() exactly once, inside the SKIP_WAITING ' +
            'message handler that js/features/boot.js posts when the user accepts the ' +
            'update prompt. Calling it in install/activate swaps the running code under ' +
            'an open session with no prompt at all.'
        );
        assert.match(
            swSource,
            /addEventListener\('message'[\s\S]*?SKIP_WAITING[\s\S]*?self\.skipWaiting\(\)/,
            'the single skipWaiting() call must be the one in the SKIP_WAITING message handler'
        );
    });
});
