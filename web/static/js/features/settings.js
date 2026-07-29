// Settings — reporting currency, quote providers, the accounts and securities
// the transaction form draws on, Portfolio Performance import, and export.
//
// Import is `parsePP` (web/domain/ppimport.js) and nothing else: the parser
// mints deterministic ids from stable upstream keys, so re-importing the same
// file overwrites instead of doubling the portfolio (§4). This screen honours
// the id the parser chose — minting a fresh one here is exactly the bug that
// idempotence exists to prevent.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { parsePP } from '../../../domain/ppimport.js';
import { RECORD, ASSET_CLASSES } from '../../../domain/schema.js';
import {
    state, putSettings, putAccount, putSecurity, remove, refresh,
    importRecords, exportAll, reportingCurrency, DEFAULT_CURRENCY,
} from './store.js';
import { syncState, describeSync, syncNow, subscribeSync } from './sync.js';

function generalCard(rerender) {
    const currency = ui.input(reportingCurrency(), { placeholder: DEFAULT_CURRENCY });

    const save = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Save', async () => {
        await putSettings({ reportingCurrency: currency.value.trim().toUpperCase() || DEFAULT_CURRENCY });
        rerender();
    });

    return ui.card(
        ui.sectionLabel('General'),
        ui.field('Reporting currency', currency),
        actionRow(save)
    );
}

// --- Quote providers -------------------------------------------------------

// §7: browser-direct with the user's own key is the default, so the server
// never learns which symbols you hold. `settings.quoteProviders` is a MAP and
// every provider in it is live at once — CoinGecko prices crypto with no key
// while Twelve Data prices stocks and ETFs with the user's own key, and a
// portfolio holding both BTC and VWCE needs both configured simultaneously.
// web/domain/quotes.js has always read it that way (it routes per security via
// `security.quote.provider` and looks the config up by name); this card is what
// had to catch up.
//
// Finnhub and Alpha Vantage are deliberately absent: quotes.js knows neither,
// so choosing one used to price nothing at all and say nothing about it.
// Offering a provider that silently does nothing is worse than not offering it.
// Yahoo is absent for a different reason — it blocks CORS, so it cannot be used
// browser-direct at all. features.settings.test.js pins this list against
// quotes.js's exported QUOTE_HOSTS so the two cannot drift apart again.
export const QUOTE_PROVIDERS = [
    {
        name: 'coingecko',
        label: 'CoinGecko',
        // The note deliberately does not promise that switching this off stops
        // CoinGecko being used: quotes.js prices any security routed to
        // `coingecko` whether or not the map lists it, because a provider that
        // needs no key can never be skipped for `no_api_key`. Listing it is
        // what the §7 CSP allowlist will be derived from (myportfolio-18h.9).
        note: 'Crypto. The free tier needs no key, so nothing but the choice is stored.',
        // Optional all the same: quotes.js sends a stored CoinGecko key as
        // `x_cg_demo_api_key`, which raises the keyless rate limit. The field
        // exists so that key is visible and editable rather than silently
        // carried — see mergeQuoteProviders.
        keyNote: 'Optional. A CoinGecko demo key only raises the free-tier rate limit.',
        needsKey: false,
    },
    {
        name: 'twelvedata',
        label: 'Twelve Data',
        note: 'Stocks and ETFs. Bring your own key — it never leaves this device. Blank turns it off.',
        needsKey: true,
    },
];

const KNOWN_PROVIDERS = new Set(QUOTE_PROVIDERS.map((p) => p.name));

function configOf(map, name) {
    const value = Object.hasOwn(map, name) ? map[name] : null;
    return value && typeof value === 'object' ? value : null;
}

