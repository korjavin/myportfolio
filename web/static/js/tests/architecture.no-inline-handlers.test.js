/**
 * architecture.no-inline-handlers.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test). The regex, the
 * template-literal masker, and their self-tests are carried over VERBATIM —
 * every branch in the masker exists because it closed a real bypass the
 * sibling found the hard way. Do not "simplify" it without re-deriving those
 * cases; a guard that passes on violating code is worse than no guard.
 *
 * Lint guard: asserts that no JS source under `web/static/js/` (excluding
 * `tests/` and `vendor/`) and no served `.html` contains an inline HTML event
 * handler attribute (`onclick="…"`, `onchange='…'`, …) inside a string or
 * template literal.
 *
 * Why: the served CSP has no `'unsafe-inline'` in `script-src`. Under that
 * policy browsers parse but silently DROP inline event handlers — so any
 * template that builds `<button onclick="…">…</button>` is dead UI that fails
 * only in production.
 *
 * Wire events via `addEventListener` after the node is inserted, or build the
 * node with `document.createElement`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');

// Single regex anchored on `<tagname` and looking ahead for `\son*=`
// across any number of intermediate characters (including newlines —
// negated classes match line terminators in JS regex by default). This
// catches every CSP-blocked value form:
//
//   `<button onclick="foo()">`            single-line, double-quoted
//   `<button onclick='foo()'>`            single-line, single-quoted
//   `<button onclick=foo()>`              single-line, unquoted
//   `<button onclick="">`                 single-line, empty
//   `<button\n  onclick="foo()">`         multi-line continuation
//   `<button\n  onclick=foo()>`           multi-line unquoted
//   `<button\n  ONCLICK="foo()">`         multi-line uppercase (via /i)
//   `<button title="1 > 0" onclick="">`   `>` inside a prior attr value
//
// The `<tag` anchor is what distinguishes attribute syntax from JS
// code: `const onclick = "foo"` and `obj.onclick = fn` both have
// `on*=` but no preceding `<tag`, so they don't match.
//
// The body alternation `(?:[^<>"']|"[^"]*"|'[^']*')*?` matches either
// a single non-special char OR a fully-balanced quoted attribute
// value. That lets us skip over a `>` (or `<`) inside `title="1 > 0"`
// without prematurely terminating the tag. The outer non-greedy `*?`
// keeps it bounded so it can't run past the real closing `>` into
// unrelated source.
//
// Before applying the regex we mask out template-literal `${...}`
// interpolations — a JS expression like `${count > 0 ? "x" : ""}`
// inside an HTML template would otherwise terminate the regex body
// early at the comparison `>`/`<` and let the trailing inline handler
// slip past. `maskTemplateInterpolations` replaces interpolation
// bodies with same-length whitespace (preserving newlines) so reported
// line numbers still point at the original source.
//
// The masker is JS-syntax aware: it only enters interpolation masking
// inside a real template literal (so a plain `"${"` string literal at
// the top level isn't treated as an interpolation start), and inside
// `${...}` it skips over string literals, nested template literals,
// and comments so that `}` characters appearing in their interior do
// not prematurely end the interpolation. This closes two bypasses a
// raw brace counter would otherwise have:
//   1. `${foo("}") ? "x" : ""} onclick="…"` — the `}` inside `"}"`
//      ends the brace counter early, leaking the `onclick=`.
//   2. A plain `"${"` in a regular string masking everything up to
//      some unrelated later `}`, hiding a real inline handler.
const INLINE_HANDLER_RE = /<[a-z][a-z0-9-]*(?:[^<>"']|"[^"]*"|'[^']*')*?\son[a-z]+\s*=/gi;

function maskChar(c) {
    return c === '\n' ? '\n' : ' ';
}

// Single-char heuristic for "is this position a regex literal start?".
// In JS, `/` is a regex literal when it follows an operator/punctuator or
// the start of an expression, and division when it follows a value
// (identifier, number, `)`, `]`, `` ` ``, etc.). We track the last
// non-whitespace char and consult this set. Postfix `++`/`--` (which
// produce a value) are handled explicitly so the second `+`/`-` doesn't
// leave `prevSig` as an operator — see the `++`/`--` branch below.
const REGEX_CONTEXT_CHARS = new Set([
    '(', '[', '{', ',', ';', ':', '?',
    '=', '!', '&', '|', '^', '~',
    '+', '-', '*', '/', '%',
    '<', '>',
]);

// Keyword operators and statement starters that put the *next* `/` in
// regex-literal context. The single-char REGEX_CONTEXT_CHARS heuristic
// alone misses these — after `typeof`, the previous significant char is
// `f`, which (correctly for identifiers) is not a regex-context char.
// Without this set, `${typeof /}/.test(x) && count > 0 …}` would read
// `/` as division, let `}` inside `/}/` close the interpolation early,
// and let a trailing `onclick=` slip past the scan.
const REGEX_CONTEXT_KEYWORDS = new Set([
    'typeof', 'void', 'delete', 'instanceof', 'in', 'of', 'new',
    'return', 'throw', 'yield', 'await',
    'do', 'else', 'case',
]);

// Control-flow keywords whose `(...)` is a *header*, not a value-bearing
// expression. The `)` that closes the header is a statement boundary,
// so the next `/` is a regex literal (e.g. `if (x) /pat/.test(y)`).
// Without this distinction the `)` after `if (x)` would look like a
// value-context `)` (such as `f() / 2`) and the regex's interior `}`
// or `>` could break the interpolation / tag scan.
const HEADER_KEYWORDS = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'with',
]);

// Keywords that introduce a *block* `{` (not an object literal). After
// `else`/`do`/`try`/`finally`, the next `{` opens a statement block, and
// the matching `}` is a statement boundary — the next `/` is a regex
// literal. Without this, `try {} /pat/.test(x)` would read `}` as a
// value-context terminator and misclassify `/` as division.
const BLOCK_INTRODUCER_KEYWORDS = new Set([
    'else', 'do', 'try', 'finally',
]);

// Walks past a regex literal `/pattern/flags` starting at `src[idx]`
// (where `src[idx] === '/'`). Handles `\` escapes and `[...]` character
// classes so that `/` or `}` inside them don't end the regex early.
// Regex literals cannot span lines — bail at `\n`.
function skipRegex(src, idx) {
    let j = idx + 1;
    let inClass = false;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\' && j + 1 < src.length) {
            j += 2;
        } else if (c === '[') {
            inClass = true;
            j++;
        } else if (c === ']' && inClass) {
            inClass = false;
            j++;
        } else if (c === '/' && !inClass) {
            j++;
            while (j < src.length && /[a-z]/i.test(src[j])) j++;
            return j;
        } else if (c === '\n') {
            return idx + 1;
        } else {
            j++;
        }
    }
    return j;
}

// Walks past a `${...}` interpolation that begins at `src[idx]` (i.e.
// `src[idx]==='$' && src[idx+1]==='{'`). Returns the index *after* the
// closing `}`. Handles strings, nested templates, comments, and regex
// literals so their internal braces don't break the depth counter.
function skipInterpolation(src, idx) {
    let j = idx + 2;
    let depth = 1;
    // Track the previous significant (non-whitespace) char to disambiguate
    // `/` as regex-start vs. division. Start at '{' — the opening brace
    // of the interpolation puts us at the beginning of a fresh
    // expression, which is a regex-context position.
    let prevSig = '{';
    // Track the previous identifier-or-keyword token so unary operator
    // keywords (typeof/void/delete/return/throw/yield/await/etc.) put a
    // following `/` in regex context — the single-char prevSig only
    // sees the keyword's last letter, which looks like a value.
    let prevIdent = '';
    // Stack of paren contexts so we can tell `f() / 2` (value-context `)`)
    // apart from `if (x) /pat/.test(y)` (header-context `)`, followed by
    // a regex literal). Each entry is 'header' or 'value'.
    const parenStack = [];
    // Stack of brace contexts so we can tell `if (x) {} /pat/.test(y)`
    // (block `}`, next `/` is regex) apart from `const x = {a:1} / 2`
    // (object-literal `}`, next `/` is division). Without this the `}`
    // closing a block body falls through to value-context and the
    // following `/` is misread as division — its interior `}` or `` ` ``
    // then desynchronizes the masker. Entries: 'block' or 'object'.
    const braceStack = [];
    // Set true when the *next* `{` should be classified as a block:
    // after a header `)` (e.g. `if (x) {`), or after `=>` (arrow body).
    // Cleared on `{` or on any other state-changing token so it can't
    // leak across statements.
    let nextBraceIsBlock = false;
    while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '"' || c === "'") {
            j = skipString(src, j, c);
            prevSig = c;
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '`') {
            j = skipTemplate(src, j);
            prevSig = '`';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '/' && src[j + 1] === '/') {
            while (j < src.length && src[j] !== '\n') j++;
            // Comment doesn't change prevSig/prevIdent/nextBraceIsBlock.
        } else if (c === '/' && src[j + 1] === '*') {
            j += 2;
            while (j < src.length - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
            if (j < src.length) j += 2;
            // Comment doesn't change prevSig/prevIdent/nextBraceIsBlock.
        } else if (c === '/' && (REGEX_CONTEXT_CHARS.has(prevSig) || REGEX_CONTEXT_KEYWORDS.has(prevIdent))) {
            j = skipRegex(src, j);
            prevSig = '/';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if ((c === '+' && src[j + 1] === '+') || (c === '-' && src[j + 1] === '-')) {
            // `++` / `--` is always a single token whose result is a
            // value (postfix `a++` or prefix `++a`). Without this branch
            // the second `+`/`-` lands as prevSig — an operator char in
            // REGEX_CONTEXT_CHARS — which would misclassify a following
            // `/` (in `a++ / b`) as a regex start. skipRegex would then
            // run to EOF and over-mask the trailing inline handler.
            j += 2;
            prevSig = ')'; // value-context sentinel
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '>' && prevSig === '=') {
            // Arrow function `=>` token: the next `{` opens a block
            // body, not an object literal. Without this, `() => {} / 2`
            // and `() => { stmt } /pat/.test(z)` would both treat `}`
            // as value-context and misread a following `/` as division.
            j++;
            prevSig = '>';
            prevIdent = '';
            nextBraceIsBlock = true;
        } else if (c === '(') {
            // A `(` preceded by a control-flow keyword (`if`, `while`,
            // `for`, ...) starts a header; its matching `)` is a
            // statement boundary, not a value-producing expression. We
            // remember which kind this paren is so the closing `)` can
            // set `prevSig` correctly.
            parenStack.push(HEADER_KEYWORDS.has(prevIdent) ? 'header' : 'value');
            j++;
            prevSig = '(';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === ')') {
            const ctx = parenStack.length > 0 ? parenStack.pop() : 'value';
            j++;
            // For a header `)`, leave prevSig in regex-context (`(` is
            // already in REGEX_CONTEXT_CHARS, so a following `/` reads
            // as regex). For a value `)`, set prevSig=')' so `/` reads
            // as division.
            prevSig = ctx === 'header' ? '(' : ')';
            prevIdent = '';
            // Header `)` also makes the next `{` a block body.
            nextBraceIsBlock = ctx === 'header';
        } else if (c === '{') {
            depth++;
            // A `{` is a block when it follows a header `)` (or `=>`),
            // or directly follows a block-introducer keyword like
            // `else`/`do`/`try`/`finally`. Otherwise treat as object
            // literal — its `}` is value-context.
            const isBlock = nextBraceIsBlock || BLOCK_INTRODUCER_KEYWORDS.has(prevIdent);
            braceStack.push(isBlock ? 'block' : 'object');
            j++;
            prevSig = '{';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '}') {
            depth--;
            // Only pop the braceStack for *inner* braces. The `}` that
            // takes depth from 1 to 0 closes the interpolation itself,
            // not an inner `{` — there's no matching braceStack entry.
            if (depth > 0) {
                const braceCtx = braceStack.length > 0 ? braceStack.pop() : 'object';
                // A block `}` is a statement boundary — leave prevSig
                // in regex-context (use ';' which is in
                // REGEX_CONTEXT_CHARS). An object `}` is value-context,
                // so a following `/` is division.
                prevSig = braceCtx === 'block' ? ';' : '}';
            } else {
                prevSig = '}';
            }
            j++;
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            j++;
            // Whitespace doesn't change prevSig/prevIdent/nextBraceIsBlock.
        } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
            // Consume the whole identifier so we can check the keyword
            // set for regex-context unary operators. Without this we'd
            // only see the final letter via prevSig, which would
            // misclassify the `/` after `typeof` as division.
            const start = j;
            while (j < src.length) {
                const ch = src[j];
                if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                    (ch >= '0' && ch <= '9') || ch === '_' || ch === '$') {
                    j++;
                } else {
                    break;
                }
            }
            prevIdent = src.slice(start, j);
            prevSig = src[j - 1];
            // BLOCK_INTRODUCER_KEYWORDS (else/do/try/finally) are
            // checked on the next `{` via prevIdent — don't clear
            // nextBraceIsBlock here just because an identifier appeared.
            // But clear it for any *other* identifier so the flag
            // doesn't leak across statements.
            if (!BLOCK_INTRODUCER_KEYWORDS.has(prevIdent)) {
                nextBraceIsBlock = false;
            }
        } else {
            prevSig = c;
            prevIdent = '';
            j++;
            nextBraceIsBlock = false;
        }
    }
    return j;
}

function skipString(src, idx, quote) {
    let j = idx + 1;
    while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) {
            j += 2;
        } else if (src[j] === '\n') {
            // Unterminated single-line string — bail out at line break.
            return j;
        } else {
            j++;
        }
    }
    return j < src.length ? j + 1 : j;
}

function skipTemplate(src, idx) {
    let j = idx + 1;
    while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\' && j + 1 < src.length) {
            j += 2;
        } else if (src[j] === '$' && src[j + 1] === '{') {
            j = skipInterpolation(src, j);
        } else {
            j++;
        }
    }
    return j < src.length ? j + 1 : j;
}

function maskTemplateInterpolations(src) {
    let out = '';
    let i = 0;
    // Track the previous significant char + identifier at the top level
    // so we can spot regex literals (e.g. `const re = /pat/;`). Without
    // this, a regex literal that contains a backtick — `const re = /\`/`
    // — fools the masker into treating the regex's interior `\`` as the
    // start of a template literal, which throws off interpolation
    // detection and lets a later inline handler slip past the scan.
    let prevSig = '';
    let prevIdent = '';
    // Paren-context stack so we can tell `f() / 2` (value-context `)`)
    // apart from `if (x) /pat/.test(y)` (header-context `)`, followed by
    // a regex literal). Mirrors the same logic in `skipInterpolation`:
    // without this, `prevSig=')'` after `if (x)` reads `/` as division,
    // the `` ` `` or `${` inside the unmasked regex desynchronizes the
    // template scan, and a trailing inline handler slips past the guard.
    const parenStack = [];
    // Brace-context stack — same purpose as the one in
    // `skipInterpolation`. Without this, top-level `if (x) {} /\`/.test(z)`
    // reads the block-closing `}` as value-context and misclassifies the
    // following `/` as division; the `` ` `` inside the unmasked regex
    // then fools the masker into treating it as a template-literal
    // opener, throwing off subsequent `${...}` detection so the trailing
    // inline handler slips past the scan. Entries: 'block' or 'object'.
    const braceStack = [];
    // Set true when the *next* `{` should be classified as a block: after
    // a header `)` (e.g. `if (x) {`), or after `=>` (arrow body). Cleared
    // on any other state-changing token so it can't leak across statements.
    let nextBraceIsBlock = false;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {
            // Pass regular string literals through verbatim — the scan
            // regex deliberately matches inline handlers inside them
            // (e.g. `el.innerHTML = '<button onclick="x">'`).
            const end = skipString(src, i, c);
            out += src.slice(i, end);
            i = end;
            prevSig = c;
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '/' && src[i + 1] === '/') {
            const start = i;
            while (i < src.length && src[i] !== '\n') i++;
            out += src.slice(start, i);
            // Comments don't change prevSig/prevIdent/nextBraceIsBlock.
        } else if (c === '/' && src[i + 1] === '*') {
            const start = i;
            i += 2;
            while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
            if (i < src.length) i += 2;
            out += src.slice(start, i);
        } else if (c === '/' && (prevSig === '' || REGEX_CONTEXT_CHARS.has(prevSig) || REGEX_CONTEXT_KEYWORDS.has(prevIdent))) {
            // Top-level regex literal. Mask the body to whitespace so a
            // `\`` or `${` inside the pattern can't be misread as a
            // template-literal start, and so HTML-looking patterns
            // (e.g. `/<button>/`) can't false-positive on the scan.
            const end = skipRegex(src, i);
            for (let k = i; k < end; k++) out += maskChar(src[k]);
            i = end;
            prevSig = '/';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '`') {
            // Inside a template literal: emit non-interpolation chars
            // verbatim, mask each `${...}` to same-length whitespace.
            out += c;
            i++;
            while (i < src.length && src[i] !== '`') {
                if (src[i] === '\\' && i + 1 < src.length) {
                    out += src[i] + src[i + 1];
                    i += 2;
                } else if (src[i] === '$' && src[i + 1] === '{') {
                    const end = skipInterpolation(src, i);
                    for (let k = i; k < end; k++) out += maskChar(src[k]);
                    i = end;
                } else {
                    out += src[i];
                    i++;
                }
            }
            if (i < src.length) {
                out += src[i]; // closing backtick
                i++;
            }
            prevSig = '`';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            out += c;
            i++;
            // Whitespace doesn't change prevSig/prevIdent/nextBraceIsBlock.
        } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
            const start = i;
            while (i < src.length) {
                const ch = src[i];
                if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                    (ch >= '0' && ch <= '9') || ch === '_' || ch === '$') {
                    i++;
                } else {
                    break;
                }
            }
            out += src.slice(start, i);
            prevIdent = src.slice(start, i);
            prevSig = src[i - 1];
            // BLOCK_INTRODUCER_KEYWORDS (else/do/try/finally) are
            // checked on the next `{` via prevIdent — don't clear
            // nextBraceIsBlock here just because an identifier appeared.
            if (!BLOCK_INTRODUCER_KEYWORDS.has(prevIdent)) {
                nextBraceIsBlock = false;
            }
        } else if ((c === '+' && src[i + 1] === '+') || (c === '-' && src[i + 1] === '-')) {
            // Same `++` / `--` postfix-vs-prefix handling as in
            // skipInterpolation — the result is always a value, so the
            // next `/` is division. (See note in skipInterpolation.)
            out += src[i];
            out += src[i + 1];
            i += 2;
            prevSig = ')';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '>' && prevSig === '=') {
            // Arrow function `=>` token — same handling as in
            // skipInterpolation. Next `{` opens a block body.
            out += c;
            i++;
            prevSig = '>';
            prevIdent = '';
            nextBraceIsBlock = true;
        } else if (c === '(') {
            // Remember whether this paren opens a control-flow header
            // (`if`, `while`, `for`, ...) so the matching `)` can set
            // `prevSig` to a regex-context value. Mirrors the same logic
            // in skipInterpolation.
            parenStack.push(HEADER_KEYWORDS.has(prevIdent) ? 'header' : 'value');
            out += c;
            i++;
            prevSig = '(';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === ')') {
            const ctx = parenStack.length > 0 ? parenStack.pop() : 'value';
            out += c;
            i++;
            // Header `)` is a statement boundary — leave prevSig in
            // regex-context (use '(' which is in REGEX_CONTEXT_CHARS).
            // Value `)` keeps prevSig=')' so a following `/` is division.
            prevSig = ctx === 'header' ? '(' : ')';
            prevIdent = '';
            // Header `)` also makes the next `{` a block body.
            nextBraceIsBlock = ctx === 'header';
        } else if (c === '{') {
            // Distinguish block `{` from object-literal `{` so the
            // matching `}` knows whether to leave prevSig in
            // regex-context (block — statement boundary) or
            // value-context (object — terminator of an expression).
            const isBlock = nextBraceIsBlock || BLOCK_INTRODUCER_KEYWORDS.has(prevIdent);
            braceStack.push(isBlock ? 'block' : 'object');
            out += c;
            i++;
            prevSig = '{';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else if (c === '}') {
            const braceCtx = braceStack.length > 0 ? braceStack.pop() : 'object';
            out += c;
            i++;
            // Block `}` is a statement boundary — set prevSig to a
            // regex-context char (`;` is in REGEX_CONTEXT_CHARS). Object
            // `}` keeps prevSig='}' so a following `/` reads as division.
            prevSig = braceCtx === 'block' ? ';' : '}';
            prevIdent = '';
            nextBraceIsBlock = false;
        } else {
            out += c;
            i++;
            prevSig = c;
            prevIdent = '';
            nextBraceIsBlock = false;
        }
    }
    return out;
}

// Directories under JS_ROOT to skip (relative to JS_ROOT).
const SKIP_DIRS = new Set(['tests', 'vendor']);

function collectJsFiles(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const rel = path.relative(JS_ROOT, full);
            const top = rel.split(path.sep)[0];
            if (SKIP_DIRS.has(top)) continue;
            collectJsFiles(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            acc.push(full);
        }
    }
    return acc;
}

describe('Architecture – no CSP-blocked inline event handlers', () => {
    test('no JS source file contains inline on*="…" attributes', () => {
        const files = collectJsFiles(JS_ROOT, []);
        const violations = [];

        for (const full of files) {
            const rel = path.relative(REPO_ROOT, full);
            const source = fs.readFileSync(full, 'utf8');
            const masked = maskTemplateInterpolations(source);
            const lines = source.split('\n');
            INLINE_HANDLER_RE.lastIndex = 0;
            let match;
            while ((match = INLINE_HANDLER_RE.exec(masked)) !== null) {
                // Report the line where the on*= attribute lives (end
                // of match), not the line where the `<tag` opens —
                // matters for multi-line tags. Line numbers are taken
                // from the masked source, but masking preserves
                // newlines so they match the original.
                const lineNum = masked.slice(0, match.index + match[0].length).split('\n').length;
                violations.push(`${rel}:${lineNum}: ${lines[lineNum - 1].trim()}`);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Inline HTML event handler attributes found in JS source.\n` +
                `The served CSP has no 'unsafe-inline' in script-src, so inline ` +
                `on*="…" attributes are silently dropped by the browser — any ` +
                `template that builds <button onclick="…"> is dead UI.\n\n` +
                `Wire events via addEventListener after the node is inserted ` +
                `(or build the node with document.createElement).\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });

    test('no served HTML file contains inline on*="…" attributes', () => {
        // Same CSP rule, other side of the wire. The sibling only scanned JS;
        // an onclick typed directly into index.html is just as dead.
        const staticRoot = path.join(REPO_ROOT, 'web/static');
        const htmlFiles = [];
        (function walk(dir) {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'vendor' || entry.name === 'fonts') continue;
                    walk(full);
                } else if (entry.name.endsWith('.html')) {
                    htmlFiles.push(full);
                }
            }
        })(staticRoot);

        const violations = [];
        for (const full of htmlFiles) {
            const rel = path.relative(REPO_ROOT, full);
            const source = fs.readFileSync(full, 'utf8');
            const lines = source.split('\n');
            INLINE_HANDLER_RE.lastIndex = 0;
            let match;
            while ((match = INLINE_HANDLER_RE.exec(source)) !== null) {
                const lineNum = source.slice(0, match.index + match[0].length).split('\n').length;
                violations.push(`${rel}:${lineNum}: ${lines[lineNum - 1].trim()}`);
            }
        }

        assert.deepEqual(
            violations,
            [],
            `Inline HTML event handler attributes found in served HTML:\n` +
            violations.map((v) => `  • ${v}`).join('\n')
        );
    });
});

// Self-tests for INLINE_HANDLER_RE so any future change to the regex
// (or a clever attribute form we hadn't considered) can't silently
// regress the guard's coverage.
describe('INLINE_HANDLER_RE coverage', () => {
    function matches(s) {
        INLINE_HANDLER_RE.lastIndex = 0;
        return INLINE_HANDLER_RE.test(maskTemplateInterpolations(s));
    }

    test('matches every CSP-blocked attribute form', () => {
        assert.equal(matches('<button onclick="foo()">'), true);
        assert.equal(matches("<button onclick='foo()'>"), true);
        assert.equal(matches('<button onclick=foo()>'), true);
        assert.equal(matches('<button onclick="">'), true);
        assert.equal(matches('<button\n  onclick="foo()">'), true);
        assert.equal(matches('<button\n  onclick=foo()>'), true);
        assert.equal(matches('<button\n  ONCLICK="foo()">'), true);
        // onchange/onsubmit/etc. — the regex is `on[a-z]+`, not just onclick
        assert.equal(matches('<input onchange="x()">'), true);
        assert.equal(matches('<form onsubmit="x()">'), true);
    });

    test('matches even when a prior attribute value contains > or <', () => {
        // Regression for codex finding: `[^<>]*?` stopped at the `>`
        // inside `title="1 > 0"`, letting the inline handler slip past
        // the guard.
        assert.equal(matches('<button title="1 > 0" onclick="foo()">'), true);
        assert.equal(matches("<button title='1 > 0' onclick='foo()'>"), true);
        assert.equal(matches('<a title="<x>" onclick="foo()">'), true);
    });

    test('matches when a template-literal interpolation contains > or <', () => {
        // Second codex finding: the regex body terminated early at the
        // unquoted `>`/`<` inside a `${...}` expression like
        // `${count > 0 ? "x" : ""}`. The fix masks `${...}` runs to
        // whitespace before scanning so JS comparison operators inside
        // interpolations no longer end the tag prematurely.
        assert.equal(matches('`<button ${count > 0 ? "data-x=1" : ""} onclick="foo()">`'), true);
        assert.equal(matches('`<button ${count < 10 ? "data-x=1" : ""} onclick="foo()">`'), true);
        // Nested braces inside the interpolation (object literal) — the
        // mask handles balanced braces so this is still detected.
        assert.equal(matches('`<button ${getProps({foo: 1 > 0})} onclick="x()">`'), true);
    });

    test('matches when an interpolation contains a string with a } in it', () => {
        // Third codex finding: a raw brace counter inside the masker
        // treated every `}` as structural, so a `}` inside a string
        // literal like `"}"` ended the interpolation early and let the
        // trailing inline handler slip past the scan. The fix skips
        // over string contents while tracking interpolation depth.
        assert.equal(matches('`<button ${foo("}") && count > 0 ? "data-x=1" : ""} onclick="x()">`'), true);
        assert.equal(matches("`<button ${foo('}') ? 'a' : 'b'} onclick='x()'>`"), true);
        // `}` inside a single-line comment inside the interpolation.
        assert.equal(matches('`<button ${foo() /* } */ && bar} onclick="x()">`'), true);
        // `}` inside a nested template literal inside the interpolation.
        assert.equal(matches('`<button ${`a}b`} onclick="x()">`'), true);
    });

    test('matches when an interpolation contains a regex literal with } or >', () => {
        // Fifth codex finding: the masker walked `${...}` char-by-char
        // and treated every `}` as structural, so a `}` inside a regex
        // literal like `/}/` or `/[}]/` ended the interpolation early
        // and let the rest of the JS expression (with its `>` operator)
        // terminate the outer tag regex prematurely. The fix detects
        // regex-literal context and skips the whole `/pattern/flags`.
        assert.equal(matches('`<button ${/}/.test(x) && count > 0 ? "x" : ""} onclick="foo()">`'), true);
        assert.equal(matches('`<button ${/[}]/.test(x) && count > 0 ? "x" : ""} onclick="foo()">`'), true);
        // Regex after `&&` is still in regex context.
        assert.equal(matches('`<button ${flag && /a>b/.test(x)} onclick="x()">`'), true);
        // Char class with escaped `/` and bracket content.
        assert.equal(matches('`<button ${/[a\\/}]/g.test(x) ? "" : ""} onclick="x()">`'), true);
    });

    test('matches when an interpolation starts with a unary keyword + regex', () => {
        // Sixth codex finding: REGEX_CONTEXT_CHARS only inspects the
        // single previous char, so after `typeof` the prev char is `f`
        // — looks like an identifier value, not a regex-context op.
        // That misread `/` as division and let `}` inside `/}/` close
        // the interpolation early, exposing a later `onclick=`. The fix
        // tracks the previous identifier and treats `/` after
        // typeof/void/delete/return/throw/yield/await/in/of/instanceof/
        // new/do/else/case as a regex start.
        assert.equal(matches('`<button ${typeof /}/.test(x) && count > 0 ? "x" : ""} onclick="foo()">`'), true);
        assert.equal(matches('`<button ${void /}/.test(x) && count > 0 ? "x" : ""} onclick="x()">`'), true);
        assert.equal(matches('`<button ${delete /}/.test(x) && count > 0 ? "x" : ""} onclick="x()">`'), true);
        assert.equal(matches('`<button ${return /}/.test(x)} onclick="x()">`'), true);
        assert.equal(matches('`<button ${throw /}/} onclick="x()">`'), true);
        assert.equal(matches('`<button ${yield /}/} onclick="x()">`'), true);
        assert.equal(matches('`<button ${await /}/} onclick="x()">`'), true);
    });

    test('does not over-mask a plain "${" inside a regular string literal', () => {
        // Fourth codex finding: a `${` appearing in a regular string
        // (not a template literal) was treated as an interpolation
        // start, causing the masker to consume forward to the next `}`
        // — potentially swallowing a legitimate inline handler that
        // followed. The fix scopes `${...}` masking to chars that are
        // actually inside a template literal.
        assert.equal(matches('const x = "${"; const html = "<button onclick=foo()>";'), true);
        // `${` inside a single-quoted string then a real violation.
        assert.equal(matches("const x = '${'; const y = `<button onclick='x()'>`;"), true);
        // `${` inside a line comment then a real violation.
        assert.equal(matches('// ${ never closed\nconst y = `<button onclick="x()">`;'), true);
    });

    test('matches when a top-level regex literal contains a backtick', () => {
        // Seventh codex finding: at the *top level* (outside any
        // template literal), the masker walked char-by-char without a
        // regex-literal branch. A regex like `/\`/` contains a backtick
        // that the masker then mis-read as the start of a template
        // literal, throwing off subsequent `${...}` detection so the
        // trailing inline handler's interior `>`/`<` operator
        // terminated the tag-body regex early. The fix detects regex
        // literals at the top level too and masks their interior.
        assert.equal(matches('const re = /`/; const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // Regex with `${` inside also shouldn't fool the masker.
        assert.equal(matches('const re = /\\${/; const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // Regex literal at start of file (no preceding char).
        assert.equal(matches('/`/.test(""); const html = `<button onclick="x()">`;'), true);
    });

    test('matches when a post-increment is followed by division', () => {
        // Eighth codex finding: the comment claimed `a++ / b` was
        // "vanishingly rare" and harmless, but it actually under-masks.
        // After `a++`, prevSig was `+` (an operator char), so `/` was
        // read as a regex start; skipRegex ran to EOF (no closing `/`
        // on the line), and the entire interpolation + trailing inline
        // handler got swallowed by the mask. Fix: treat `++`/`--` as a
        // single value-producing token so the next `/` is division.
        assert.equal(matches('`<button ${a++ / b} onclick="foo()">`'), true);
        assert.equal(matches('`<button ${a-- / b} onclick="foo()">`'), true);
        // Prefix increment is also a value; following `/` is still division.
        assert.equal(matches('`<button ${++a / b} onclick="foo()">`'), true);
    });

    test('matches when a control-flow header is followed by a regex', () => {
        // Ninth codex finding: in nested statement bodies like
        // `if (x) /}/.test(y)`, the `)` of `if (x)` is a statement
        // boundary (next `/` is regex), not a value-context `)`.
        // Without paren-context tracking, the `/` was read as
        // division, the `}` inside `/}/` decremented the brace counter
        // early, and the outer interpolation closed prematurely —
        // letting the trailing inline handler slip past.
        assert.equal(matches('`<button ${(() => { if (x) /}/.test(y); })() && count > 0 ? "x" : ""} onclick="foo()">`'), true);
        assert.equal(matches('`<button ${(() => { while (x) /}/.test(y); })() && count > 0 ? "x" : ""} onclick="x()">`'), true);
        assert.equal(matches('`<button ${(() => { for (;;) /}/.test(y); })() && count > 0 ? "x" : ""} onclick="x()">`'), true);
        // Regular function-call `)` is still value-context (so `f() / 2`
        // reads as division and we don't accidentally swallow a `}`).
        assert.equal(matches('`<button ${f() / 2 > 0 ? "x" : ""} onclick="foo()">`'), true);
    });

    test('matches when a top-level control-flow header is followed by a regex with a backtick', () => {
        // Tenth codex finding: the *top-level* masker had no
        // paren-context tracking, so after `if (x)` the `)` set
        // prevSig=')' (value context), the following `/` was read as
        // division, and the `` ` `` inside the regex was misread as a
        // template-literal opener. That fake template scanned forward
        // past the real template's opening backtick, leaving the real
        // `${...}` unmasked — and the `>` inside `count > 0`
        // terminated the tag-body regex early, hiding the trailing
        // inline handler. The fix mirrors `skipInterpolation`'s
        // parenStack at the top level.
        assert.equal(matches('if (x) /`/.test(y); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        assert.equal(matches('while (x) /`/.test(y); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        assert.equal(matches('for (;;) /`/.test(y); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // Regex containing `${` would also have desynchronized the scan.
        assert.equal(matches('if (x) /\\${/.test(y); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // Value-context `)` still treats following `/` as division —
        // `f() / 2` must not be misread as a regex start (which would
        // make skipRegex run forward and over-mask the trailing handler).
        assert.equal(matches('const r = f() / 2; const html = `<button onclick="x()">`;'), true);
    });

    test('matches when a regex follows a block-bodied statement at top level', () => {
        // Eleventh codex finding: `if (x) { y(); } /\`/.test(z); …` —
        // the block-closing `}` was treated as value-context, so the
        // following `/` was misread as division, the `` ` `` inside the
        // regex was misread as a template-literal opener, and the
        // trailing template's `${count > 0 ? ... }` was scanned as if
        // outside an interpolation. The `>` inside `count > 0` then
        // terminated the tag-body regex early, hiding the inline
        // handler. Fix: track block-vs-object `{` via braceStack so
        // block `}` puts the next `/` in regex context.
        assert.equal(matches('if (x) { y(); } /`/.test(z); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // Same pattern with other header keywords.
        assert.equal(matches('while (x) { y(); } /`/.test(z); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        assert.equal(matches('for (;;) { y(); } /`/.test(z); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // `else { } /pat/` — block-introducer keyword.
        assert.equal(matches('if (x) {} else { y(); } /`/.test(z); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
        // `try { } /pat/` — block-introducer keyword.
        assert.equal(matches('try { y(); } catch (e) {} /`/.test(z); const html = `<button ${count > 0 ? "x" : ""} onclick="foo()">`;'), true);
    });

    test('matches when a regex follows a block-bodied statement inside an interpolation', () => {
        // Twelfth codex finding: inside `${...}`, the same block-`}`
        // misclassification was present. `${(() => { if (x) {} /}/.test(y); })()…}`
        // had its inner `}` (closing the empty block) treated as
        // value-context, so `/}/` was read as division, the regex's
        // interior `}` decremented the interpolation depth early, and
        // the rest of the expression — including the outer template's
        // `count > 0` — leaked outside the mask. Fix: braceStack inside
        // skipInterpolation distinguishes block `}` from object `}`.
        assert.equal(matches('`<button ${(() => { if (x) {} /}/.test(y); })() && count > 0 ? "x" : ""} onclick="foo()">`'), true);
        // Arrow body `=>` followed by block also handled.
        assert.equal(matches('`<button ${(() => { /}/.test(y); })() && count > 0 ? "x" : ""} onclick="x()">`'), true);
        // Block-introducer `try` inside the interpolation.
        assert.equal(matches('`<button ${(() => { try {} catch(e) {} /}/.test(y); })() && count > 0 ? "x" : ""} onclick="x()">`'), true);
    });

    test('does not over-mask an object literal followed by division', () => {
        // Guard against the block-tracking change accidentally
        // reclassifying an object-literal `}` as a statement boundary.
        // `{a: 1} / 2` is real (if unusual) arithmetic; the `}` ends an
        // object and the `/` is division. Mis-treating it as a regex
        // start would let skipRegex over-consume to the next `/` on the
        // line, potentially hiding a trailing inline handler.
        assert.equal(matches('const x = {a: 1} / 2 / b; const html = "<button onclick=foo()>";'), true);
        // Object literal inside an interpolation, followed by division.
        assert.equal(matches('`<button ${({a: 1}).a / 2} onclick="x()">`'), true);
    });

    test('does not match JS code that happens to contain on*=', () => {
        // No preceding `<tag`, so these are not HTML attributes.
        assert.equal(matches('const onclick = "foo"'), false);
        assert.equal(matches('obj.onclick = fn'), false);
        assert.equal(matches('el.addEventListener("click", fn)'), false);
    });

    test('does not match tags without an on*= attribute', () => {
        assert.equal(matches('<button class="x">'), false);
        assert.equal(matches('<button title="1 > 0" id="x">'), false);
    });
});
