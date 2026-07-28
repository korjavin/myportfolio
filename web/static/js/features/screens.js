// The five nav destinations, as skeletons.
//
// SCOPE: this file is the shell's half of the contract only — one mountable
// screen per bottom-nav slot, each rendering an empty state. The real content
// (transactions CRUD, holdings table, dashboard charts, settings form) is bd
// myportfolio-g7e.7 and replaces the bodies below.
//
// Conventions this file is holding the line on (ARCHITECTURE.md §9):
//   - No section-header banner. Screens sit directly on the stage and the
//     active bottom-nav pill is the sole screen indicator.
//   - No inline styles and no design tokens read from JS: every visual value
//     comes from a class name that styles.css resolves.
//   - Nodes are built with createElement, never innerHTML with an on*= handler
//     — the served CSP drops inline handlers silently.

// Keyed by the bottom-nav slot id (WGBottomNav.DEFAULT_ITEMS).
const SCREENS = {
    dashboard: {
        title: 'Dashboard',
        empty: 'Nothing to value yet. Record a transaction and your total value, ' +
            'day change and allocation appear here.',
    },
    holdings: {
        title: 'Holdings',
        empty: 'No open positions. A buy transaction opens one.',
    },
    transactions: {
        title: 'Transactions',
        empty: 'No transactions yet.',
    },
    performance: {
        title: 'Performance',
        empty: 'No performance history yet — it needs at least one transaction ' +
            'and one price.',
    },
    settings: {
        title: 'Settings',
        empty: 'Reporting currency, quote providers and backup will live here.',
    },
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

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function statItem(label, value) {
    const item = el('div', 'stat-item');
    item.appendChild(el('span', 'stat-label', label));
    item.appendChild(el('span', 'stat-value', value));
    return item;
}

/**
 * Render a screen into `container`.
 *
 * @param {Element} container
 * @param {string}  id      bottom-nav slot id
 * @param {?object} counts  record counts read from the local store, or null
 *                          while the read is still in flight / unavailable.
 *                          Rendering must not depend on it — a shell that
 *                          needs a successful IndexedDB read to paint is a
 *                          shell that shows a blank screen in private mode.
 */
export function renderScreen(container, id, counts) {
    const screen = resolveScreenId(id);
    const card = el('div', 'wg-card');

    // The dashboard is the one screen that reports what is actually in the
    // local store, so an airplane-mode cold start visibly renders from
    // IndexedDB rather than from nothing.
    if (screen === 'dashboard' && counts) {
        const stats = el('div', 'flex-row flex-wrap gap-xl mb-md');
        stats.appendChild(statItem('Accounts', String(counts.account)));
        stats.appendChild(statItem('Securities', String(counts.security)));
        stats.appendChild(statItem('Transactions', String(counts.transaction)));
        card.appendChild(stats);
    }

    card.appendChild(el('p', 'empty-state-msg m-0', SCREENS[screen].empty));

    container.replaceChildren(card);
    return screen;
}