/**
 * One row per provider this card renders, derived from the stored map. Pure, so
 * the DOM builder and the tests work from the same thing rather than from two
 * descriptions of it that can disagree.
 *
 * `keyField` says whether the row renders a credential input of its own. Only a
 * row that does may write `apiKey`, and only under its own name — that is the
 * structural half of the fix for 8cb4a3f, where one shared key field meant Save
 * could file one provider's credential under another's.
 *
 * Providers that are stored but no longer supported still get a row: an install
 * that configured Finnhub before it was dropped would otherwise be left with an
 * inert credential it can neither see nor delete. They render no key field, so
 * whatever they hold is carried through untouched until the row is switched off.
 */
export function quoteProviderRows(stored) {
    const map = stored && typeof stored === 'object' ? stored : {};
    const rows = QUOTE_PROVIDERS.map((provider) => {
        const config = configOf(map, provider.name);
        const apiKey = typeof config?.apiKey === 'string' ? config.apiKey : '';
        return {
            ...provider,
            apiKey,
            keyField: true,
            // A provider that requires a key and has none is not configured —
            // quotes.js would skip every one of its securities with
            // `no_api_key`, so the key field is also its on switch. One that
            // needs no key is configured by being in the map at all, and gets
            // an explicit toggle instead.
            enabled: provider.needsKey ? apiKey !== '' : Object.hasOwn(map, provider.name),
        };
    });

    for (const name of Object.keys(map)) {
        if (KNOWN_PROVIDERS.has(name)) continue;
        rows.push({
            name,
            label: name,
            note: 'Stored by an older version. quotes.js does not know it, so it prices nothing.',
            needsKey: false,
            keyField: false,
            apiKey: '',
            enabled: true,
            unsupported: true,
        });
    }
    return rows;
}

/**
 * Merge this card's rows into the stored provider map — never replace it.
 * Replacing is the bug: it made configuring an equity provider erase CoinGecko,
 * silently, so a portfolio holding both stopped pricing half of itself.
 *
 * Three invariants, all load-bearing:
 *
 *  - `apiKey` is written only from a row that rendered its own key field, and
 *    only under that row's own name. A row with no field of its own never
 *    touches the stored key at all. Both halves matter: 8cb4a3f filed one
 *    provider's credential under another's name, and quotes.js forwards a
 *    stored CoinGecko key as `x_cg_demo_api_key` — so a crossed key is not
 *    inert, it is handed to the wrong vendor on the next refresh.
 *  - Nothing is destroyed that the user cannot see. Clearing a key field is how
 *    a key is removed, which is why every provider that accepts one renders it
 *    rather than being quietly rewritten behind a password mask.
 *  - Anything else in a provider's config (`minIntervalMs`, whatever a later
 *    version adds) survives, because this card does not own those fields.
 *
 * A name absent from `edits` is left exactly as stored.
 */
export function mergeQuoteProviders(stored, edits) {
    const next = { ...(stored && typeof stored === 'object' ? stored : {}) };
    for (const edit of edits ?? []) {
        const name = edit?.name;
        if (!name) continue;
        if (!edit.enabled) {
            delete next[name];
            continue;
        }
        const config = { ...(configOf(next, name) ?? {}) };
        if (edit.keyField) {
            if (edit.apiKey) config.apiKey = edit.apiKey;
            else delete config.apiKey;
        }
        next[name] = config;
    }
    return next;
}

// The .wg-toggle primitive as markup. js/components/wg-toggle.js has the same
// ten lines, but it is a window-global IIFE that nothing loads — wiring a script
// tag and a precache entry to reuse it costs more than it saves.
function toggleControl(checked, ariaLabel) {
    const node = ui.el('label', 'wg-toggle');
    const input = ui.el('input', 'wg-toggle__input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', ariaLabel);
    const track = ui.el('span', 'wg-toggle__track');
    track.setAttribute('aria-hidden', 'true');
    const knob = ui.el('span', 'wg-toggle__knob');
    knob.setAttribute('aria-hidden', 'true');
    node.append(input, track, knob);
    return { node, input };
}

