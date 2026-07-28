// architecture.no-external-fonts-in-html.test.js
//
// Ported from ../medicationtrackerbot (vitest → node:test).
//
// Fonts are self-hosted (web/static/fonts + css/fonts.css), never loaded from
// a CDN. A <link> to fonts.googleapis.com would need an entry in the
// connect-src / style-src allowlist, and that allowlist is the entire basis of
// this app's XSS-exfiltration argument (docs/ARCHITECTURE.md §7): a hole
// punched for a font host is a hole an injected script can POST a decrypted
// portfolio through. It would also phone a third party on every page load,
// which is the opposite of what a local-first app promises.
//
// SCOPE NOTE (differs from the sibling): the sibling checked index.html only.
// This scans every served .html and .css under web/static, so the guard covers
// index.html the moment it lands, plus design.html and any future stylesheet —
// a @import url(https://fonts.googleapis.com/…) inside a CSS file is the same
// hole and the sibling's version would not have caught it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATIC_DIR = path.join(REPO_ROOT, 'web/static');

const BANNED = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'use.typekit.net',
    'fonts.bunny.net',
    'cdn.jsdelivr.net/npm/@fontsource',
];

/**
 * Blank out comment bodies (CSS block comments and HTML comments), preserving
 * newlines so reported line numbers still match the source. A CDN URL inside a
 * comment is inert — and the comments in fonts.css legitimately name the hosts
 * they exist to keep out.
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function collectFiles(dir, exts, base = '') {
    if (!fs.existsSync(dir)) return [];
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name === 'vendor' || entry.name === 'fonts') continue;
            files = files.concat(collectFiles(path.join(dir, entry.name), exts, rel));
        } else if (exts.some((e) => entry.name.endsWith(e))) {
            files.push(rel);
        }
    }
    return files;
}

describe('Architecture — no external font CDN', () => {
    test('no served HTML or CSS references an external font host', () => {
        const offending = [];
        for (const rel of collectFiles(STATIC_DIR, ['.html', '.css'])) {
            const lines = stripComments(fs.readFileSync(path.join(STATIC_DIR, rel), 'utf8')).split('\n');
            lines.forEach((line, idx) => {
                if (BANNED.some((h) => line.includes(h))) {
                    offending.push(`  • web/static/${rel}:${idx + 1}: ${line.trim()}`);
                }
            });
        }
        assert.deepEqual(
            offending,
            [],
            'An external font host is referenced. That punches a hole in the ' +
            "connect-src/style-src allowlist the app's XSS-exfiltration argument " +
            'depends on (ARCHITECTURE.md §7). Self-host under web/static/fonts + ' +
            `css/fonts.css instead. Offending lines:\n${offending.join('\n')}`
        );
    });

    test('the self-hosted woff2 files fonts.css declares actually exist', () => {
        // A guard that only bans the CDN is half a guard: if the local files go
        // missing the app silently falls back to the system stack and someone
        // "fixes" it by re-adding the CDN link.
        const cssPath = path.join(STATIC_DIR, 'css/fonts.css');
        assert.ok(fs.existsSync(cssPath), 'web/static/css/fonts.css is missing');
        const fontsCss = fs.readFileSync(cssPath, 'utf8');

        const urls = [...fontsCss.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]);
        assert.ok(urls.length > 0, 'fonts.css declares no @font-face src urls');

        const missing = [];
        for (const url of urls) {
            assert.ok(!/^https?:/i.test(url), `fonts.css must not load a remote font: ${url}`);
            // Declared as /static/fonts/x.woff2 — served from web/static/fonts.
            const local = path.join(STATIC_DIR, url.replace(/^\/static\//, ''));
            if (!fs.existsSync(local)) missing.push(url);
        }
        assert.deepEqual(missing, [], `fonts.css references woff2 files that do not exist:\n${missing.join('\n')}`);
    });
});
