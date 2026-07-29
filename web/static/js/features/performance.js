// Performance — TTWROR and IRR over a selectable range, portfolio-wide and per
// security. Every number comes from perf.js; this file picks the range and
// formats the result.
//
// The three conventions perf.js pins are NOT re-decided here (its header is the
// normative text): days are UTC calendar days, [from, to] is inclusive at both
// ends, and flows land money-in-at-start / money-out-at-end. The range buttons
// below therefore produce UTC day strings and nothing else.
//
// Ranges are counted in DAYS, not calendar months, on purpose: "3 months before
// May 31" has no unambiguous answer (Date.UTC rolls Feb 31 to Mar 2), and a
// range selector that silently shifts its own boundary is a range selector that
// makes two adjacent readings incomparable.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { loadPerformance } from './store.js';

const MS_PER_DAY = 86400000;

const RANGES = [
    { id: '1m', label: '1M', days: 30 },
    { id: '6m', label: '6M', days: 182 },
    { id: '1y', label: '1Y', days: 365 },
    { id: 'ytd', label: 'YTD' },
    { id: 'all', label: 'All' },
];

let activeRange = 'all';

/** Today as a UTC calendar day — the same day perf.js would read it as. */
function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

function rangeFor(id) {
    if (id === 'all') return {};
    const to = todayUtc();
    if (id === 'ytd') return { from: `${to.slice(0, 4)}-01-01`, to };
    const spec = RANGES.find((r) => r.id === id);
    if (!spec || !spec.days) return {};
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (spec.days - 1) * MS_PER_DAY);
    return { from: from.toISOString().slice(0, 10), to };
}

function returnCell(result) {
    if (!result || result.ok !== true) {
        const reason = result?.reason ? String(result.reason).replace(/_/g, ' ') : 'n/a';
        return ui.delta('wg-delta--flat', reason, { bare: true });
    }
    return ui.delta(fmt.deltaClass(result.value), fmt.percent(result.value), { bare: true });
}

function portfolioCard(perf) {
    const stats = ui.el('div', 'flex-row flex-wrap gap-xl');
    const p = perf.portfolio;
    const ttwror = ui.el('div', 'stat-item');
    ttwror.appendChild(ui.el('span', 'stat-label', 'TTWROR (time-weighted)'));
    const ttwrorValue = ui.el('span', 'stat-value');
    ttwrorValue.appendChild(returnCell(p.ttwror));
    ttwror.appendChild(ttwrorValue);
    stats.appendChild(ttwror);

    const irr = ui.el('div', 'stat-item');
    irr.appendChild(ui.el('span', 'stat-label', 'IRR (money-weighted, p.a.)'));
    const irrValue = ui.el('span', 'stat-value');
    irrValue.appendChild(returnCell(p.irr));
    irr.appendChild(irrValue);
    stats.appendChild(irr);

    stats.appendChild(ui.stat('Opening value', fmt.money(p.openValue)));
    stats.appendChild(ui.stat('Closing value', fmt.money(p.closeValue)));
    stats.appendChild(ui.stat('Money in', fmt.money(p.flowIn)));
    stats.appendChild(ui.stat('Money out', fmt.money(p.flowOut)));

    const note = ui.el('p', 'wg-muted text-sm m-0 mt-sm',
        `${perf.from} → ${perf.to} inclusive. Opening value is the close of ${perf.openDate}.`);
    return ui.card(stats, note);
}

export async function render(container) {
    const head = ui.toolbar({
        options: RANGES,
        active: activeRange,
        onSelect: (id) => { activeRange = id; render(container); },
    });

    const placeholder = ui.card(ui.emptyState('Computing…'));
    container.replaceChildren(head, placeholder);

    const perf = await loadPerformance(rangeFor(activeRange));
    if (!placeholder.isConnected) return;

    if (!perf || perf.error) {
        placeholder.replaceWith(ui.card(ui.emptyState(
            `Performance could not be computed: ${perf?.error?.message ?? 'unknown error'}`
        )));
        return;
    }
    if (!perf.portfolio) {
        placeholder.replaceWith(ui.card(ui.emptyState(
            'No performance history yet — it needs at least one transaction and one price.'
        )));
        return;
    }

    const children = [portfolioCard(perf)];

    if (perf.securities.length > 0) {
        children.push(ui.sectionLabel('By security'));
        children.push(ui.list(perf.securities.map((s) => ui.row({
            title: s.ticker ? `${s.ticker} · ${s.name ?? ''}`.replace(/ ·\s*$/, '') : (s.name ?? s.securityId),
            subtitle: `${fmt.money(s.openValue)} → ${fmt.money(s.closeValue)} · in ${fmt.money(s.flowIn)} · out ${fmt.money(s.flowOut)}`,
            valueNode: returnCell(s.ttwror),
        }))));
    }

    if (perf.issues.length > 0) {
        children.push(ui.card(
            ui.sectionLabel('Needs attention'),
            ui.messages(perf.issues.map((i) => `${i.code.replace(/_/g, ' ')}: ${i.message}`).slice(0, 8))
        ));
    }

    placeholder.replaceWith(...children);
}
