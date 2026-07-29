/**
 * features.embed-domain.test.js
 *
 * The screens import the pure engines directly — `web/static/js/features/*.js`
 * does `import '../../../domain/portfolio.js'` — but ARCHITECTURE.md §2 puts
 * web/domain OUTSIDE web/static, and web/embed.go historically rooted the
 * served filesystem at web/static alone. That combination has exactly one
 * symptom: the browser asks for /domain/portfolio.js, gets a 404, the module
 * graph fails to resolve, and the app renders nothing — with no server-side
 * error, because a 404 for a static asset is not an error to the server.
 *
 * embed.go now embeds the domain modules and serves them under /domain/. Two
 * things can silently undo that, and this file pins both:
 *
 *   1. A new domain module is imported by a screen and precached, but nobody
 *      adds it to the //go:embed line. It works in dev against a checkout and
 *      404s in the shipped binary — the worst kind of drift, because `go build`
 *      is perfectly happy.
 *   2. Somebody "simplifies" splitFS back into a plain sub(static), which
 *      compiles, passes every Go test, and breaks every screen.
 *
 * The go:embed line is deliberately an explicit per-file list rather than the
 * `domain` directory pattern: the directory would also embed *.test.js and
 * ~108 KB of Portfolio Performance fixtures into the binary and serve them
 * publicly, and go:embed has no exclusion syntax. This test is the price of
 * that choice, and it is a lot cheaper than shipping the fixtures.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMBED_GO = path.join(REPO_ROOT, 'web/embed.go');
const SW_PATH = path.join(REPO_ROOT, 'web/static/sw.js');

const embedSource = fs.readFileSync(EMBED_GO, 'utf8');
const swSource = fs.readFileSync(SW_PATH, 'utf8');

/** Every path named on a //go:embed directive in embed.go. */
function embeddedPatterns(source) {
    const patterns = new Set();
    for (const line of source.split('\n')) {
        const m = /^\s*\/\/go:embed\s+(.+)$/.exec(line);
        if (!m) continue;
        for (const token of m[1].trim().split(/\s+/)) patterns.add(token);
    }
    return patterns;
}

/** The /domain/... entries of the service worker's PRECACHE list. */
function precachedDomainPaths(source) {
    const arr = source.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(arr, 'sw.js does not declare `const PRECACHE = [...]`');
    return [...arr[1].matchAll(/['"](\/domain\/[^'"]+)['"]/g)].map((m) => m[1]);
}

describe('web/embed.go — the domain modules are actually served', () => {
    const patterns = embeddedPatterns(embedSource);
    const domainPaths = precachedDomainPaths(swSource);

    test('the shell precaches domain modules at all', () => {
        // Guards the guard: if the screens ever stop importing web/domain, this
        // whole file passes vacuously and should be reconsidered, not left to
        // rot as a green test that asserts nothing.
        assert.ok(domainPaths.length > 0, 'no /domain/ entries in PRECACHE — has the seam moved?');
    });

    for (const urlPath of precachedDomainPaths(swSource)) {
        const rel = urlPath.replace(/^\//, ''); // "domain/portfolio.js"

        test(`${urlPath} is embedded in the binary`, () => {
            const covered = patterns.has(rel) || patterns.has('domain') || patterns.has('domain/*.js');
            assert.ok(
                covered,
                `${rel} is precached by the service worker but no //go:embed directive in ` +
                `web/embed.go names it. The shipped binary would 404 it while a dev checkout ` +
                `served it fine. Add it to the //go:embed line.`
            );
        });

        test(`${urlPath} resolves to a file that exists`, () => {
            assert.ok(
                fs.existsSync(path.join(REPO_ROOT, 'web', rel)),
                `//go:embed names ${rel} but web/${rel} does not exist — go build fails on this`
            );
        });
    }

    test('every embedded domain file is a module the shell actually loads', () => {
        // The converse: an embedded file nothing imports is dead weight shipped
        // to every user, and it is how a deleted module keeps being served.
        const named = [...patterns].filter((p) => p.startsWith('domain/') && p.endsWith('.js'));
        const precached = new Set(domainPaths.map((u) => u.replace(/^\//, '')));
        const orphans = named.filter((p) => !precached.has(p));
        assert.deepEqual(
            orphans,
            [],
            `Embedded but never loaded by the shell:\n${orphans.map((p) => `  • ${p}`).join('\n')}`
        );
    });

    test('no test file or fixture is embedded', () => {
        // Fixtures are 108 KB of another product's sample portfolios and the
        // test files name paths that only exist in a checkout. Neither belongs
        // in a binary, and neither belongs on a public URL.
        const bad = [...patterns].filter((p) => /\.test\.js$/.test(p) || p.includes('fixtures'));
        assert.deepEqual(bad, [], `test/fixture paths in //go:embed: ${bad.join(', ')}`);
    });

    test('/domain/ is routed away from the static tree, not merged into it', () => {
        // A general union with web/static as a fallback would also start
        // answering "/static/css/styles.css" — silently resurrecting the
        // /static/-prefixed asset paths that have already 404'd twice in this
        // repo. Those must keep failing, loudly.
        assert.match(embedSource, /strings\.HasPrefix\(name,\s*"domain\/"\)/,
            'embed.go must route only the domain/ prefix off the static tree');
    });
});
