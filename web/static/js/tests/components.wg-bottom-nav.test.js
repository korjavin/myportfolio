/**
 * components.wg-bottom-nav.test.js
 *
 * The nav components are DOM-bound, and this project deliberately has no npm
 * dependencies — so there is no jsdom to render them into. What IS testable
 * without a DOM is the layout rule, which is the load-bearing claim: this app
 * has five slots, and five slots must lay out as ONE row. If colsFor ever
 * returned 3 for five items the nav would silently wrap to two rows and eat
 * ~54px of every screen.
 *
 * `_colsFor` is exposed by the component for exactly this reason. We evaluate
 * the IIFE against a stub `window` — it touches no DOM until mount() is called.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const COMPONENT = path.join(REPO_ROOT, 'web/static/js/components/wg-bottom-nav.js');

function loadComponent() {
    const source = fs.readFileSync(COMPONENT, 'utf8');
    const win = {};
    new Function('window', source)(win);
    return win.WGBottomNav;
}

describe('WGBottomNav layout', () => {
    const WGBottomNav = loadComponent();

    test('exposes the five canonical portfolio slots in order', () => {
        assert.deepEqual(
            WGBottomNav.DEFAULT_ITEMS.map((i) => i.id),
            ['dashboard', 'holdings', 'transactions', 'performance', 'settings']
        );
    });

    test('DEFAULT_ITEMS is frozen — nav order is not user-reorderable', () => {
        assert.equal(Object.isFrozen(WGBottomNav.DEFAULT_ITEMS), true);
    });

    test('every default slot names an icon that exists in the WGIcons registry', () => {
        // Catches the failure mode where a nav slot is added with an icon name
        // that was dropped in the port — iconSvg() throws on unknown names, so
        // this would be a runtime crash on first mount.
        const iconsSrc = fs.readFileSync(
            path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js'),
            'utf8'
        );
        const win = {};
        // wg-icons.js only touches DOM inside iconSvg(); the registry itself is
        // a plain object literal built at module scope.
        new Function('window', 'DOMParser', 'document', iconsSrc)(win, function () {}, {});
        const known = new Set(Object.keys(win.WGIcons.paths));
        const missing = WGBottomNav.DEFAULT_ITEMS.filter((i) => !known.has(i.icon)).map((i) => `${i.id} → ${i.icon}`);
        assert.deepEqual(missing, [], `nav slots reference unknown icons: ${missing.join(', ')}`);
    });

    test('five slots lay out as a single row', () => {
        assert.equal(WGBottomNav._colsFor(5), 5);
        assert.equal(WGBottomNav._colsFor(WGBottomNav.DEFAULT_ITEMS.length), 5);
    });

    test('six to ten slots wrap to two rows; more than ten is unsupported', () => {
        assert.equal(WGBottomNav._colsFor(1), 1);
        assert.equal(WGBottomNav._colsFor(4), 4);
        assert.equal(WGBottomNav._colsFor(6), 3);
        assert.equal(WGBottomNav._colsFor(8), 4);
        assert.equal(WGBottomNav._colsFor(10), 5);
        assert.equal(WGBottomNav._colsFor(11), null);
        assert.equal(WGBottomNav._colsFor(0), null);
    });
});