function settingsRow(title, note, control) {
    const row = ui.el('div', 'wg-settings-row');
    const content = ui.el('div', 'wg-settings-row__content');
    content.appendChild(ui.el('p', 'wg-settings-row__title', title));
    content.appendChild(ui.el('p', 'wg-settings-row__desc', note));
    const slot = ui.el('div', 'wg-settings-row__control');
    slot.appendChild(control);
    row.append(content, slot);
    return row;
}

function quotesCard(rerender) {
    const rows = quoteProviderRows(state.settings?.quoteProviders);
    const nodes = [];
    const reads = [];

    for (const row of rows) {
        // A provider that requires a key needs no switch — the key is the
        // switch. Everything else gets an explicit one, which is also the only
        // way to delete a provider this build no longer supports.
        const toggle = row.needsKey ? null : toggleControl(row.enabled, `Use ${row.label}`);
        if (toggle) nodes.push(settingsRow(row.label, row.note, toggle.node));

        // Rendered with the stored key in it, so saving an untouched form keeps
        // it. A field that rendered blank for secrecy would read back as "no
        // key" and delete the credential on the next Save.
        const key = row.keyField
            ? ui.input(row.apiKey, { type: 'password', placeholder: toggle ? 'Optional key' : 'API key' })
            : null;
        if (key) {
            nodes.push(ui.field(toggle ? `${row.label} key` : `${row.label} API key`, key));
            nodes.push(ui.el('p', 'wg-muted text-sm m-0', toggle ? row.keyNote : row.note));
        }

        reads.push(() => ({
            name: row.name,
            keyField: row.keyField,
            // Only ever this row's own field, never another's.
            apiKey: key ? key.value.trim() : '',
            enabled: toggle ? toggle.input.checked : Boolean(key && key.value.trim()),
        }));
    }

    const save = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Save providers', async () => {
        // Merged against what is stored NOW, not the snapshot this card was
        // rendered from: a sync landing while the form sat open must not be
        // undone by pressing Save.
        await putSettings({
            quoteProviders: mergeQuoteProviders(state.settings?.quoteProviders, reads.map((read) => read())),
        });
        rerender();
    });

    return ui.card(
        ui.sectionLabel('Quote providers'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Configure every provider your portfolio needs — each security is priced by its own, so '
            + 'crypto and equities do not compete for one slot. Credentials stay on this device (and, '
            + 'once you sign up, inside the vault); quotes are fetched browser-direct so the server '
            + 'never learns your symbols.'),
        ...nodes,
        actionRow(save)
    );
}

function actionRow(button) {
    const actions = ui.el('div', 'flex-row flex-between gap-sm mt-md');
    actions.appendChild(ui.el('span', 'flex-1'));
    actions.appendChild(button);
    return actions;
}

// --- Sync ------------------------------------------------------------------

// The full picture, including the states the ambient strip stays quiet about:
// offline, a write still waiting on the debounce, and — the one that actually
// catches a sync that quietly stopped — when this device last got through.
//
// This card repaints ITSELF on every sync change rather than waiting for the
// screen to be re-rendered. The vault attaches asynchronously a moment after
// first paint, so a card rendered once at boot sits there saying "this device
// only" while the app is in fact syncing — a stale sync indicator, which is the
// one thing this bead exists to prevent. Repainting only this subtree also
// means a flush landing three seconds after a keystroke does not rebuild the
// form the user is typing into.
function syncCard(rerender) {
    const card = ui.card(ui.sectionLabel('Sync'));
    const body = ui.el('div');
    card.appendChild(body);

    const paint = () => {
        const snapshot = syncState();
        const desc = describeSync(snapshot, { online: navigator.onLine });
        const actions = snapshot.connected
            ? [{ label: 'Sync now', onClick: async () => { await syncNow(refresh); rerender(); } }]
            : [];
        // syncNotice returns its own card; unwrap it rather than nesting two.
        const children = [...ui.syncNotice(desc, actions).childNodes];
        if (snapshot.connected) {
            children.push(ui.el(
                'p',
                'wg-muted text-sm m-0 mt-md',
                `Vault ${snapshot.accountId} · state version ${snapshot.status?.version ?? 0}`
            ));
        }
        body.replaceChildren(...children);
    };

    const off = subscribeSync(() => {
        // The screen has moved on; drop the subscription with it rather than
        // repainting a detached node forever.
        if (!card.isConnected) off();
        else paint();
    });
    paint();
    return card;
}

