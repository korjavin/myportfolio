/**
 * architecture.domain-purity.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test) with a different
 * justification, because this app's reason is stronger than the sibling's.
 *
 * There, `web/domain/` had to stay free of browser globals so the same source
 * could run inside the Go server under goja. Here it is the load-bearing half
 * of ARCHITECTURE.md §3: every domain module is a factory over an injected
 * `records` port, and that is the ONLY thing that lets Track A swap
 * `localRecords` for `vaultRecords` — plaintext Dexie for an encrypted,
 * server-synced mirror — without a single edit inside `web/domain/`. The moment
 * a domain module reaches for `indexedDB`, `fetch` or `window` directly, that
 * substitution stops being possible and the two tracks are welded together.
 *
 * So this is not hygiene. It is the seam.
 *
 * The listed globals are exactly the four ARCHITECTURE.md §1 names, plus
 * `navigator.` (carried over from the sibling): it is the same class of
 * mistake, and `navigator.onLine` is a tempting one for a domain module that
 * wants to know whether prices are stale.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOMAIN_DIR = path.join(REPO_ROOT, 'web/domain');

const FORBIDDEN_PATTERNS = [
    /\bwindow\./,
    /\bdocument\./,
    /\bfetch\(/,
    /\bindexedDB\b/,
    /\bnavigator\./,
];

function listJsFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

/**
 * Blank out comment bodies, preserving newlines so reported line numbers still
 * match the source. Prose legitimately names these globals — the header of
 * every domain module explains which ports replace them.
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

describe('Architecture — web/domain/ purity (the records-port seam)', () => {
    const files = listJsFiles(DOMAIN_DIR);

    test('there are domain files to check', () => {
        // A guard that silently passes on an empty file list is not a guard.
        assert.ok(files.length > 0, `no .js files found under ${DOMAIN_DIR}`);
    });

    test('no domain module references a browser global', () => {
        const violations = [];

        for (const file of files) {
            const rel = path.relative(REPO_ROOT, file);
            const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
            lines.forEach((line, idx) => {
                for (const pattern of FORBIDDEN_PATTERNS) {
                    if (pattern.test(line)) {
                        violations.push(`  • ${rel}:${idx + 1}: ${line.trim()}`);
                        return;
                    }
                }
            });
        }

        assert.deepEqual(
            violations,
            [],
            'A module under web/domain/ references a browser global. That breaks the ' +
            'ARCHITECTURE.md §3 seam: domain modules are factories over an injected ' +
            '`records` port, which is the only reason Track A can swap localRecords for ' +
            'vaultRecords without editing web/domain/. Route the I/O through a port ' +
            `instead.\n\n${violations.join('\n')}`
        );
    });
});
