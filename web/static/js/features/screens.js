// The five nav destinations. This file is the router only — one entry per
// bottom-nav slot; the screens themselves live one module each.
//
// Conventions it holds the line on (ARCHITECTURE.md §9):
//   - No section-header banner. Screens sit directly on the stage and the
//     active bottom-nav pill is the sole screen indicator.
//   - No inline styles and no design tokens read from JS: every visual value
//     comes from a class name that styles.css resolves.
//   - Nodes are built with createElement, never innerHTML with an on*= handler
//     — the served CSP drops inline handlers silently.

import * as dashboard from './dashboard.js';
import * as holdings from './holdings.js';
import * as transactions from './transactions.js';
import * as performance from './performance.js';
import * as settings from './settings.js';
import { state } from './store.js';
import * as ui from './ui.js';

// Keyed by the bottom-nav slot id (WGBottomNav.DEFAULT_ITEMS).
const SCREENS = {
    dashboard: { title: 'Dashboard', render: dashboard.render },
    holdings: { title: 'Holdings', render: holdings.render },
    transactions: { title: 'Transactions', render: transactions.render },
    performance: { title: 'Performance', render: performance.render },
    settings: { title: 'Settings', render: settings.render },
};

export const SCREEN_IDS = Object.keys(SCREENS);

export const DEFAULT_SCREEN_ID = 'dashboard';

/** Resolve an arbitrary id to a real screen id. Unknown → the default. */
export function resolveScreenId(id) {
    return Object.prototype.hasOwnProperty.call(SCREENS, id) ? id : DEFAULT_SCREEN_ID;
}

export function screenTitle(id) {
    return SCREENS[resolveScreenId(id)].title;
}

/**
 * Render a screen into `container`.
 *
 * Async because two of the five finish on a domain call, but the shell never
 * awaits a database read before painting: `state.ready` is false until the
 * first load resolves and the screen says so, rather than showing a blank
 * stage. A shell that needs a successful IndexedDB read to paint is a shell
 * that shows nothing in private-browsing mode.
 */
export async function renderScreen(container, id) {
    const screen = resolveScreenId(id);

    if (!state.ready) {
        container.replaceChildren(ui.card(ui.emptyState('Opening your portfolio…')));
        return screen;
    }
    if (state.error) {
        container.replaceChildren(ui.card(ui.messages([
            'This browser will not let the app store data (private-browsing mode blocks '
            + 'IndexedDB in some browsers). Nothing you enter would survive a reload, so '
            + 'the screens are held back rather than pretending to save.',
            String(state.error.message ?? state.error),
        ])));
        return screen;
    }

    await SCREENS[screen].render(container);
    return screen;
}
