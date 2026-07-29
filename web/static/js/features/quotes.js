// Quotes, wired to a screen — the refresh action and the staleness signal.
//
// web/domain/quotes.js has been merged, live-tested against both providers, and
// completely unreachable: nothing called it, so a user had to hand-enter every
// close forever. This module is the whole of the wiring, and it is deliberately
// thin — every rule about *how* a quote is fetched lives in the domain module,
// not here.
//
// Three rules this file exists to honour, all of them from ARCHITECTURE.md §7
// and the domain module's own header:
//
//  1. NO RETRY. quotes.js has none on purpose: it halts a provider for the rest
//     of a run on 401/403/429 rather than burning the user's free-tier quota.
//     A refresh button that retries is how someone loses their daily allowance
//     in one tap. So `refresh()` is called exactly once per press, the button
//     is disabled while it runs, and nothing here re-invokes it on failure.
//  2. NOTHING GOES THROUGH OUR ORIGIN. The `http` port below is the browser's
//     own fetch, aimed at the provider with the user's own key — that is the
//     privacy differentiator, and there is no fallback that would route a
//     symbol past our server. (The opt-in proxy is a separate, off-by-default
//     bead with its own consent screen.)
//  3. VALUATION NEVER DEPENDS ON THE NETWORK. A failed refresh is a *report*,
//     never an error screen and never a blank total: quotes.js writes what
//     landed into `price` records and portfolio.js reads only what is stored,
//     so a dead provider leaves every number exactly as it was, with a
//     staleness signal saying how old it is.
//
// PER-SECURITY OUTCOMES ARE NEVER COLLAPSED. quotes.js reports four distinct
// skip/error reasons plus three failure codes, and each one needs a different
// action from the user — a missing key, a rejected key, an exhausted quota and
// a mistyped symbol are fixed in four different places. "Prices failed to
// update" tells nobody anything, so `describeRefresh` groups by reason and
// names the securities in each group.

import { createQuotesDomain } from '../../../domain/quotes.js';
import { records, refresh as reloadStore, state } from './store.js';
import { QUOTE_PROVIDERS } from './settings.js';
import * as ui from './ui.js';
import * as fmt from './fmt.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// When the badge flips to its warning tone. A daily close is dated at the UTC
// calendar day it belongs to, so today's close is already "1 day old" by the
// badge's own arithmetic before the session is over — and over a weekend the
// newest close a stock market can possibly have is Friday's, which is three
// days old by Monday. Four days clears both, plus one public holiday, so the
// warning means "something is actually wrong" rather than "it is Monday".
export const STALE_AFTER_MS = 4 * DAY_MS;

// The domain factory over the app's ports, built once. `records` from store.js
// is a stable object whose implementation is swapped underneath it when the
// vault opens (see its header), so capturing it here is correct — capturing
// `localRecords` directly would not be.
const quotes = createQuotesDomain({
    records,
    // The injected transport, §3. Browser-direct to the provider host; nothing
    // here builds a URL, so nothing here can point it at our own origin.
    http: (url, init) => window.fetch(url, init),
});

const providerLabels = new Map(QUOTE_PROVIDERS.map((p) => [p.name, p.label]));
const providerLabel = (name) => providerLabels.get(name) ?? String(name ?? 'The provider');

// --- The staleness signal --------------------------------------------------

/**
 * Epoch ms of a "YYYY-MM-DD" UTC calendar day, or null.
 *
 * §4's time convention is UTC calendar days, so the day is anchored at 00:00Z
 * rather than parsed in the device's zone — otherwise the same stored close
 * reads a day older in Auckland than in Lisbon.
 */
