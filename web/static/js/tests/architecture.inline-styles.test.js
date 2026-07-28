/**
 * architecture.inline-styles.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test).
 *
 * Lint guard: no `.style.<prop> =` assignments and no `style="…"` attributes
 * in any JS under web/static/js (tests/ and vendor/ excluded).
 *
 * Why: JS sets *class names*; CSS resolves values. The moment a color, size,
 * or gradient can be written from JS, the token system stops being the single
 * source of truth and the design drifts one "just this once" at a time.
 *
 * SCOPE NOTE (differs from the sibling): the sibling narrowed this guard to a
 * handful of Phase-4/5 files because it had years of pre-reskin inline styles
 * to grandfather. This app has no legacy, so the guard covers everything from
 * day one. Adding an exception is a deliberate act: one ALLOWED entry, keyed
 * by exact file:line, with a written justification.
 *
 * Always-allowed without an entry:
 *   - `.style.display =`      show/hide, expresses no visual value
 *   - `.style.setProperty(…)` writing a *neutral* CSS custom property (e.g.
 *                             --ring-progress, --fill-pct) that a CSS class
 *                             then consumes. Note the separate --wg-* guard in
 *                             architecture.design-tokens.test.js still forbids
 *                             writing Wandergeek tokens from JS.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_DIR = path.join(REPO_ROOT, 'web/static/js');

/**
 * Allowlist format: `${repoRelativePath}:${lineNumber}` → justification.
 *
 * Only exact file+line matches are allowed — any move requires a refreshed
 * entry, which forces a code-review checkpoint when an inline style migrates
 * or a new one appears.
 */
const ALLOWED = new Map([
    // (empty — nothing in this codebase needs an inline style yet)
]);

const INLINE_STYLE_RE = /style\s*=\s*["'`]|\.style\./;
const STYLE_PROP_ASSIGN_RE = /\.style\.\w+\s*=/;
const STYLE_CSSTEXT_RE = /\.style\.cssText\s*=/;

function collectJsFiles(dir, base = '') {
    if (!fs.existsSync(dir)) return [];
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'tests' || entry.name === 'vendor') continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files = files.concat(collectJsFiles(path.join(dir, entry.name), rel));
        } else if (entry.name.endsWith('.js')) {
            files.push(rel);
        }
    }
    return files;
}

describe('Architecture – inline-styles guard', () => {
    test('no un-allowlisted inline styles in JS sources', () => {
        const violations = [];

        for (const rel of collectJsFiles(JS_DIR)) {
            const repoRel = `web/static/js/${rel}`;
            const lines = fs.readFileSync(path.join(JS_DIR, rel), 'utf8').split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Skip comment lines — the doc comments describe the rule.
                if (/^\s*\/\//.test(line) || /^\s*\/?\*/.test(line)) continue;
                if (!INLINE_STYLE_RE.test(line)) continue;

                // cssText is always a violation: it writes a whole declaration
                // block from JS, which is the token system's worst case.
                if (!STYLE_CSSTEXT_RE.test(line)) {
                    // show/hide carries no visual value.
                    if (/\.style\.display\s*=/.test(line)) continue;
                    // Neutral custom properties are the documented escape hatch.
                    if (/\.style\.setProperty\(/.test(line)) continue;
                    // Reads/comparisons are not assignments.
                    if (!STYLE_PROP_ASSIGN_RE.test(line) && !/style\s*=\s*["'`]/.test(line)) continue;
                }

                const key = `${repoRel}:${i + 1}`;
                if (!ALLOWED.has(key)) violations.push(`  • ${key}: ${line.trim()}`);
            }
        }

        assert.deepEqual(
            violations,
            [],
            `Un-allowlisted inline styles found.\n` +
            `Either remove the inline style (use a CSS class) or add an ALLOWED entry in\n` +
            `architecture.inline-styles.test.js with a one-line justification:\n\n${violations.join('\n')}`
        );
    });

    test('allowlist entries still reference live lines', () => {
        // If a file shrinks or a line moves, force a re-review rather than
        // silently allowing whatever now sits on that line number.
        const stale = [];
        for (const [key] of ALLOWED) {
            const [rel, lineStr] = key.split(':');
            const full = path.join(REPO_ROOT, rel);
            if (!fs.existsSync(full)) {
                stale.push(`${key} — file no longer exists`);
                continue;
            }
            const line = fs.readFileSync(full, 'utf8').split('\n')[Number(lineStr) - 1] || '';
            if (!INLINE_STYLE_RE.test(line)) stale.push(`${key} — no inline style on that line`);
        }
        assert.deepEqual(
            stale,
            [],
            `Stale allowlist entries in architecture.inline-styles.test.js:\n${stale.map((s) => `  • ${s}`).join('\n')}`
        );
    });
});