// --- Accounts --------------------------------------------------------------

function accountModal(record, rerender) {
    const name = ui.input(record?.name ?? '', { placeholder: 'Broker cash' });
    const kind = ui.select([
        { value: 'cash', label: 'Cash' },
        { value: 'securities', label: 'Securities' },
    ], record?.kind ?? 'cash');
    const currency = ui.input(record?.currency ?? reportingCurrency());
    const closed = ui.select([
        { value: 'no', label: 'Open' },
        { value: 'yes', label: 'Closed' },
    ], record?.closed ? 'yes' : 'no');
    const errorSlot = ui.el('div', 'wg-error-slot');

    ui.modal({
        title: record ? 'Edit account' : 'New account',
        body: [
            errorSlot,
            ui.field('Name', name),
            ui.fieldRow(ui.field('Kind', kind), ui.field('Currency', currency)),
            ui.field('Status', closed),
        ],
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            {
                label: 'Save',
                className: 'wg-gloss wg-gloss--sun wg-gloss--lg',
                onClick: async (close) => {
                    if (!name.value.trim()) {
                        errorSlot.replaceChildren(ui.messages(['Name the account.']));
                        return;
                    }
                    await putAccount(record?.recordId ?? null, {
                        name: name.value.trim(),
                        kind: kind.value,
                        currency: currency.value.trim().toUpperCase() || reportingCurrency(),
                        closed: closed.value === 'yes',
                    });
                    close();
                    rerender();
                },
            },
        ],
    });
}

function securityModal(record, rerender) {
    const name = ui.input(record?.name ?? '', { placeholder: 'Vanguard FTSE All-World' });
    const ticker = ui.input(record?.ticker ?? '', { placeholder: 'VWCE' });
    const isin = ui.input(record?.isin ?? '', { placeholder: 'IE00BK5BQT80' });
    const wkn = ui.input(record?.wkn ?? '', { placeholder: 'A2PKXG' });
    const currency = ui.input(record?.currency ?? reportingCurrency());
    // §4: absent assetClass means *unclassified*, and the UI says so rather than
    // inferring one from the name — a wrong class silently mis-buckets the
    // allocation breakdown, and a guess is worse than a blank because it looks
    // like knowledge.
    const assetClass = ui.select([
        { value: '', label: 'Unclassified' },
        ...ASSET_CLASSES.map((c) => ({ value: c, label: c })),
    ], record?.assetClass ?? '');
    // §4's `quote: { provider, symbol }`. BOTH halves, because quotes.js needs
    // both to fetch anything — it routes every security through its own
    // `quote.provider` and skips a security with either missing as
    // `no_quote_config`. This form collected only the symbol, so every security
    // created in the app was unfetchable and Refresh could never price one.
    const quoteProvider = ui.select([
        { value: '', label: 'None — price by hand' },
        ...QUOTE_PROVIDERS.map((p) => ({ value: p.name, label: p.label })),
    ], record?.quote?.provider ?? '');
    const quoteSymbol = ui.input(record?.quote?.symbol ?? '', { placeholder: 'Provider symbol' });
    const errorSlot = ui.el('div', 'wg-error-slot');

    ui.modal({
        title: record ? 'Edit security' : 'New security',
        body: [
            errorSlot,
            ui.field('Name', name),
            ui.fieldRow(ui.field('Ticker', ticker), ui.field('Currency', currency)),
            ui.fieldRow(ui.field('ISIN', isin), ui.field('WKN', wkn)),
            ui.fieldRow(ui.field('Asset class', assetClass), ui.field('Quote provider', quoteProvider)),
            ui.field('Quote symbol', quoteSymbol),
            ui.el('p', 'wg-muted text-sm m-0',
                'The symbol is the provider\'s own, not the exchange ticker: CoinGecko wants a coin id '
                + '(bitcoin), Twelve Data wants a ticker (AAPL). A wrong one comes back as "no close" '
                + 'rather than a wrong price.'),
        ],
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            {
                label: 'Save',
                className: 'wg-gloss wg-gloss--sun wg-gloss--lg',
                onClick: async (close) => {
                    if (!name.value.trim()) {
                        errorSlot.replaceChildren(ui.messages(['Name the security.']));
                        return;
                    }
                    // Anything else already on `quote` survives; the provider
                    // key is removed rather than stored empty, so "None" reads
                    // back as unset instead of as a provider named "".
                    const quote = { ...(record?.quote ?? {}), symbol: quoteSymbol.value.trim() };
                    if (quoteProvider.value) quote.provider = quoteProvider.value;
                    else delete quote.provider;
                    const body = {
                        name: name.value.trim(),
                        currency: currency.value.trim().toUpperCase() || reportingCurrency(),
                        quote,
                    };
                    for (const [key, control] of [['ticker', ticker], ['isin', isin], ['wkn', wkn]]) {
                        const v = control.value.trim();
                        if (v) body[key] = v;
                    }
                    if (assetClass.value) body.assetClass = assetClass.value;
                    await putSecurity(record?.recordId ?? null, body);
                    close();
                    rerender();
                },
            },
        ],
    });
}

