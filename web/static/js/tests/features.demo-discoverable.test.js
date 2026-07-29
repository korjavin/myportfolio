/**
 * features.demo-discoverable.test.js  (bd myportfolio-cnd.2)
 *
 * cnd.1 built the demo; a feature nobody can find is a feature nobody has. The
 * two placements that make it findable are the two asserted here:
 *
 *   - README.md, which is what a visitor to the GitHub repo sees before they
 *     have any deployment to click at all.
 *   - The Dashboard first-run empty state — DEFAULT_SCREEN_ID, so it is the
 *     literal first screen of an app with no records in it.
 *
 * These are source-text assertions rather than rendered DOM because the project
 * has no jsdom and no npm dependencies (see features.integration.test.js). What
 * that costs is real: this cannot prove the link is visible, only that the code
 * which builds it is still wired into the branch that renders. The link's own
 * href form is worth pinning independently — see the `./?demo=1` test below for
 * why the rooted spelling is a trap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), 'utf8');

const ui = read('..', 'features', 'ui.js');
const dashboard = read('..', 'features', 'dashboard.js');
const readme = read('..', '..', '..', '..', 'README.md');

describe('Demo mode is discoverable', () => {
    test('the empty-state CTA points at ./?demo=1, not /?demo=1', () => {
        const link = ui.match(/export function demoLink\(\)[\s\S]*?\n}/);
        assert.ok(link, 'ui.js no longer exports demoLink()');
        assert.match(
            link[0],
            /\.href\s*=\s*'\.\/\?demo=1'/,
            "demoLink() must set href to './?demo=1'"
        );
        // The rooted form is what cnd.1 shipped and had to fix: "/" is a
        // directory, not a file, and architecture.asset-paths.test.js resolves
        // every rooted href/src/url() against the embedded tree.
        assert.doesNotMatch(link[0], /=\s*'\/\?demo=1'/, "'/?demo=1' fails the asset-path guard");
        assert.match(link[0], /'a'/, 'demoLink() must build an anchor, not a button');
    });

    test('the Dashboard first-run empty state offers the demo', () => {
        // Scoped to the no-records branch on purpose: a demoLink() call anywhere
        // else in the file would not put anything in front of a new visitor.
        const start = dashboard.indexOf('if (!snapshot ||');
        assert.notEqual(start, -1, 'dashboard.js no longer has a first-run empty-state branch');
        const branch = dashboard.slice(start, dashboard.indexOf('return;', start));
        assert.match(branch, /Nothing to value yet/, 'the empty-state copy moved — retarget this test');
        assert.match(
            branch,
            /ui\.demoLink\(\)/,
            'the first-run empty state must offer "See a demo portfolio" — it is the only thing '
            + 'a visitor with no records can click'
        );
    });

    test('the CTA is not conditional on demo mode, because it cannot render there', () => {
        // Verified rather than assumed (the bead asks for exactly this): in demo
        // mode the fixture port returns accounts and positions, so the branch
        // above is false and no empty state renders at all. Guarding the link on
        // the URL as well would be dead code on every path that matters — this
        // test pins that reasoning so a future reader does not "fix" it.
        assert.doesNotMatch(ui.match(/export function demoLink\(\)[\s\S]*?\n}/)[0], /location|search/);
    });

    test('README names the demo URL and says the data is fabricated', () => {
        const head = readme.slice(0, readme.indexOf('## What it is'));
        assert.match(head, /\?demo=1/, 'the README must name the demo URL above the fold');
        assert.match(head, /fabricated|made up|invented/i, 'the README must say the data is not real');
        assert.match(
            head,
            /nothing is written|nothing is stored|not stored|nothing is saved/i,
            'the README must say nothing is stored'
        );
    });
});