export function dayMs(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
    const ms = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * The date the portfolio's valuation is really "as of": the OLDEST close
 * backing any open position, or null when nothing is priced at all.
 *
 * This reads portfolio.js's `priceDate` and NOT refresh()'s `fetchedAt`, which
 * is the whole point. `fetchedAt` says when this session last fetched, so it is
 * null on every cold start and a badge built on it would reset to "never" on
 * every reload — a lie about when the data was last good. `priceDate` is the
 * date of the close the engine actually valued the position with, so it
 * survives a reload, a reinstall and a device transfer.
 *
 * Oldest rather than newest because a total is only as fresh as its stalest
 * input: one security stuck on a month-old close makes the whole number a
 * month old, and reporting the newest would hide exactly that.
 */
export function valuationAsOf(snapshot) {
    let oldest = null;
    for (const p of snapshot?.positions ?? []) {
        // Closed positions carry no value, so their last close does not age the
        // total. Held-but-unpriced ones have no date at all and are already
        // reported by the engine's `no_price` issue.
        if (p.shares === 0 || !p.priceDate) continue;
        if (oldest === null || p.priceDate < oldest) oldest = p.priceDate;
    }
    return oldest;
}

/**
 * The ported wg-stale-badge, mounted on the durable signal. This is the thin
 * mount helper the component's port note asks for — it lives here rather than
 * in the component because resolving "how old is the valuation" is this app's
 * business, and the primitive stays domain-neutral.
 */
export function staleBadge(snapshot, { now = Date.now(), offline } = {}) {
    if (!window.WGStaleBadge) throw new Error('quotes: wg-stale-badge.js must load before the screens');
    return window.WGStaleBadge.render({
        fetchedAt: dayMs(valuationAsOf(snapshot)),
        // Offline is worth saying out loud: it explains why pressing Refresh
        // will not help, and the app still values the portfolio regardless.
        isOffline: offline ?? !navigator.onLine,
        staleAfterMs: STALE_AFTER_MS,
        now,
    });
}

// --- The refresh report ----------------------------------------------------

// One entry per outcome quotes.js can report, and they are deliberately not
// interchangeable: each line has to name the ONE place the user can go to fix
// that particular thing. Collapsing them was the failure this bead's landmine
// names, so a reason with no entry here still gets its own line rather than
// being folded into a neighbour.
//
// `names` is the affected securities, `provider` the provider's display label,
// `message` the provider's own words (already truncated by quotes.js, and
// never containing the request URL — that is where the API key is).
const OUTCOMES = {
    no_quote_config: (names) =>
        `No quote provider or symbol yet: ${names}. Settings › Securities — pick a provider and `
        + 'enter the symbol it uses.',
    unknown_provider: (names, provider) =>
        `${provider} is not a provider this build can fetch from, so nothing was fetched for ${names}. `
        + 'Settings › Securities — choose one of the offered providers.',
    no_api_key: (names, provider) =>
        `${provider} has no API key, so nothing was fetched for ${names} — the stored closes still stand. `
        + 'Settings › Quote providers — paste your own key; it never leaves this device.',
    bad_api_key: (names, provider) =>
        `${provider} rejected the key, so nothing was fetched for ${names} — the stored closes still stand. `
        + `Settings › Quote providers — check the key belongs to ${provider}. `
        + 'The rest of that provider\'s securities were skipped rather than tried again, so no quota was spent.',
    rate_limited: (names, provider) =>
        `${provider} will not take more requests right now, so nothing was fetched for ${names} — the `
        + 'stored closes still stand. Wait a minute and press Refresh again; nothing was sent twice, so '
        + 'your quota is intact.',
    fetch_failed: (names, provider, message) =>
        `${provider} could not be reached (${message}), so nothing was fetched for ${names}. `
        + 'Your portfolio is still valued from the closes already stored.',
    no_closes: (names, provider) =>
        `${provider} returned no close for ${names}. Settings › Securities — check the symbol is the one `
        + 'that provider uses.',
};

/**
 * Turn one `refresh()` return value into the lines a human reads. Pure, so the
 * wording is testable against a report the real domain module produced rather
 * than against a fixture that restates it.
 *
 * `securities` is the `security` record list, used only to name things — a
 * securityId in a message is useless to anyone.
 */
export function describeRefresh(report, securities = []) {
    // The same label Holdings rows use, so "VWCE · FTSE All-World" in a problem
    // line is recognisably the row above it. A security record keys its id as
    // `recordId`; positionLabel wants `securityId` as the last-resort fallback.
    const named = new Map((securities ?? []).map((s) => [
        s.recordId, fmt.positionLabel({ ...s, securityId: s.recordId }),
    ]));

    const groups = new Map();
    const push = (kind, provider, securityId, message) => {
        const key = `${kind} ${provider ?? ''}`;
        if (!groups.has(key)) groups.set(key, { kind, provider, names: [], message });
        groups.get(key).names.push(named.get(securityId) ?? securityId ?? 'an unnamed security');
    };

    for (const s of report?.skipped ?? []) push(s.reason, s.provider, s.securityId);
    for (const e of report?.errors ?? []) push(e.code, e.provider, e.securityId, e.message);

    const issues = [];
    for (const { kind, provider, names, message } of groups.values()) {
        const text = Object.hasOwn(OUTCOMES, kind) ? OUTCOMES[kind] : null;
        const list = names.join(', ');
        // An unrecognised code still says what it was and who it happened to,
        // rather than disappearing into a generic failure.
        issues.push(text
            ? text(list, providerLabel(provider), message ?? 'no detail')
            : `${String(kind).replace(/_/g, ' ')}: ${list}`);
    }

    const updated = report?.updated ?? [];
    const notes = [];
    if (updated.length > 0) {
        const latest = updated.map((u) => u.latest).filter(Boolean).sort().pop();
        notes.push(`Updated ${updated.length} securit${updated.length === 1 ? 'y' : 'ies'}`
            + `${latest ? ` · newest close ${latest}` : ''}.`);
    } else if (issues.length === 0) {
        notes.push('Nothing to fetch yet — no security has a quote provider and symbol. '
            + 'Settings › Securities.');
    }
    return { notes, issues };
}

// --- The action ------------------------------------------------------------

// Module-level, for the same reason settings.js parks its last import report
// here: the write that ends a refresh re-renders the screen and detaches
// whatever node the handler was writing into, so a report held by the DOM is
// never seen. The screen rebuilds this slot on every render and repaints it
// from the last outcome.
let lastReport = null;
let busy = false;
let slot = null;

function paint() {
    if (!slot) return;
    if (busy) {
        slot.replaceChildren(ui.card(ui.emptyState(
            'Fetching quotes, browser-direct with your own key. A provider with a per-minute '
            + 'limit is waited out rather than retried, so this can take a moment.'
        )));
        return;
    }
    if (!lastReport) {
        slot.replaceChildren();
        return;
    }
    const { notes, issues } = describeRefresh(lastReport, state.securities);
    slot.replaceChildren(ui.card(
        ui.sectionLabel('Last price refresh'),
        ui.messages(notes, 'normal'),
        ui.messages(issues)
    ));
}

/** The report card. Empty until the first refresh, and never an error screen. */
export function refreshReport() {
    slot = ui.el('div', 'wg-error-slot');
    paint();
    return slot;
}

async function runRefresh(event) {
    // The double-tap guard, and the reason there is no retry: one press is one
    // pass over the configured providers, full stop.
    if (busy) return;
    busy = true;
    const btn = event?.currentTarget;
    if (btn) btn.disabled = true;
    paint();

    try {
        // Exactly one call. `refresh()` never throws — it reports — but a
        // module that failed to load or a port that is wedged still can, and
        // that must degrade to a line in the report, not a dead screen.
        lastReport = await quotes.refresh();
    } catch (err) {
        lastReport = {
            updated: [],
            skipped: [],
            errors: [{ code: 'fetch_failed', message: String(err?.message ?? err) }],
        };
    } finally {
        busy = false;
        if (btn) btn.disabled = false;
    }

    // Re-derive from what actually landed in the price records. A refresh that
    // fetched nothing leaves every number exactly as it was — this is what
    // "valuation never depends on the network" looks like in code.
    await reloadStore();
    paint();
}

/**
 * The toolbar action, as an inline `.wg-toolbar-btn--primary` pill (§9). Never
 * a floating FAB and never a bottom CTA dock — the sibling shipped both and
 * retired both.
 */
export function refreshAction() {
    return { label: 'Refresh', icon: 'activity', onClick: runRefresh };
}
