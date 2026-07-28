/**
 * architecture.wg-primitives.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test).
 *
 * Asserts the Wandergeek material primitives are present in styles.css and
 * contain no hardcoded hex colors — every visual value must resolve through a
 * --wg-* token. rgba()/hsla()/var() are fine; hex literals are not, because a
 * hex literal is a color that escaped the palette.
 *
 * Also pins the two layout conventions that the sibling project learned the
 * hard way and that docs/ARCHITECTURE.md §9 carries over verbatim:
 *   - no floating FAB and no bottom CTA dock (primary actions are inline
 *     .wg-toolbar-btn--primary pills in the toolbar row);
 *   - no section-header banners (the active bottom-nav pill is the indicator).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

const REQUIRED_CLASSES = [
    '.wg-stage',
    '.wg-screen-stage',
    '.wg-card',
    '.wg-card--inset',
    '.wg-gloss',
    '.wg-gloss--sun',
    '.wg-gloss--clay',
    '.wg-gloss--inset',
    '.wg-gloss--lg',
    '.wg-toolbar-btn',
    '.wg-toolbar-btn--primary',
    '.wg-toolbar-btn--secondary',
    '.wg-icon-btn',
    '.wg-tag',
    '.wg-tag--normal',
    '.wg-tag--high',
    '.wg-tag--alert',
    '.wg-tag--mono',
    '.wg-delta',
    '.wg-delta--gain',
    '.wg-delta--loss',
    '.wg-delta--flat',
    '.wg-section-label',
    '.wg-mono-display',
    '.wg-muted',
    '.wg-muted-strong',
    '.wg-modal',
    '.wg-modal__title',
    '.wg-modal__body',
    '.wg-modal__actions',
    '.wg-field',
    '.wg-label',
    '.wg-input',
    '.wg-select',
];

const css = fs.readFileSync(CSS_PATH, 'utf8');

/**
 * Extract the block body `{ ... }` for a CSS selector (simple rule match).
 * Returns every occurrence of `selector { ... }`.
 */
