/**
 * architecture.chart-theme.test.js
 *
 * Ported from ../medicationtrackerbot (vitest → node:test).
 *
 * The sibling introduced a shared chart theme in :root (--wg-chart-card-*,
 * --wg-chart-guide-*, --wg-chart-axis-tick-*) after two chart components drifted
 * apart — one shipped an off-white panel with unreadable axis labels. This
 * matters more here than it did there: a portfolio app is mostly charts.
 *
 * PORT NOTE: the sibling pinned adoption on its two domain chart components
 * (.wg-bp-chart-card, .wg-weight-chart-panel), both dropped by §9. The shared
 * tokens therefore need a domain-neutral consumer, and .wg-chart-card /
 * .wg-chart__guide / .wg-chart__axis-tick / .wg-chart__series are it. Every
 * chart component in this app composes those classes rather than declaring its
 * own surface, grid, tick, or series colors.
 *
 * Pins:
 *   1. The shared tokens exist in :root.
 *   2. The generic chart classes consume them.
 *   3. No hex / rgb() / rgba() literal leaks into those rules.
 *   4. Chart series colors resolve to the SAME delta tokens the holdings rows
 *      use, so a performance line in negative territory and a losing position
 *      read as one signal.
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

const css = fs.readFileSync(CSS_PATH, 'utf8');

function extractRootBlock(source) {
    const match = source.match(/:root\s*\{([^}]+)\}/);
    return match ? match[1] : '';
}

function extractRule(source, selector) {
    const escaped = selector
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
    const m = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
    return m ? m[1].trim() : null;
}

const SHARED_CHART_TOKENS = [
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
];

describe('architecture — shared chart theme', () => {
    test('declares every --wg-chart-* token in :root', () => {
        const root = extractRootBlock(css);
        for (const token of SHARED_CHART_TOKENS) {
            assert.ok(root.includes(`${token}:`), `missing ${token} in :root`);
        }
    });

    test('.wg-chart-card uses --wg-chart-card-bg / border / radius / pad', () => {
        const rule = extractRule(css, '.wg-chart-card');
        assert.ok(rule, '.wg-chart-card rule missing');
        for (const t of ['bg', 'border', 'radius', 'pad']) {
            assert.ok(rule.includes(`var(--wg-chart-card-${t})`), `.wg-chart-card must consume --wg-chart-card-${t}`);
        }
    });

    test('.wg-chart__guide uses --wg-chart-guide-stroke / stroke-width / dasharray', () => {
        const rule = extractRule(css, '.wg-chart__guide');
        assert.ok(rule, '.wg-chart__guide rule missing');
        assert.ok(rule.includes('var(--wg-chart-guide-stroke)'));
        assert.ok(rule.includes('var(--wg-chart-guide-stroke-width)'));
        assert.ok(rule.includes('var(--wg-chart-guide-dasharray)'));
    });

    test('.wg-chart__axis-tick uses --wg-chart-axis-tick-color and -size', () => {
        const rule = extractRule(css, '.wg-chart__axis-tick');
        assert.ok(rule, '.wg-chart__axis-tick rule missing');
        assert.ok(rule.includes('var(--wg-chart-axis-tick-color)'));
        assert.ok(rule.includes('var(--wg-chart-axis-tick-size)'));
        // The sibling's defect #16 was a mono font + the dim --wg-fg-4 fill on
        // tick labels, which made them unreadable on the dark card.
        assert.ok(!rule.includes('var(--wg-fg-4)'), 'axis ticks must not use the dim --wg-fg-4 fill');
        assert.ok(!rule.includes('var(--wg-font-mono)'), 'axis ticks use the inherited UI font, not mono');
        assert.ok(rule.includes('font-family: inherit'));
    });

    test('chart series/area colors resolve to the shared delta tokens', () => {
        // This is the consistency the shared theme exists for: a negative
        // performance line and a losing holdings row must be the same color,
        // sourced from the same token — not two independent reds.
        const root = extractRootBlock(css);
        assert.match(root, /--wg-chart-gain-stroke:\s*var\(--wg-gain-fg\)/);
        assert.match(root, /--wg-chart-loss-stroke:\s*var\(--wg-loss-fg\)/);

        assert.ok(extractRule(css, '.wg-chart__series--gain').includes('var(--wg-chart-gain-stroke)'));
        assert.ok(extractRule(css, '.wg-chart__series--loss').includes('var(--wg-chart-loss-stroke)'));
        assert.ok(extractRule(css, '.wg-chart__area--gain').includes('var(--wg-chart-gain-stroke)'));
        assert.ok(extractRule(css, '.wg-chart__area--loss').includes('var(--wg-chart-loss-stroke)'));
    });

    test('no chart rule hardcodes a hex color or rgb()/rgba() literal', () => {
        const selectors = [
            '.wg-chart-card',
            '.wg-chart__guide',
            '.wg-chart__axis-tick',
            '.wg-chart__series',
            '.wg-chart__series--gain',
            '.wg-chart__series--loss',
            '.wg-chart__area',
            '.wg-chart__area--gain',
            '.wg-chart__area--loss',
        ];
        for (const sel of selectors) {
            const rule = extractRule(css, sel);
            assert.ok(rule, `${sel} rule missing`);
            assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b/, `${sel} hardcodes a hex color`);
            assert.doesNotMatch(rule, /\brgba?\(/, `${sel} hardcodes an rgb()/rgba() literal`);
        }
    });
});
