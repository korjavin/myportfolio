/**
 * architecture.design-tokens.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test). See
 * docs/ARCHITECTURE.md §9 — porting the enforcement is the point of the
 * exercise, not just the CSS. A design system without its guard tests
 * degrades to suggestions within a month.
 *
 * Pins:
 *   1. Every registered token exists in :root.
 *   2. No hardcoded hex colors outside :root.
 *   3. No hardcoded px in spacing/radius/shadow/font-size/z-index props.
 *   4. No --wg-* token is referenced from JS (narrow structural allowlist).
 *   5. No inline .style.<prop> assignments or style= attributes in JS/HTML.
 *   6. The utility/primitive class vocabulary is present.
 *
 * ADDING A TOKEN: append it to WANDERGEEK_TOKENS (or REQUIRED_TOKENS) in the
 * SAME commit that introduces it. That is the whole registry discipline.
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
const JS_DIR = path.join(REPO_ROOT, 'web/static/js');
const STATIC_DIR = path.join(REPO_ROOT, 'web/static');

/** Extract the first :root { ... } block from the CSS source. */
function extractRootBlock(css) {
    const match = css.match(/:root\s*\{([^}]+)\}/);
    return match ? match[1] : '';
}

/** Extract all custom property names (--foo) from a CSS block. */
function extractCustomProperties(block) {
    const props = new Set();
    const re = /(--[\w-]+)\s*:/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        props.add(m[1]);
    }
    return props;
}

/** Generic (non-Wandergeek) tokens that must exist in :root. */
const REQUIRED_TOKENS = [
    // Neutral surface aliases (the sibling's Telegram theme mirrors; this app
    // has no Telegram host so they resolve onto the Wandergeek palette).
    '--bg-color',
    '--text-color',
    '--hint-color',
    '--secondary-bg-color',
    // Semantic colors
    '--color-success',
    '--color-warning',
    '--color-danger',
    '--color-info',
    '--color-overlay',
    '--color-overlay-light',
    '--color-status-pending-bg-start',
    '--color-status-pending-text',
    // Spacing
    '--space-xs',
    '--space-sm',
    '--space-md',
    '--space-lg',
    '--space-xl',
    '--space-2xl',
    // Radius
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--radius-pill',
    // Shadow
    '--shadow-sm',
    '--shadow-md',
    '--shadow-lg',
    // Typography
    '--font-size-xs',
    '--font-size-sm',
    '--font-size-md',
    '--font-size-lg',
    '--font-size-xl',
    '--font-weight-normal',
    '--font-weight-medium',
    '--font-weight-bold',
    // Z-index
    '--z-dropdown',
    '--z-overlay',
    '--z-modal',
    '--z-popover',
    '--z-confirm',
    '--z-toast',
];

/**
 * The authoritative Wandergeek token registry. Grouped exactly as
 * docs/ARCHITECTURE.md §9 describes the port.
 */