function extractClassBlocks(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s,{}>+~])${escaped}\\s*\\{([^}]+)\\}`, 'g');
    const blocks = [];
    let m;
    while ((m = re.exec(source)) !== null) blocks.push(m[2]);
    return blocks;
}

describe('Wandergeek material primitives', () => {
    for (const cls of REQUIRED_CLASSES) {
        test(`defines ${cls} in styles.css`, () => {
            assert.ok(
                extractClassBlocks(css, cls).length > 0,
                `expected at least one rule for ${cls}`
            );
        });
    }

    for (const cls of REQUIRED_CLASSES) {
        test(`${cls} contains no hex literal`, () => {
            for (const body of extractClassBlocks(css, cls)) {
                const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g);
                assert.equal(hex, null, `hex literal found in ${cls}: ${hex}`);
            }
        });
    }

    test('puts .wg-* class blocks after the --wg-* token block', () => {
        const tokenStart = css.indexOf('--wg-paper:');
        const firstClass = css.search(/^\s*\.wg-stage\s*\{/m);
        assert.ok(tokenStart > -1, 'no --wg-paper token found');
        assert.ok(firstClass > tokenStart, '.wg-stage must be defined after the token block');
    });

    test('gloss button references the gradient token, not a raw linear-gradient()', () => {
        const blocks = extractClassBlocks(css, '.wg-gloss');
        assert.ok(blocks.length > 0);
        const base = blocks[0];
        assert.match(base, /background:\s*var\(--wg-gloss-bg\)/);
        assert.match(base, /box-shadow:\s*var\(--wg-gloss-shadow\)/);
    });

    test('status tag modifiers pull color + bg + border from tokens', () => {
        for (const variant of ['normal', 'high', 'alert']) {
            const blocks = extractClassBlocks(css, `.wg-tag--${variant}`);
            assert.ok(blocks.length > 0, `.wg-tag--${variant} missing`);
            const body = blocks[0];
            assert.match(body, new RegExp(`background:\\s*var\\(--wg-tag-${variant}-bg\\)`));
            assert.match(body, new RegExp(`color:\\s*var\\(--wg-tag-${variant}-fg\\)`));
            assert.match(body, new RegExp(`border-color:\\s*var\\(--wg-tag-${variant}-border\\)`));
        }
    });

    test('delta modifiers pull color + bg + border from the delta triplets', () => {
        for (const variant of ['gain', 'loss', 'flat']) {
            const blocks = extractClassBlocks(css, `.wg-delta--${variant}`);
            assert.ok(blocks.length > 0, `.wg-delta--${variant} missing`);
            const body = blocks[0];
            assert.match(body, new RegExp(`background:\\s*var\\(--wg-${variant}-bg\\)`));
            assert.match(body, new RegExp(`color:\\s*var\\(--wg-${variant}-fg\\)`));
            assert.match(body, new RegExp(`border-color:\\s*var\\(--wg-${variant}-border\\)`));
        }
    });

    test('every delta modifier emits a sign glyph — gain/loss is never encoded by color alone', () => {
        // Red/green-only is the most common accessibility failure in finance
        // UIs; it fails for roughly 1 in 12 men. The ::before glyph makes the
        // sign structural so a screen author cannot forget it. Deleting this
        // rule to "clean up" the CSS is the regression this test exists for.
        for (const variant of ['gain', 'loss', 'flat']) {
            const blocks = extractClassBlocks(css, `.wg-delta--${variant}::before`);
            assert.ok(
                blocks.length > 0,
                `.wg-delta--${variant}::before missing — the sign glyph is not optional`
            );
            assert.match(
                blocks[0],
                /content:\s*'[^']+'/,
                `.wg-delta--${variant}::before must set a non-empty content glyph`
            );
        }
    });

    test('section label uses the sun token for its accent dot', () => {
        const blocks = extractClassBlocks(css, '.wg-section-label::before');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /background:\s*var\(--wg-sun\)/);
    });

    test('bottom nav anchors to the viewport via position:fixed', () => {
        const blocks = extractClassBlocks(css, '.wg-bottom-nav');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /position:\s*fixed\b/);
    });

    test('bottom nav grid reads its column count from --wg-nav-cols', () => {
        const blocks = extractClassBlocks(css, '.wg-bottom-nav__inner');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /grid-template-columns:\s*repeat\(var\(--wg-nav-cols/);
    });

    test('#app reserves bottom space for the fixed nav via --wg-bottom-nav-reserved', () => {
        const blocks = extractClassBlocks(css, '#app');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /padding-bottom:\s*var\(--wg-bottom-nav-reserved\)/);
    });

    test('screen stage utility pulls --wg-bg-stage', () => {
        const blocks = extractClassBlocks(css, '.wg-screen-stage');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /background:[\s\S]*var\(--wg-bg-stage\)/);
        assert.doesNotMatch(blocks[0], /#[0-9a-fA-F]{3,8}\b/);
    });

    test('primary actions are inline toolbar pills — no FAB, no CTA dock, no section-header banner', () => {
        // The sibling project shipped a floating FAB and a sticky bottom CTA
        // dock, then retired both; and it removed section-header banners in
        // favour of the active nav pill as the sole screen indicator. Porting
        // the CSS without porting these deletions would reintroduce them.
        for (const retired of ['.wg-fab', '.wg-cta-dock', '.section-header']) {
            assert.equal(
                extractClassBlocks(css, retired).length,
                0,
                `${retired} is retired — primary actions render inline as .wg-toolbar-btn--primary, ` +
                `and screens sit directly on the stage with no header banner.`
            );
        }
    });

    test('.wg-toolbar-btn owns sizing; the --primary variant is color-only', () => {
        const base = extractClassBlocks(css, '.wg-toolbar-btn')[0];
        assert.ok(base, '.wg-toolbar-btn missing');
        assert.match(base, /min-height:\s*var\(--wg-toolbar-btn-height\)/);

        const primary = extractClassBlocks(css, '.wg-toolbar-btn--primary')[0];
        assert.ok(primary, '.wg-toolbar-btn--primary missing');
        assert.match(primary, /background:\s*var\(--wg-gloss-bg-sun\)/);
        // Color-only: the variant must not re-declare sizing.
        assert.doesNotMatch(primary, /(^|\s)(min-height|height|padding)\s*:/);
    });

    test('.wg-modal carries card-like background pulling --wg-bg-card and uses z-modal', () => {
        const body = extractClassBlocks(css, '.wg-modal')[0];
        assert.ok(body);
        assert.match(body, /position:\s*fixed\b/);
        assert.match(body, /background:[\s\S]*var\(--wg-bg-card\)/);
        assert.match(body, /border-radius:\s*var\(--wg-radius-card\)/);
        assert.match(body, /z-index:\s*var\(--z-modal\)/);
    });

    test('.wg-modal__title uses the mono display family', () => {
        const blocks = extractClassBlocks(css, '.wg-modal__title');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /font-family:\s*var\(--wg-font-mono\)/);
    });

    test('.wg-input pulls background/border/color from --wg-* tokens', () => {
        const body = extractClassBlocks(css, '.wg-input')[0];
        assert.ok(body);
        assert.match(body, /background:\s*var\(--wg-bg-card-inset\)/);
        assert.match(body, /color:\s*var\(--wg-fg-1\)/);
        assert.match(body, /border:[\s\S]*var\(--wg-border-hairline\)/);
    });

    test('.wg-label uses the --wg-fg-3 quiet-text token (AA on the teal stage)', () => {
        const blocks = extractClassBlocks(css, '.wg-label');
        assert.ok(blocks.length > 0);
        assert.match(blocks[0], /color:\s*var\(--wg-fg-3\)/);
    });
});
