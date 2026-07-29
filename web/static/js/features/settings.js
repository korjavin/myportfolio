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
    state, putSettings, putAccount, putSecurity, remove,
    importRecords, exportAll, reportingCurrency, DEFAULT_CURRENCY,
} from './store.js';

// §7: browser-direct with the user's own key is the default, so the server
// never learns which symbols you hold. CoinGecko's free tier is keyless; the
// equity providers all need one. Yahoo is absent on purpose — it blocks CORS
// and cannot be used browser-direct at all.
const PROVIDERS = [
    { value: '', label: 'None' },
    { value: 'coingecko', label: 'CoinGecko (crypto, keyless)' },
    { value: 'finnhub', label: 'Finnhub' },
    { value: 'twelvedata', label: 'Twelve Data' },
    { value: 'alphavantage', label: 'Alpha Vantage' },
];

function generalCard(rerender) {
    const currency = ui.input(reportingCurrency(), { placeholder: DEFAULT_CURRENCY });
    const providers = state.settings.quoteProviders ?? {};
    const active = Object.keys(providers)[0] ?? '';
    const providerSel = ui.select(PROVIDERS, active);
    const apiKey = ui.input(providers[active]?.apiKey ?? '', { type: 'password', placeholder: 'API key' });

    // Repopulate the key when the provider changes. Without this the field keeps
    // showing the previously selected provider's key, and Save then stores it
    // under the NEW provider — so the next quote fetch sends your Finnhub
    // credential to Alpha Vantage. Handing one provider's secret to another is
    // the kind of bug a password field hides, since nobody can see it happen.
    providerSel.addEventListener('change', () => {
        apiKey.value = providers[providerSel.value]?.apiKey ?? '';
    });

    const save = ui.button('wg-toolbar-btn wg-toolbar-btn--primary', 'Save', async () => {
        const patch = { reportingCurrency: currency.value.trim().toUpperCase() || DEFAULT_CURRENCY };
        patch.quoteProviders = providerSel.value
            ? { [providerSel.value]: { apiKey: apiKey.value.trim() } }
            : {};
        await putSettings(patch);
        rerender();
    });

    const actions = ui.el('div', 'flex-row flex-between gap-sm mt-md');
    actions.appendChild(ui.el('span', 'flex-1'));
    actions.appendChild(save);

    return ui.card(
        ui.sectionLabel('General'),
        ui.field('Reporting currency', currency),
        ui.el('p', 'wg-muted text-sm m-0',
            'Quote provider credentials stay on this device (and, once you sign up, inside the '
            + 'vault). Quotes are fetched browser-direct so the server never learns your symbols.'),
        ui.fieldRow(ui.field('Quote provider', providerSel), ui.field('API key', apiKey)),
        actions
    );
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
    const quoteSymbol = ui.input(record?.quote?.symbol ?? '', { placeholder: 'Provider symbol' });
    const errorSlot = ui.el('div', 'wg-error-slot');

    ui.modal({
        title: record ? 'Edit security' : 'New security',
        body: [
            errorSlot,
            ui.field('Name', name),
            ui.fieldRow(ui.field('Ticker', ticker), ui.field('Currency', currency)),
            ui.fieldRow(ui.field('ISIN', isin), ui.field('WKN', wkn)),
            ui.fieldRow(ui.field('Asset class', assetClass), ui.field('Quote symbol', quoteSymbol)),
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
                    const body = {
                        name: name.value.trim(),
                        currency: currency.value.trim().toUpperCase() || reportingCurrency(),
                        quote: { ...(record?.quote ?? {}), symbol: quoteSymbol.value.trim() },
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
        generalCard(rerender),
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
            describe: (s) => [s.ticker, s.isin, s.currency, s.assetClass ?? 'unclassified']
                .filter(Boolean).join(' · '),
            onOpen: (record) => securityModal(record, rerender),
        }),
        importCard(rerender),
        exportCard()
    );
}