const WANDERGEEK_TOKENS = [
    // — Palette (raw color primitives)
    '--wg-paper',
    '--wg-paper-deep',
    '--wg-paper-soft',
    '--wg-ink',
    '--wg-ink-85',
    '--wg-ink-70',
    '--wg-ink-55',
    '--wg-ink-35',
    '--wg-ink-15',
    '--wg-ink-08',
    '--wg-teal',
    '--wg-teal-stage',
    '--wg-teal-sage',
    '--wg-mint',
    '--wg-mint-soft',
    '--wg-sun',
    '--wg-sun-deep',
    '--wg-sun-soft',
    '--wg-clay',
    '--wg-clay-soft',
    // — Semantic aliases
    '--wg-bg-stage',
    '--wg-bg-card',
    '--wg-bg-card-inset',
    '--wg-fg-1',
    '--wg-fg-2',
    '--wg-fg-3',
    '--wg-fg-4',
    '--wg-fg-5',
    '--wg-border-hairline',
    '--wg-border-strong',
    // — Status tag triplets
    '--wg-tag-normal-bg',
    '--wg-tag-normal-fg',
    '--wg-tag-normal-border',
    '--wg-tag-high-bg',
    '--wg-tag-high-fg',
    '--wg-tag-high-border',
    '--wg-tag-alert-bg',
    '--wg-tag-alert-fg',
    '--wg-tag-alert-border',
    // — Delta triplets (gain / loss / flat) — this app's most-repeated signal
    '--wg-gain-bg',
    '--wg-gain-fg',
    '--wg-gain-border',
    '--wg-loss-bg',
    '--wg-loss-fg',
    '--wg-loss-border',
    '--wg-flat-bg',
    '--wg-flat-fg',
    '--wg-flat-border',
    // — Typography
    '--wg-font-display',
    '--wg-font-ui',
    '--wg-font-mono',
    // — Gloss material
    '--wg-gloss-bg',
    '--wg-gloss-bg-sun',
    '--wg-gloss-bg-clay',
    '--wg-gloss-bg-inset',
    '--wg-gloss-shadow',
    '--wg-gloss-shadow-sun',
    '--wg-gloss-shadow-inset',
    // — Dimensional
    '--wg-radius-gloss',
    '--wg-radius-icon',
    '--wg-radius-card',
    '--wg-radius-pill',
    '--wg-card-pad',
    '--wg-icon-btn-size',
    '--wg-font-size-tag',
    '--wg-font-size-mini',
    '--wg-font-size-caps',
    '--wg-font-size-metric-value',
    '--wg-section-label-pad-top',
    '--wg-section-label-gap',
    '--wg-toolbar-btn-height',
    // — Phone chrome
    '--wg-phone-pad',
    '--wg-phone-radius',
    '--wg-phone-screen-radius',
    '--wg-phone-shadow',
    '--wg-dynamic-island-radius',
    '--wg-status-bar-pad-bottom',
    '--wg-status-bar-font-size',
    // — Bottom nav
    '--wg-bottom-nav-pad-top',
    '--wg-bottom-nav-pad-x',
    '--wg-bottom-nav-pad-bottom',
    '--wg-bottom-nav-inner-radius',
    '--wg-bottom-nav-inner-pad',
    '--wg-bottom-nav-gap',
    '--wg-nav-item-radius',
    '--wg-nav-item-pad-y',
    '--wg-nav-item-pad-x',
    '--wg-nav-item-gap',
    '--wg-nav-item-font-size',
    '--wg-nav-icon-size',
    '--wg-bottom-nav-z',
    '--wg-bottom-nav-reserved',
    // — Toggle primitive
    '--wg-toggle-width',
    '--wg-toggle-height',
    '--wg-toggle-knob-size',
    '--wg-toggle-knob-pad',
    '--wg-toggle-bg',
    '--wg-toggle-bg-on',
    '--wg-toggle-knob',
    '--wg-toggle-knob-on',
    '--wg-toggle-border',
    '--wg-toggle-border-focus',
    '--wg-toggle-border-disabled',
    // — Shared chart theme
    '--wg-chart-card-bg',
    '--wg-chart-card-border',
    '--wg-chart-card-radius',
    '--wg-chart-card-pad',
    '--wg-chart-guide-stroke',
    '--wg-chart-guide-stroke-width',
    '--wg-chart-guide-dasharray',
    '--wg-chart-axis-tick-color',
    '--wg-chart-axis-tick-size',
    '--wg-chart-gain-stroke',
    '--wg-chart-loss-stroke',
    '--wg-chart-neutral-stroke',
    '--wg-chart-series-stroke-width',
    '--wg-chart-area-opacity',
];

/**
 * Every medication-domain token group that must NOT reappear. The port
 * deliberately left these behind (docs/ARCHITECTURE.md §9 "Drop"); this
 * pins that decision so a future copy-paste from the sibling can't drag
 * another app's screens back in.
 */
const FORBIDDEN_TOKEN_PREFIXES = [
    '--wg-bp-',
    '--wg-food-',
    '--wg-meds-',
    '--wg-med-',
    '--wg-health-',
    '--wg-workouts-',
    '--wg-weight-',
    '--wg-settings-',
    '--wg-next-',
    '--wg-ring-stack',
    '--wg-macro-',
    '--wg-streak-',
    '--wg-fuel-',
];

/** Collect .js files under a directory, skipping tests/ and vendor/. */
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