function recordsCard({ label, noun, plural, items, describe, onOpen, type, rerender }) {
    const head = ui.el('div', 'flex-row flex-between gap-sm wg-toolbar');
    head.appendChild(ui.sectionLabel(label));
    head.appendChild(ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Add', () => onOpen(null), {
        iconName: 'plus',
    }));

    const body = items.length === 0
        ? ui.emptyState(`No ${plural ?? `${noun}s`} yet.`)
        : ui.list(items.map((item) => ui.row({
            title: item.name ?? item.recordId,
            subtitle: describe(item),
            onOpen: () => onOpen(item),
            onDelete: () => ui.confirm({
                title: `Delete ${noun}`,
                message: `Delete ${item.name ?? item.recordId}? Transactions referring to it stay, `
                    + 'and the engine will report them as unresolved.',
                onConfirm: async () => { await remove(type, item.recordId); rerender(); },
            }),
            deleteLabel: `Delete ${noun}`,
        })));

    return ui.card(head, body);
}

// --- Import / export -------------------------------------------------------

// A successful import must survive the re-render it causes. importRecords()
// calls refresh(), which re-renders this screen and detaches resultSlot, so a
// report written to the slot afterwards is never seen — the user imports, sees
// nothing, and imports again. Parking it here means the rebuilt card renders
// it. (Re-importing is harmless — ids are derived from the file — but "did that
// work?" is exactly the question the report exists to answer.)
let lastImport = null;

