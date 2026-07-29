// Dashboard — total value, what it is made of, and how it has done.
//
// Every number is read off portfolio.js `snapshot()` and perf.js
// `performance()`. The one derived quantity is each slice's share of the total,
// and even that goes through money.js `proportion` (exact, BigInt, rounded
// once) rather than a division here.
//
// ALLOCATION IS BARS, NOT A DONUT, and that is a deliberate deviation from the
// bead's wording. A donut needs one distinguishable colour per slice; the
// ported design system has no categorical palette (§9 lists exactly one accent
// plus the gain/loss triplets), so a donut would mean inventing a hue set the
// token registry does not have — and at 360px with a dozen positions the arcs
// are unreadable anyway. Ranked bars carry the same information, sort by size,
// and add no colour. If a categorical palette ever lands as real tokens, this
// is the place that consumes it.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { openTxModal } from './transactions.js';
import { state, loadPerformance, reportingCurrency } from './store.js';

function totalsCard(totals, currency) {
    const stats = ui.el('div', 'flex-row flex-wrap gap-xl');
    stats.appendChild(ui.stat(`Total value (${currency})`, fmt.money(totals.total)));
    stats.appendChild(ui.stat('Cash', fmt.money(totals.cash)));
    stats.appendChild(ui.stat('Invested', fmt.money(totals.marketValue)));
    stats.appendChild(ui.stat('Unrealized', ui.delta(
        fmt.deltaClass(totals.unrealized), fmt.signedMoney(totals.unrealized), { bare: true }
    )));
    stats.appendChild(ui.stat('Realized', ui.delta(
        fmt.deltaClass(totals.realized), fmt.signedMoney(totals.realized), { bare: true }
    )));
    stats.appendChild(ui.stat('Dividends', fmt.money(totals.dividends)));
    return ui.card(stats);
}

function returnStat(label, result) {
    if (!result || result.ok !== true) {
        // perf.js says *why* it could not produce a number
        // (no_capital / incomplete_valuation / no_sign_change). Showing the
        // reason beats showing "0.00%", which is a claim.
        const reason = result?.reason ? String(result.reason).replace(/_/g, ' ') : 'not available';
        return ui.stat(label, ui.delta('wg-delta--flat', reason, { bare: true }));
    }
    return ui.stat(label, ui.delta(fmt.deltaClass(result.value), fmt.percent(result.value), { bare: true }));
}

function performanceCard(perf) {
    const stats = ui.el('div', 'flex-row flex-wrap gap-xl');
    if (!perf || perf.error) {
        return ui.card(ui.sectionLabel('Performance'), ui.emptyState('Performance could not be computed.'));
    }
    if (!perf.portfolio) {
        return ui.card(
            ui.sectionLabel('Performance'),
            ui.emptyState('No performance history yet — it needs at least one transaction and one price.')
        );
    }
    stats.appendChild(returnStat('TTWROR', perf.portfolio.ttwror));
    stats.appendChild(returnStat('IRR (p.a.)', perf.portfolio.irr));
    stats.appendChild(ui.stat('Money in', fmt.money(perf.portfolio.flowIn)));
    stats.appendChild(ui.stat('Money out', fmt.money(perf.portfolio.flowOut)));
    const range = ui.el('p', 'wg-muted text-sm m-0 mt-sm', `Since inception · ${perf.from} → ${perf.to}`);
    return ui.card(ui.sectionLabel('Performance'), stats, range);
}

function allocationCard(snapshot) {
    // One slice per position, named by the shared label and keyed by nothing —
    // whatever the engine calls a position is what gets a bar. When bd g7e.11
    // splits the same security across two accounts this renders two bars, which
    // is the honest reading of a per-position allocation; if it should instead
    // aggregate, that is a grouping decision for the engine, not this screen.
    const slices = [];
    for (const p of snapshot.positions) {
        if (!Number.isSafeInteger(p.marketValue) || p.marketValue <= 0) continue;
        slices.push({ label: fmt.positionLabel(p), value: p.marketValue });
    }
    if (snapshot.totals.cash > 0) slices.push({ label: 'Cash', value: snapshot.totals.cash });
    slices.sort((a, b) => b.value - a.value);

    if (slices.length === 0) {
        return ui.card(ui.sectionLabel('Allocation'), ui.emptyState(
            'Nothing to allocate yet. A position needs a stored close before it has a value.'
        ));
    }

    const total = slices.reduce((sum, s) => sum + s.value, 0);
    const bars = ui.el('div', 'wg-alloc-list');
    for (const slice of slices) {
        bars.appendChild(ui.allocBar(
            slice.label,
            `${fmt.money(slice.value)} · ${fmt.sharePercent(slice.value, total)}`,
            fmt.shareBasisPoints(slice.value, total)
        ));
    }
    return ui.card(ui.sectionLabel('Allocation'), bars);
}

// The engine reports data problems rather than guessing past them (an unpriced
// position, a securities transfer it refuses, a non-integer amount). Surfacing
// them on the home screen is the difference between "the total looks low" and
// "three positions have no price".
function issuesCard(issues) {
    if (!issues || issues.length === 0) return null;
    const byCode = new Map();
    for (const issue of issues) {
        if (!byCode.has(issue.code)) byCode.set(issue.code, []);
        byCode.get(issue.code).push(issue);
    }
    const lines = [];
    for (const [code, list] of byCode) {
        const suffix = list.length > 1 ? ` (${list.length})` : '';
        lines.push(`${code.replace(/_/g, ' ')}${suffix}: ${list[0].message}`);
    }
    return ui.card(ui.sectionLabel('Needs attention'), ui.messages(lines));
}

export async function render(container) {
    const snapshot = state.snapshot;
    const head = ui.toolbar({
        primary: { label: 'Add', icon: 'plus', onClick: () => openTxModal(null) },
    });

    if (!snapshot || snapshot.positions.length + snapshot.accounts.length === 0) {
        // Dashboard is DEFAULT_SCREEN_ID, so this is the first thing a visitor
        // with no data sees — and until cnd.2 it had nothing to click and no
        // reason to stay. The demo link is offered here only: the other screens'
        // empty states are one deliberate tap further in, by which point this
        // one has already been seen.
        container.replaceChildren(head, ui.card(
            ui.emptyState(
                'Nothing to value yet. Record a transaction and your total value, '
                + 'allocation and performance appear here.'
            ),
            ui.demoLink()
        ));
        return;
    }

    const currency = snapshot.reportingCurrency || reportingCurrency();
    const children = [head, totalsCard(snapshot.totals, currency), allocationCard(snapshot)];

    // Paint the cheap cards first, then fill in the expensive one — perf()
    // re-values the portfolio at every flow boundary, and blocking the whole
    // screen on it would make the home screen the slowest one in the app.
    const placeholder = ui.card(ui.sectionLabel('Performance'), ui.emptyState('Computing…'));
    children.push(placeholder);
    const issues = issuesCard(snapshot.issues);
    if (issues) children.push(issues);
    container.replaceChildren(...children);

    const perf = await loadPerformance();
    // The user may have navigated away while that ran.
    if (placeholder.isConnected) placeholder.replaceWith(performanceCard(perf));
}
