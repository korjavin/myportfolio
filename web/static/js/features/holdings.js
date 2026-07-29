// Holdings — open positions with live P/L, straight off portfolio.js
// `snapshot()`. Nothing on this screen is computed here: shares, cost basis,
// market value and unrealized gain all arrive as §5 integers and are only
// formatted.
//
// The screen also owns the manual price entry, and that is not a nicety even
// now that Refresh fetches quotes (ARCHITECTURE.md §7): a position with no
// `price` record has `marketValue: null` and portfolio.js raises `no_price`,
// and plenty of holdings have no provider symbol at all — an unlisted fund, a
// private holding, a security whose provider this build does not support. The
// close is written through store.putPrice, which owns the §4 per-security-year
// chunk shape.
//
// Fetching lives in features/quotes.js: the toolbar's Refresh pill and the
// staleness badge on the summary card. Both are wired here, and nothing about
// how a quote is fetched is decided in this file.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { openTxModal } from './transactions.js';
import { priceHistoryCard } from './pricechart.js';
import { refreshAction, refreshReport, staleBadge, valuationAsOf } from './quotes.js';
import { state, putPrice, reportingCurrency } from './store.js';
import { parseFixed, DECIMALS } from '../../../domain/money.js';
import { todayLocal } from './forms.js';

const FILTERS = [
    { id: 'open', label: 'Open' },
    { id: 'all', label: 'All' },
];

let filter = 'open';

// How a position is named lives in fmt.positionLabel, shared with the
// Dashboard — including the broker, so the two rows the same ETF held at two
// brokers produces are told apart. A position is opaque here: rows are
// rendered straight off the engine's list and never keyed by securityId, which
// is why re-keying positions by (accountId, securityId) turned one row into
// two without touching this file.
const title = fmt.positionLabel;

function openPriceModal(position) {
    const dateInput = ui.input(todayLocal(), { type: 'date' });
    const priceInput = ui.input(
        Number.isSafeInteger(position.price) ? fmt.price(position.price) : '',
        { inputMode: 'decimal', placeholder: '0.00' }
    );
    const errorSlot = ui.el('div', 'wg-error-slot');

    ui.modal({
        title: `Price · ${title(position)}`,
        body: [
            errorSlot,
            ui.el('p', 'wg-muted text-sm m-0',
                'A close belongs to the security, so it values every position holding it. '
                + 'Valuation reads stored closes only — this is the price the app uses offline '
                + 'and until it is replaced, by you or by the next Refresh.'),
            ui.fieldRow(ui.field('Date', dateInput), ui.field(`Close (${position.currency || reportingCurrency()})`, priceInput)),
        ],
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            {
                label: 'Save',
                className: 'wg-gloss wg-gloss--sun wg-gloss--lg',
                onClick: async (close) => {
                    errorSlot.replaceChildren();
                    let units;
                    try {
                        units = parseFixed(priceInput.value.trim(), DECIMALS.price);
                    } catch {
                        errorSlot.appendChild(ui.messages([`Not a number: ${priceInput.value}`]));
                        return;
                    }
                    if (units <= 0) {
                        errorSlot.appendChild(ui.messages(['A close must be greater than zero.']));
                        return;
                    }
                    try {
                        await putPrice(position.securityId, dateInput.value, units);
                    } catch (err) {
                        errorSlot.appendChild(ui.messages([err.message]));
                        return;
                    }
                    close();
                },
            },
        ],
    });
}