function importCard(rerender) {
    const file = ui.input('', { type: 'file' });
    file.accept = '.xml,.csv,text/csv,text/xml';
    const resultSlot = ui.el('div', 'wg-error-slot');
    if (lastImport) resultSlot.replaceChildren(ui.messages(lastImport.lines, lastImport.tone));

    file.addEventListener('change', async () => {
        const chosen = file.files && file.files[0];
        if (!chosen) return;
        resultSlot.replaceChildren(ui.emptyState(`Reading ${chosen.name}…`));
        let text;
        try {
            text = await chosen.text();
        } catch (err) {
            resultSlot.replaceChildren(ui.messages([`Could not read the file: ${err.message}`]));
            return;
        }

        const { format, records: parsed, report } = parsePP(text);
        const lines = [
            `Format: ${format ?? 'unrecognised'}`,
            `Source rows: ${report.counts.sourceRows} · imported ${report.counts.imported}`
            + ` · merged ${report.counts.merged} · skipped ${report.counts.skipped}`,
        ];
        if (parsed.length === 0) {
            resultSlot.replaceChildren(ui.messages([
                ...lines,
                ...report.entries.slice(0, 8).map((e) => `${e.severity} ${e.code}: ${e.message}`),
            ]));
            return;
        }

        let written = 0;
        try {
            written = await importRecords(parsed);
        } catch (err) {
            resultSlot.replaceChildren(ui.messages([`Import failed after ${written} records: ${err.message}`]));
            return;
        }

        lastImport = {
            lines: [
                `Wrote ${written} records.`,
                ...lines,
                // The report is the contract for anything the parser reinterpreted
                // — §4 says a reinterpretation must never be silent.
                ...report.entries.slice(0, 8).map((e) => `${e.severity} ${e.code}: ${e.message}`),
            ],
            tone: report.ok ? 'normal' : 'alert',
        };
        file.value = '';
        rerender();
    });

    return ui.card(
        ui.sectionLabel('Import from Portfolio Performance'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Pick a PP .xml or a CSV export. Ids are derived from the file, so importing '
            + 'the same file twice updates rather than duplicates.'),
        ui.field('File', file),
        resultSlot
    );
}

function exportCard() {
    const status = ui.el('div', 'wg-error-slot');
    const download = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Export JSON', async () => {
        try {
            const payload = await exportAll();
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = ui.el('a');
            link.href = url;
            link.download = `myportfolio-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            // Revoking immediately can race the download on some engines; one
            // turn of the event loop is enough and costs nothing.
            setTimeout(() => URL.revokeObjectURL(url), 0);
            status.replaceChildren(ui.messages([`Exported ${payload.records.length} records.`], 'normal'));
        } catch (err) {
            status.replaceChildren(ui.messages([`Export failed: ${err.message}`]));
        }
    });

    const row = ui.el('div', 'flex-row flex-between gap-sm');
    row.appendChild(ui.el('span', 'flex-1'));
    row.appendChild(download);

    return ui.card(
        ui.sectionLabel('Export'),
        ui.el('p', 'wg-muted text-sm m-0',
            'Every live record as plain JSON — tombstones excluded. This is a backup you can read, '
            + 'not an encrypted blob.'),
        row,
        status
    );
}

export function render(container) {
    const rerender = () => render(container);
    const accountBalances = new Map((state.snapshot?.accounts ?? []).map((a) => [a.accountId, a.balance]));

    container.replaceChildren(
        syncCard(rerender),
        generalCard(rerender),
        quotesCard(rerender),
        recordsCard({
            label: 'Accounts',
            noun: 'account',
            items: state.accounts,
            type: RECORD.account,
            rerender,
            describe: (a) => [
                a.kind ?? 'cash',
                a.currency ?? '',
                accountBalances.has(a.recordId) ? fmt.money(accountBalances.get(a.recordId)) : null,
                a.closed ? 'closed' : null,
            ].filter(Boolean).join(' · '),
            onOpen: (record) => accountModal(record, rerender),
        }),
        recordsCard({
            label: 'Securities',
            noun: 'security',
            plural: 'securities',
            items: state.securities,
            type: RECORD.security,
            rerender,
            // The quote route is part of a security's identity now that
            // Holdings can fetch: "which of these will Refresh actually price"
            // has to be answerable without opening every row.
            describe: (s) => [
                s.ticker, s.isin, s.currency, s.assetClass ?? 'unclassified',
                s.quote?.provider && s.quote?.symbol ? `${s.quote.provider}:${s.quote.symbol}` : 'no quote',
            ].filter(Boolean).join(' · '),
            onOpen: (record) => securityModal(record, rerender),
        }),
        importCard(rerender),
        exportCard()
    );
}
