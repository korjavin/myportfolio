// Transactions — add / edit / delete. Quick-add is the primary interaction of
// the whole app, so it is one tap from the screen and one modal deep, with the
// date prefilled and focus already in the first field.
//
// No arithmetic happens here. Strings become §5 integers in forms.js
// (parseFixed) and integers become strings in fmt.js (formatFixed); this file
// only moves the resulting record through the port. The shares x price = amount
// derivation is likewise forms.js's (deriveTxField) — this file decides only
// WHICH of the two derived fields to refresh, never what the number is.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import {
    buildTxBody, emptyTxForm, txToForm, defaultPortfolioId, deriveTxField,
    SECURITY_TYPES, SHARE_TYPES,
} from './forms.js';
import { TX_TYPES, RECORD } from '../../../domain/schema.js';
import { state, putTransaction, putAccount, putSecurity, remove, reportingCurrency } from './store.js';

const NEW = '__new__';

// Filter strip. "Trades" is the security-bearing set, "Cash" the rest — the
// split a phone screen actually needs, not one tab per §4 type.
const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'trades', label: 'Trades' },
    { id: 'cash', label: 'Cash' },
];

let filter = 'all';

function securityLabel(sec) {
    if (!sec) return 'Unknown security';
    return sec.ticker ? `${sec.ticker} · ${sec.name ?? ''}`.trim().replace(/ ·\s*$/, '') : (sec.name ?? sec.recordId);
}

function matchesFilter(tx) {
    if (filter === 'trades') return Boolean(tx.securityId);
    if (filter === 'cash') return !tx.securityId;
    return true;
}

/**
 * A select over existing records plus an inline "+ New …" option that reveals a
 * name field in the same modal. Creating an account or a security must not cost
 * a trip to another screen — that is three taps between a user and their first
 * transaction, and the first transaction is the one that decides whether they
 * keep the app.
 */