function openPositionModal(position) {
    const facts = ui.el('div', 'flex-row flex-wrap gap-xl');
    facts.appendChild(ui.stat('Shares', fmt.shares(position.shares)));
    facts.appendChild(ui.stat('Cost basis', fmt.money(position.cost)));
    facts.appendChild(ui.stat('Market value', fmt.money(position.marketValue)));
    facts.appendChild(ui.stat('Unrealized', ui.delta(
        fmt.deltaClass(position.unrealized), fmt.signedMoney(position.unrealized), { bare: true }
    )));
    facts.appendChild(ui.stat('Realized', ui.delta(
        fmt.deltaClass(position.realized), fmt.signedMoney(position.realized), { bare: true }
    )));
    facts.appendChild(ui.stat('Dividends', fmt.money(position.dividends)));
    facts.appendChild(ui.stat('Fees', fmt.money(position.fees)));
    facts.appendChild(ui.stat('Taxes', fmt.money(position.taxes)));

    const priceLine = position.price === null || position.price === undefined
        ? ui.el('p', 'wg-muted text-sm m-0', 'No stored close — this position has no market value.')
        : ui.el('p', 'wg-muted text-sm m-0', `Last close ${fmt.price(position.price)} on ${position.priceDate}.`);

    ui.modal({
        title: title(position),
        // The close history of the security this position holds — the app has
        // stored years of it since the first import and had no way to show it.
        body: [facts, priceLine, priceHistoryCard(position.securityId)],
        actions: [
            {
                label: 'Set price',
                className: 'wg-gloss wg-gloss--lg',
                onClick: (close) => { close(); openPriceModal(position); },
            },
            {
                label: 'Buy',
                className: 'wg-gloss wg-gloss--sun wg-gloss--lg',
                onClick: (close) => {
                    close();
                    // The depot too, not just the security: buying more of the
                    // position on screen means more of it at THAT broker, and
                    // §4 needs the securities account named to key it there.
                    openTxModal(null, {
                        type: 'buy',
                        securityId: position.securityId,
                        portfolioId: position.accountId ?? '',
                    });
                },
            },
        ],
    });
}

export function render(container) {
    const snapshot = state.snapshot;
    const positions = (snapshot?.positions ?? []).filter((p) => filter === 'all' || p.shares !== 0);

    const head = ui.toolbar({
        options: FILTERS,
        active: filter,
        onSelect: (id) => { filter = id; render(container); },
        // Both inline pills in the toolbar row (§9). Refresh leads because it
        // is the action that changes what every number below says.
        primary: [
            refreshAction(),
            { label: 'Buy', icon: 'plus', onClick: () => openTxModal(null, { type: 'buy' }) },
        ],
    });

    // Rebuilt on every render and repainted from the last outcome — a report
    // written into a node this render is about to replace is never seen.
    const report = refreshReport();

    if (positions.length === 0) {
        container.replaceChildren(head, report, ui.card(ui.emptyState(
            (snapshot?.positions ?? []).length === 0
                ? 'No open positions. A buy transaction opens one.'
                : 'No open positions — switch to All to see closed ones.'
        )));
        return;
    }

    const totals = snapshot.totals;
    const stats = ui.el('div', 'flex-row flex-wrap gap-xl');
    stats.appendChild(ui.stat('Invested', fmt.money(totals.marketValue)));
    stats.appendChild(ui.stat('Cost', fmt.money(totals.cost)));
    stats.appendChild(ui.stat('Unrealized', ui.delta(
        fmt.deltaClass(totals.unrealized), fmt.signedMoney(totals.unrealized), { bare: true }
    )));

    // How old the number above actually is. Read off the engine's `priceDate`,
    // not off the last fetch: a badge that resets to "just updated" on every
    // reload is a lie about when the data was last good.
    const asOf = valuationAsOf(snapshot);
    const freshness = ui.el('div', 'flex-row flex-wrap gap-sm mt-md');
    freshness.appendChild(staleBadge(snapshot));
    freshness.appendChild(ui.el('span', 'wg-muted text-sm', asOf
        ? `Oldest close in this total · ${asOf}`
        : 'No stored closes yet — Refresh fetches them, or "Set price" records one by hand.'));

    const summary = ui.card(stats, freshness);

    const rows = ui.list(positions.map((p) => {
        const sub = [`${fmt.shares(p.shares)} sh`];
        if (p.price !== null && p.price !== undefined) sub.push(`@ ${fmt.price(p.price)}`);
        else sub.push('no price');
        // Percent gain is derived from the two stored integers by the domain's
        // exact `proportion`, never by dividing two floats here.
        if (p.marketValue !== null && p.marketValue !== undefined && p.cost > 0) {
            sub.push(fmt.sharePercent(p.unrealized, p.cost));
        }
        return ui.row({
            title: title(p),
            subtitle: sub.join(' · '),
            value: fmt.money(p.marketValue),
            valueNode: ui.delta(fmt.deltaClass(p.unrealized), fmt.signedMoney(p.unrealized), { bare: true }),
            onOpen: () => openPositionModal(p),
        });
    }));

    container.replaceChildren(head, report, summary, rows);
}