/**
 * Blank out /* … *​/ comment bodies, preserving newlines so line numbers still
 * line up. Scanners that look for forbidden strings must ignore comments —
 * otherwise the doc comment *explaining* the rule trips the rule.
 */
function stripCssComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function collectFilesByExt(dir, exts, base = '') {
    if (!fs.existsSync(dir)) return [];
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name === 'vendor' || entry.name === 'fonts') continue;
            files = files.concat(collectFilesByExt(path.join(dir, entry.name), exts, rel));
        } else if (exts.some((e) => entry.name.endsWith(e))) {
            files.push(rel);
        }
    }
    return files;
}

describe('Architecture – design tokens', () => {
    test(':root block contains all required generic design tokens', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);
        assert.notEqual(rootBlock, '', 'no :root block found in styles.css');

        const defined = extractCustomProperties(rootBlock);
        const missing = REQUIRED_TOKENS.filter((t) => !defined.has(t));
        assert.deepEqual(
            missing,
            [],
            `Missing design tokens in :root block of styles.css:\n${missing.map((t) => `  • ${t}`).join('\n')}`
        );
    });

    test('no hardcoded hex colors outside :root (except allowlisted fallbacks)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const lines = css.split('\n');
        let insideRoot = false;
        let braceDepth = 0;

        const hexColorRe = /#(?:[0-9a-fA-F]{3,8})\b/g;
        const varFallbackRe = /var\([^)]*#[0-9a-fA-F]{3,8}/;
        // Generic white/black keywords-as-hex are fine — they are not brand colors.
        const allowlistedHex = new Set(['#fff', '#ffffff', '#000', '#000000']);

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            if (/^:root\s*\{/.test(line.trim())) {
                insideRoot = true;
                braceDepth = 1;
                continue;
            }
            if (insideRoot) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= 0) insideRoot = false;
                continue;
            }

            // Skip selector lines containing # (e.g. `#app {`)
            if (/^\s*[#.\w[\]:>~+,\s-]+\s*[,{]?\s*$/.test(line) && !line.includes(':')) continue;

            const matches = line.match(hexColorRe);
            if (!matches) continue;

            if (varFallbackRe.test(line)) {
                const withoutFallbacks = line.replace(/var\([^)]*\)/g, '');
                const remaining = withoutFallbacks.match(hexColorRe);
                if (!remaining) continue;
                const real = remaining.filter((h) => !allowlistedHex.has(h.toLowerCase()));
                if (real.length > 0) violations.push(`  L${lineNum}: ${real.join(', ')} — ${line.trim()}`);
                continue;
            }

            const real = matches.filter((h) => !allowlistedHex.has(h.toLowerCase()));
            if (real.length > 0) violations.push(`  L${lineNum}: ${real.join(', ')} — ${line.trim()}`);
        }

        assert.deepEqual(
            violations,
            [],
            `Found ${violations.length} lines with hardcoded hex colors outside :root:\n\n${violations.join('\n')}\n\n` +
            `Replace these with CSS custom property tokens (var(--token-name)).`
        );
    });

    test('no hardcoded px values in spacing/radius/shadow/font-size/z-index properties outside :root', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const lines = css.split('\n');

        let insideRoot = false;
        let braceDepth = 0;

        const spacingPropRe = /^\s*(padding|padding-(top|right|bottom|left)|margin|margin-(top|right|bottom|left)|gap)\s*:/i;
        const radiusPropRe = /^\s*border-radius\s*:/i;
        const shadowPropRe = /^\s*box-shadow\s*:/i;
        const fontSizePropRe = /^\s*font-size\s*:/i;
        const zIndexPropRe = /^\s*z-index\s*:/i;

        const hardcodedPxRe = /(?<!\w)(\d+)px\b/g;

        // Values with no matching token, or below the token ladder's floor.
        const spacingAllowlist = new Set([0, 1, 2, 3, 5, 7, 28, 40, 80, 90, 100, 120, 200, 250, 400]);
        const radiusAllowlist = new Set([0, 2]);
        const fontSizeAllowlist = new Set([0, 48]);
        const zIndexAllowlist = new Set([0, 10, 1003, 1200]);

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            if (/^:root\s*\{/.test(line.trim())) {
                insideRoot = true;
                braceDepth = 1;
                continue;
            }
            if (insideRoot) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= 0) insideRoot = false;
                continue;
            }

            if (/var\(--/.test(line)) {
                const withoutVars = line.replace(/var\([^)]*\)/g, '');
                hardcodedPxRe.lastIndex = 0;
                if (!hardcodedPxRe.test(withoutVars)) continue;
                hardcodedPxRe.lastIndex = 0;
            }

            if (/^\s*\/?\*/.test(line) || /^\s*\/\//.test(line)) continue;

            let propType = null;
            let allowlist = null;
            if (spacingPropRe.test(line)) {
                propType = 'spacing';
                allowlist = spacingAllowlist;
            } else if (radiusPropRe.test(line)) {
                propType = 'border-radius';
                allowlist = radiusAllowlist;
            } else if (shadowPropRe.test(line)) {
                propType = 'box-shadow';
            } else if (fontSizePropRe.test(line)) {
                propType = 'font-size';
                allowlist = fontSizeAllowlist;
            } else if (zIndexPropRe.test(line)) {
                propType = 'z-index';
                allowlist = zIndexAllowlist;
            }
            if (!propType) continue;

            if (propType === 'z-index') {
                const zMatch = line.match(/z-index\s*:\s*(\d+)/);
                if (zMatch && !allowlist.has(parseInt(zMatch[1], 10)) && !line.includes('var(')) {
                    violations.push(`  L${lineNum} [z-index]: ${line.trim()}`);
                }
                continue;
            }

            if (propType === 'box-shadow') {
                if (!line.includes('var(') && /\d+px/.test(line) && line.trim() !== 'box-shadow: none;') {
                    // Colored shadows (rgba with non-zero channels) are design-specific.
                    const rgbaMatch = line.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
                    if (rgbaMatch && (Number(rgbaMatch[1]) > 0 || Number(rgbaMatch[2]) > 0 || Number(rgbaMatch[3]) > 0)) {
                        continue;
                    }
                    violations.push(`  L${lineNum} [box-shadow]: ${line.trim()}`);
                }
                continue;
            }

            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const valuePart = line.slice(colonIdx + 1).replace(/var\([^)]*\)/g, '');
            const matches = [...valuePart.matchAll(hardcodedPxRe)];
            const bad = matches.filter((m) => !allowlist.has(parseInt(m[1], 10)));
            if (bad.length > 0) {
                violations.push(`  L${lineNum} [${propType}]: ${line.trim()}`);
            }
        }

        assert.deepEqual(
            violations,
            [],
            `Found ${violations.length} lines with hardcoded values that should use design tokens:\n\n${violations.join('\n')}\n\n` +
            `Replace these with CSS custom property tokens (e.g. var(--space-lg), var(--radius-md)).`
        );
    });

    test('utility and primitive CSS classes are defined in styles.css', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const requiredClasses = [
            // Utilities
            '.flex-row', '.flex-col', '.flex-center', '.flex-between', '.flex-1', '.flex-wrap',
            '.items-start', '.text-center', '.text-hint', '.text-muted',
            '.text-danger', '.text-error', '.text-success', '.text-xs', '.text-sm',
            '.cursor-pointer', '.gap-sm', '.gap-md', '.gap-xl',
            '.mb-xs', '.mb-sm', '.mb-md', '.mb-lg',
            '.mt-xs', '.mt-sm', '.mt-md', '.mt-lg', '.mt-xl',
            '.m-0', '.fw-medium', '.w-full', '.hidden', '.list-reset',
            // Empty / error state
            '.empty-state-msg', '.no-data-msg',
            // Stat cell
            '.stat-item', '.stat-label', '.stat-value',
            // Row actions + sync badges
            '.icon-action-btn', '.modal-action-btn',
            '.sync-pending-badge', '.sync-rejected-badge',
            // Settings row (mt-setting-toggle)
            '.wg-settings-row', '.wg-settings-row__content',
            '.wg-settings-row__title', '.wg-settings-row__desc', '.wg-settings-row__control',
            // Primitives
            '.wg-stage', '.wg-screen-stage', '.wg-card', '.wg-card--inset',
            '.wg-gloss', '.wg-gloss--sun', '.wg-gloss--clay', '.wg-gloss--inset', '.wg-gloss--lg',
            '.wg-toolbar-btn', '.wg-toolbar-btn--primary', '.wg-toolbar-btn--secondary',
            '.wg-icon-btn',
            '.wg-modal', '.wg-modal__header', '.wg-modal__title', '.wg-modal__body', '.wg-modal__actions',
            '.wg-field', '.wg-field--row', '.wg-label', '.wg-input', '.wg-select',
            '.wg-tag', '.wg-tag--normal', '.wg-tag--high', '.wg-tag--alert', '.wg-tag--mono', '.wg-tag--sun',
            '.wg-delta', '.wg-delta--gain', '.wg-delta--loss', '.wg-delta--flat', '.wg-delta--bare',
            '.wg-section-label', '.wg-mono-display', '.wg-muted', '.wg-muted-strong',
            // Phone chrome
            '.wg-phone', '.wg-phone-screen', '.wg-phone-screen__content',
            '.wg-dynamic-island', '.wg-status-bar', '.wg-status-bar__icons', '.wg-home-indicator',
            // Bottom nav
            '.wg-bottom-nav', '.wg-bottom-nav__inner', '.wg-nav-item', '.wg-nav-item--active',
            // Sparkline
            '.wg-sparkline', '.wg-spark', '.wg-spark-fill', '.wg-spark-tail',
            // Ring
            '.wg-ring', '.wg-ring__track', '.wg-ring__progress', '.wg-ring__check',
            // Stale badge
            '.wg-stale-badge', '.wg-stale-badge--neutral', '.wg-stale-badge--warning',
            // Toggle
            '.wg-toggle', '.wg-toggle__input', '.wg-toggle__track', '.wg-toggle__knob', '.wg-toggle--disabled',
            // Chart theme consumers
            '.wg-chart-card', '.wg-chart__guide', '.wg-chart__axis-tick', '.wg-chart__series',
        ];

        const missing = requiredClasses.filter((cls) => {
            const escaped = cls.replace(/\./g, '\\.');
            const re = new RegExp(`(?:^|[,\\s])${escaped}(?:[\\s,.:{[>~+]|$)`, 'm');
            return !re.test(css);
        });

        assert.deepEqual(
            missing,
            [],
            `Missing utility/primitive CSS classes in styles.css:\n${missing.map((c) => `  • ${c}`).join('\n')}`
        );
    });
});