function entityPicker({ label, noun, options, value }) {
    const sel = ui.select([
        { value: '', label: `Select ${noun}…` },
        ...options,
        { value: NEW, label: `+ New ${noun}…` },
    ], value ?? '');

    const nameInput = ui.input('', { placeholder: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} name` });
    const nameField = ui.field(`New ${noun}`, nameInput);
    nameField.classList.add('hidden');

    sel.addEventListener('change', () => {
        nameField.classList.toggle('hidden', sel.value !== NEW);
        if (sel.value === NEW) nameInput.focus();
    });

    return {
        nodes: [ui.field(label, sel), nameField],
        isNew: () => sel.value === NEW,
        newName: () => nameInput.value.trim(),
        value: () => (sel.value === NEW ? '' : sel.value),
        setError: (msg) => { nameInput.setCustomValidity?.(msg); },
    };
}

/**
 * Open the add/edit form. `defaults` prefills a new transaction — Holdings uses
 * it to open a Buy on the position the user is already looking at, so the
 * quick-add stays one tap from wherever the intent formed.
 */
export function openTxModal(record, defaults) {
    const editing = Boolean(record);
    const values = editing ? txToForm(record) : emptyTxForm(defaults);

    const typeSel = ui.select(TX_TYPES.map((t) => ({ value: t, label: fmt.txTypeLabel(t) })), values.type);
    const dateInput = ui.input(values.date, { type: 'date' });

    // §4 gives the two legs different account KINDS, so each picker offers one
    // kind and never the other: a cash account is not a place shares can land.
    // An account with no kind is cash — that is what quick-add creates and what
    // Settings defaults to.
    const isDepot = (a) => a.kind === 'securities';
    const depots = state.accounts.filter(isDepot);

    const options = (accounts) => accounts.map((a) => ({ value: a.recordId, label: a.name ?? a.recordId }));

    // The kind filter is about which account a NEW record may name. A stored id
    // it hides — the account was deleted, or its kind was changed after the
    // record was written — would be dropped by ui.select's fall back to the
    // first option, so an edit of a historical record either refuses to save
    // (the cash leg, which is required) or silently un-attributes it (the
    // shares leg on a dividend, which is not). Carrying the stored value as its
    // own option keeps an edit lossless and leaves re-attributing deliberate.
    const withStored = (opts, storedId) => {
        if (!storedId || opts.some((o) => o.value === storedId)) return opts;
        const stored = state.accounts.find((a) => a.recordId === storedId);
        return [...opts, { value: storedId, label: stored?.name ?? storedId }];
    };

    const account = entityPicker({
        label: 'Account (cash moves here)',
        noun: 'account',
        options: withStored(options(state.accounts.filter((a) => !isDepot(a))), values.accountId),
        value: values.accountId,
    });
    const portfolio = entityPicker({
        label: 'Securities account (shares land here)',
        noun: 'depot',
        options: withStored(options(depots), values.portfolioId),
        value: defaultPortfolioId({
            stored: values.portfolioId,
            depotIds: depots.map((a) => a.recordId),
            editing,
        }),
    });
    const security = entityPicker({
        label: 'Security',
        noun: 'security',
        options: state.securities.map((s) => ({ value: s.recordId, label: securityLabel(s) })),
        value: values.securityId,
    });

    const sharesInput = ui.input(values.shares, { inputMode: 'decimal', placeholder: '0' });
    const priceInput = ui.input('', { inputMode: 'decimal', placeholder: '0.00' });
    const amountInput = ui.input(values.amount, { inputMode: 'decimal', placeholder: '0.00' });
    const feesInput = ui.input(values.fees, { inputMode: 'decimal', placeholder: '0.00' });
    const taxesInput = ui.input(values.taxes, { inputMode: 'decimal', placeholder: '0.00' });
    const noteInput = ui.input(values.note, { placeholder: 'Optional' });

    const securityBlock = ui.el('div', 'wg-field-group');
    for (const node of [...security.nodes, ...portfolio.nodes]) securityBlock.appendChild(node);
    // Shares and price share a row and a fate: a deposit has neither.
    const tradeRow = ui.fieldRow(
        ui.field('Shares', sharesInput),
        ui.field(`Price / share (${values.currency || reportingCurrency()})`, priceInput),
    );

    // Which of {amount, price} is the COMPUTED one. Last-edited-wins with no
    // mode toggle: typing in one makes the other the derived one, so the field
    // under the cursor is never rewritten mid-keystroke.
    let derived = 'price';

    function recompute() {
        // A deposit has no price, and nothing may touch its amount.
        if (!SHARE_TYPES.has(typeSel.value)) return;
        const out = deriveTxField(derived, {
            type: typeSel.value,
            shares: sharesInput.value,
            price: priceInput.value,
            amount: amountInput.value,
            fees: feesInput.value,
            taxes: taxesInput.value,
        });
        // Not enough typed yet — leave what the user has rather than blanking it.
        if (out === '') return;
        // Store what is displayed: this rounded string is what buildTxBody
        // parses on save, so the record can never hold a number never shown.
        (derived === 'amount' ? amountInput : priceInput).value = out;
    }

    amountInput.addEventListener('input', () => { derived = 'price'; recompute(); });
    priceInput.addEventListener('input', () => { derived = 'amount'; recompute(); });
    // Shares, fees and taxes feed both directions, so they only refresh whichever
    // field is currently the derived one.
    for (const node of [sharesInput, feesInput, taxesInput]) {
        node.addEventListener('input', recompute);
    }

    // Which fields a type may carry is §4's, not this screen's. Show only the
    // ones that mean something so a cash deposit is a two-field form.
    function applyType() {
        const type = typeSel.value;
        securityBlock.classList.toggle('hidden', !SECURITY_TYPES.has(type));
        tradeRow.classList.toggle('hidden', !SHARE_TYPES.has(type));
        // buy and sell put fees on opposite sides of the gross value, and the
        // opening call fills in the implied price of a stored transaction —
        // price is derived on read, it is not a column on the record.
        recompute();
    }
    typeSel.addEventListener('change', applyType);
    applyType();

    const errorSlot = ui.el('div', 'wg-error-slot');

    const body = [
        errorSlot,
        ui.fieldRow(ui.field('Type', typeSel), ui.field('Date', dateInput)),
        ...account.nodes,
        securityBlock,
        tradeRow,
        // Label with the transaction's own currency so a preserved foreign
        // currency is visible rather than merely un-erased.
        ui.field(`Amount (${values.currency || reportingCurrency()})`, amountInput),
        ui.fieldRow(ui.field('Fees', feesInput), ui.field('Taxes', taxesInput)),
        ui.field('Note', noteInput),
    ];

    const dialog = ui.modal({
        title: editing ? 'Edit transaction' : 'Add transaction',
        body,
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            { label: 'Save', className: 'wg-gloss wg-gloss--sun wg-gloss--lg', onClick: save },
        ],
    });

    function showErrors(errors) {
        errorSlot.replaceChildren();
        const node = ui.messages(errors);
        if (node) errorSlot.appendChild(node);
    }

    async function save(close) {
        const type = typeSel.value;
        let accountId = account.value();
        let portfolioId = portfolio.value();
        let securityId = security.value();

        // Resolve the inline "+ New …" pickers first: a transaction that names
        // an account which does not exist yet is not a transaction.
        try {
            if (account.isNew()) {
                if (!account.newName()) return showErrors(['Name the new account.']);
                accountId = await putAccount(null, {
                    name: account.newName(),
                    // Cash, because quick-add's job is the account the money
                    // moves on (§4: `accountId` is that account for every
                    // transaction type, with no per-type branching). A
                    // securities-kind account is created from Settings, where
                    // the distinction is visible and deliberate.
                    kind: 'cash',
                    currency: reportingCurrency(),
                    closed: false,
                });
            }
            if (SECURITY_TYPES.has(type) && portfolio.isNew()) {
                if (!portfolio.newName()) return showErrors(['Name the new securities account.']);
                portfolioId = await putAccount(null, {
                    name: portfolio.newName(),
                    // Securities, unlike the cash picker above: this is the
                    // account the shares land in, and §4 keys the position by
                    // it. Creating it here is what keeps a first trade one
                    // modal deep for a user who has never opened Settings.
                    kind: 'securities',
                    currency: reportingCurrency(),
                    closed: false,
                });
            }
            if (SECURITY_TYPES.has(type) && security.isNew()) {
                if (!security.newName()) return showErrors(['Name the new security.']);
                securityId = await putSecurity(null, {
                    name: security.newName(),
                    currency: reportingCurrency(),
                    // assetClass is deliberately absent: §4 says absent means
                    // *unclassified* and a guessed class silently mis-buckets
                    // the allocation chart. Set it from Settings.
                    quote: {},
                });
            }
        } catch (err) {
            return showErrors([`Could not save: ${err.message}`]);
        }

        const { body: txBody, errors } = buildTxBody({
            type,
            date: dateInput.value,
            accountId,
            portfolioId,
            securityId,
            shares: sharesInput.value,
            amount: amountInput.value,
            fees: feesInput.value,
            taxes: taxesInput.value,
            note: noteInput.value,
            // The transaction's OWN currency, never the current reporting
            // currency. Overwriting it on edit would silence portfolio.js's
            // `currency_not_converted` issue and make the engine add an
            // imported USD amount straight into a EUR total — a silent
            // misvaluation triggered by opening a form and pressing Save.
            // Multi-currency conversion is B8; until then the engine's job is
            // to warn, and this form's job is not to erase what it warns about.
            currency: values.currency || reportingCurrency(),
        });
        if (errors.length > 0) return showErrors(errors);

        try {
            await putTransaction(record?.recordId ?? null, txBody);
        } catch (err) {
            return showErrors([`Could not save: ${err.message}`]);
        }
        close();
    }

    return dialog;
}

export function render(container) {
    const securities = new Map(state.securities.map((s) => [s.recordId, s]));
    const accounts = new Map(state.accounts.map((a) => [a.recordId, a]));

    const head = ui.toolbar({
        options: FILTERS,
        active: filter,
        onSelect: (id) => { filter = id; render(container); },
        primary: { label: 'Add', icon: 'plus', onClick: () => openTxModal(null) },
    });

    const rows = state.transactions
        .filter(matchesFilter)
        // Newest first: the thing just added must be the thing at the top, or
        // the primary interaction has no visible result.
        .sort((a, b) => String(b.date).localeCompare(String(a.date))
            || String(b.recordId).localeCompare(String(a.recordId)));

    const body = rows.length === 0
        ? ui.card(ui.emptyState(
            state.transactions.length === 0
                ? 'No transactions yet. Tap Add — the first one creates its account as you go.'
                : 'No transactions match this filter.'))
        : ui.list(rows.map((tx) => {
            const sec = tx.securityId ? securities.get(tx.securityId) : null;
            const account = accounts.get(tx.accountId);
            const parts = [String(tx.date ?? '').slice(0, 10)];
            if (Number.isSafeInteger(tx.shares) && tx.shares !== 0) parts.push(`${fmt.shares(tx.shares)} sh`);
            if (account) parts.push(account.name ?? account.recordId);
            return ui.row({
                title: sec ? securityLabel(sec) : fmt.txTypeLabel(tx.type),
                subtitle: `${sec ? `${fmt.txTypeLabel(tx.type)} · ` : ''}${parts.join(' · ')}`,
                value: fmt.money(tx.amount),
                onOpen: () => openTxModal(tx),
                onDelete: () => ui.confirm({
                    title: 'Delete transaction',
                    message: `Delete this ${fmt.txTypeLabel(tx.type).toLowerCase()} of ${fmt.money(tx.amount)}? `
                        + 'Holdings and performance recompute immediately.',
                    onConfirm: () => remove(RECORD.transaction, tx.recordId),
                }),
                deleteLabel: 'Delete transaction',
            });
        }));

    container.replaceChildren(head, body);
}