describe('Architecture – Wandergeek tokens', () => {
    test(':root block contains every registered --wg-* token', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);
        assert.notEqual(rootBlock, '');

        const defined = extractCustomProperties(rootBlock);
        const missing = WANDERGEEK_TOKENS.filter((t) => !defined.has(t));
        assert.deepEqual(
            missing,
            [],
            `Missing Wandergeek tokens in :root:\n${missing.map((t) => `  • ${t}`).join('\n')}\n\n` +
            `Add them under the "Wandergeek Design System" comment block.`
        );
    });

    test('every --wg-* token defined in :root is registered in WANDERGEEK_TOKENS', () => {
        // The converse of the check above: an unregistered token means someone
        // added a token without touching the registry, which is exactly the
        // drift this whole test file exists to prevent.
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const defined = [...extractCustomProperties(extractRootBlock(css))].filter((t) => t.startsWith('--wg-'));
        const registered = new Set(WANDERGEEK_TOKENS);
        const unregistered = defined.filter((t) => !registered.has(t));
        assert.deepEqual(
            unregistered,
            [],
            `Unregistered --wg-* tokens in :root:\n${unregistered.map((t) => `  • ${t}`).join('\n')}\n\n` +
            `Every new token must be added to WANDERGEEK_TOKENS in the same commit that introduces it.`
        );
    });

    test('no medication-domain token group survives the port', () => {
        // Comments are stripped: the file header legitimately *names* these
        // groups to record that they were dropped.
        const css = stripCssComments(fs.readFileSync(CSS_PATH, 'utf8'));
        const offenders = [];
        for (const prefix of FORBIDDEN_TOKEN_PREFIXES) {
            if (css.includes(prefix)) offenders.push(prefix);
        }
        assert.deepEqual(
            offenders,
            [],
            `Medication-domain tokens reappeared in styles.css: ${offenders.join(', ')}\n` +
            `docs/ARCHITECTURE.md §9 drops these — do not copy the sibling's styles.css wholesale.`
        );
    });

    test('delta tokens alias the shared tag triplets (no new hue enters the palette)', () => {
        // Gain/loss is this app's most-repeated signal. It must resolve back to
        // the ported tag palette, exactly the way the sibling's --wg-bp-status-*
        // layer wrapped the same triplets, so nobody introduces a fresh red/green.
        const root = extractRootBlock(fs.readFileSync(CSS_PATH, 'utf8'));
        const expected = {
            '--wg-gain-bg': '--wg-tag-normal-bg',
            '--wg-gain-fg': '--wg-tag-normal-fg',
            '--wg-gain-border': '--wg-tag-normal-border',
            '--wg-loss-bg': '--wg-tag-alert-bg',
            '--wg-loss-fg': '--wg-tag-alert-fg',
            '--wg-loss-border': '--wg-tag-alert-border',
        };
        for (const [token, target] of Object.entries(expected)) {
            const re = new RegExp(`${token}\\s*:\\s*var\\(${target}\\)`);
            assert.match(
                root,
                re,
                `${token} must resolve to var(${target}) — delta colors alias the tag palette, they do not introduce a new hue.`
            );
        }
    });

    test('no --wg-* tokens are referenced from JS source files (except structural allowlist)', () => {
        // Structural variables (not visual values) are allowed on a per-file,
        // per-token basis. Visual tokens (colors, gradients, shadows, spacing)
        // stay CSS-only: JS sets *class names*, CSS resolves values.
        //
        // --wg-nav-cols in wg-bottom-nav.js: items.length determines the grid's
        //   column count. A structural integer, not a visual value.
        const ALLOWED_JS_TOKEN_REFS = {
            'web/static/js/components/wg-bottom-nav.js': new Set(['--wg-nav-cols']),
        };

        const offenders = [];
        for (const rel of collectJsFiles(JS_DIR)) {
            const full = path.join(JS_DIR, rel);
            const repoRel = path.relative(REPO_ROOT, full);
            const allowed = ALLOWED_JS_TOKEN_REFS[repoRel] || new Set();
            const lines = fs.readFileSync(full, 'utf8').split('\n');
            lines.forEach((line, i) => {
                const matches = line.match(/--wg-[a-z0-9-]+/gi);
                if (!matches) return;
                for (const m of matches) {
                    if (!allowed.has(m)) {
                        offenders.push(`  • ${repoRel}:${i + 1}: ${line.trim()}`);
                        return;
                    }
                }
            });
        }

        assert.deepEqual(
            offenders,
            [],
            `Wandergeek --wg-* tokens are CSS-only; found JS references:\n\n${offenders.join('\n')}\n\n` +
            `Move the color/gradient logic into a CSS class and reference the class from JS instead.`
        );
    });

    test('no inline style= attributes in HTML strings inside JS files', () => {
        const offenders = [];
        for (const rel of collectJsFiles(JS_DIR)) {
            const lines = fs.readFileSync(path.join(JS_DIR, rel), 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) return;
                if (/\sstyle\s*=\s*["'`]/.test(line)) {
                    offenders.push(`  • web/static/js/${rel}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        assert.deepEqual(offenders, [], `Inline style= attributes in JS templates:\n\n${offenders.join('\n')}`);
    });

    test('no inline style= attributes in served HTML', () => {
        const offenders = [];
        for (const rel of collectFilesByExt(STATIC_DIR, ['.html'])) {
            const lines = fs.readFileSync(path.join(STATIC_DIR, rel), 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (/<[a-z][^>]*\sstyle\s*=\s*["']/i.test(line)) {
                    offenders.push(`  • web/static/${rel}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        assert.deepEqual(offenders, [], `Inline style= attributes in HTML:\n\n${offenders.join('\n')}`);
    });
});
