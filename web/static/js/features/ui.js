// Shared DOM construction for the five screens.
//
// Everything here is `document.createElement` + class names. Two rules it is
// holding the line on, both enforced by the guard tests:
//
//   - No inline styles. JS sets classes; css/styles.css resolves every value.
//     The one escape hatch used below is `.style.setProperty('--fill-pct', …)`,
//     a neutral custom property (NOT a --wg-* token) that a CSS class consumes
//     to size the allocation bars. It is the documented exception in
//     architecture.inline-styles.test.js, and it carries no colour.
//   - No innerHTML with on*= handlers. The served CSP is `script-src 'self'`
//     with no 'unsafe-inline', so an inline handler is dropped silently and the
//     UI is dead only in production.
//
// Icons come from the WGIcons registry (a classic script on window), never a
// hand-written inline <svg>.

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

export function icon(name, size = 18) {
    if (!window.WGIcons) throw new Error('ui: wg-icons.js must load before the screens');
    return window.WGIcons.iconSvg(name, { size, stroke: 1.8 });
}

export function button(className, label, onClick, { iconName } = {}) {
    const btn = el('button', className);
    btn.type = 'button';
    if (iconName) btn.appendChild(icon(iconName, 16));
    if (label) btn.appendChild(el('span', null, label));
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
}

export function iconButton(iconName, label, onClick, extraClass) {
    const btn = el('button', extraClass ? `wg-icon-btn ${extraClass}` : 'wg-icon-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const skin = el('span', 'wg-gloss');
    skin.appendChild(icon(iconName, 16));
    btn.appendChild(skin);
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
}

/**
 * The canonical toolbar row: a segmented strip on the left, the primary action
 * as an inline `.wg-toolbar-btn--primary` pill on the right (ARCHITECTURE.md
 * §9). Never a floating FAB and never a bottom CTA dock — the sibling project
 * shipped both and retired both, and architecture.wg-primitives.test.js keeps
 * their class names out of the stylesheet.
 */
export function toolbar({ options = [], active, onSelect, primary } = {}) {
    const row = el('div', 'flex-row flex-between gap-sm wg-toolbar');
    if (options.length === 0) {
        // Keeps the primary pill on the right where it always sits, even on a
        // screen with nothing to segment.
        row.appendChild(el('span', 'flex-1'));
    }
    const strip = el('div', 'wg-gloss wg-gloss--inset flex-row gap-sm wg-range-strip');
    for (const opt of options) {
        const isActive = opt.id === active;
        const btn = button(
            isActive ? 'wg-toolbar-btn wg-gloss wg-gloss--sun' : 'wg-toolbar-btn wg-toolbar-btn--secondary',
            opt.label,
            () => onSelect && onSelect(opt.id)
        );
        if (isActive) btn.setAttribute('aria-current', 'true');
        strip.appendChild(btn);
    }
    if (options.length > 0) row.appendChild(strip);
    if (primary) {
        row.appendChild(button('wg-toolbar-btn wg-toolbar-btn--primary', primary.label, primary.onClick, {
            iconName: primary.icon,
        }));
    }
    return row;
}

/** A label + value stat cell. */
export function stat(label, valueNode) {
    const item = el('div', 'stat-item');
    item.appendChild(el('span', 'stat-label', label));
    const value = el('span', 'stat-value');
    value.appendChild(typeof valueNode === 'string' ? document.createTextNode(valueNode) : valueNode);
    item.appendChild(value);
    return item;
}

/**
 * A gain/loss pill. `variantClass` comes from fmt.deltaClass, whose ▲/▼/—
 * glyph is emitted by CSS — callers must not colour a bare number instead.
 */
export function delta(variantClass, text, { bare = false } = {}) {
    return el('span', `wg-delta ${variantClass}${bare ? ' wg-delta--bare' : ''}`, text);
}

export function sectionLabel(text) {
    // Not a section-header banner: this is the inline in-card divider from the
    // design system. Screens still carry no header — the active nav pill is the
    // sole screen indicator (§9).
    const wrap = el('div', 'wg-section-label');
    wrap.appendChild(el('span', null, text));
    return wrap;
}

export function emptyState(message) {
    return el('p', 'empty-state-msg m-0', message);
}

export function card(...children) {
    const node = el('div', 'wg-card');
    for (const child of children) if (child) node.appendChild(child);
    return node;
}

// --- Fields ----------------------------------------------------------------

let fieldSeq = 0;

export function field(labelText, control) {
    const wrap = el('div', 'wg-field');
    const id = control.id || `f${(fieldSeq += 1)}`;
    control.id = id;
    const label = el('label', 'wg-label', labelText);
    label.htmlFor = id;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
}

export function fieldRow(...fields) {
    const row = el('div', 'wg-field--row');
    for (const f of fields) if (f) row.appendChild(f);
    return row;
}

export function input(value, { type = 'text', inputMode, placeholder, step } = {}) {
    const node = el('input', 'wg-input');
    node.type = type;
    if (inputMode) node.inputMode = inputMode;
    if (placeholder) node.placeholder = placeholder;
    if (step) node.step = step;
    node.value = value ?? '';
    return node;
}

export function select(options, value) {
    const node = el('select', 'wg-select');
    for (const opt of options) {
        const o = el('option', null, opt.label);
        o.value = opt.value;
        node.appendChild(o);
    }
    node.value = value ?? '';
    // A value with no matching <option> silently selects nothing; fall back to
    // the first real option so a form can never submit an empty foreign key it
    // never showed the user.
    if (node.selectedIndex < 0 && node.options.length > 0) node.selectedIndex = 0;
    return node;
}

// --- Rows ------------------------------------------------------------------

/**
 * A tappable list row: the whole row opens the editor, with an optional
 * trailing delete button outside the tap target (nesting a button inside a
 * button is invalid HTML and breaks keyboard activation).
 */
export function row({ title, subtitle, value, valueNode, onOpen, onDelete, deleteLabel = 'Delete' }) {
    const li = el('li', 'wg-row');

    const tap = el('button', 'wg-row__tap');
    tap.type = 'button';
    const main = el('span', 'wg-row__main');
    main.appendChild(el('span', 'wg-row__title', title));
    if (subtitle) main.appendChild(el('span', 'wg-row__sub', subtitle));
    tap.appendChild(main);

    const end = el('span', 'wg-row__end');
    if (value !== undefined && value !== null) end.appendChild(el('span', 'wg-row__value', value));
    if (valueNode) end.appendChild(valueNode);
    tap.appendChild(end);

    if (onOpen) tap.addEventListener('click', onOpen);
    else tap.disabled = true;
    li.appendChild(tap);

    if (onDelete) li.appendChild(iconButton('trash', deleteLabel, onDelete, 'wg-row__action'));
    return li;
}

export function list(children) {
    const ul = el('ul', 'list-reset wg-list');
    for (const child of children) ul.appendChild(child);
    return ul;
}

/** A proportional bar for the allocation breakdown. */
export function allocBar(label, valueText, basisPoints) {
    const wrap = el('div', 'wg-alloc');
    const head = el('div', 'wg-alloc__head');
    head.appendChild(el('span', 'wg-alloc__label', label));
    head.appendChild(el('span', 'wg-alloc__value', valueText));
    wrap.appendChild(head);
    const track = el('div', 'wg-alloc__track');
    const fill = el('div', 'wg-alloc__fill');
    // Neutral custom property, not a --wg-* token: a structural percentage that
    // the .wg-alloc__fill class turns into a width. No colour crosses here.
    fill.style.setProperty('--fill-pct', `${(basisPoints / 100).toFixed(2)}%`);
    track.appendChild(fill);
    wrap.appendChild(track);
    return wrap;
}

// --- Modal -----------------------------------------------------------------

/**
 * The shared modal shell (§9: `.wg-modal` + __header/__title/__body/__actions),
 * never a per-section variant. Returns `close()`.
 */
export function modal({ title, body, actions = [], onClose }) {
    const backdrop = el('div', 'wg-modal-backdrop');
    const box = el('div', 'wg-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const header = el('div', 'wg-modal__header');
    const heading = el('h3', 'wg-modal__title', title);
    header.appendChild(heading);

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown);
        backdrop.remove();
        box.remove();
        if (onClose) onClose();
    }
    function onKeydown(event) {
        if (event.key === 'Escape') close();
    }

    header.appendChild(iconButton('close', 'Close', close));
    box.appendChild(header);

    const bodyEl = el('div', 'wg-modal__body');
    for (const child of [].concat(body)) if (child) bodyEl.appendChild(child);
    box.appendChild(bodyEl);

    if (actions.length > 0) {
        const actionsEl = el('div', 'wg-modal__actions mt-md');
        for (const action of actions) {
            actionsEl.appendChild(button(
                action.className || 'wg-gloss wg-gloss--lg',
                action.label,
                () => action.onClick(close)
            ));
        }
        box.appendChild(actionsEl);
    }

    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(backdrop);
    document.body.appendChild(box);

    const firstControl = box.querySelector('.wg-input, .wg-select');
    if (firstControl) firstControl.focus();

    return { close, box, bodyEl };
}

/** Destructive confirm. Reuses the modal shell rather than window.confirm. */
export function confirm({ title, message, confirmLabel = 'Delete', onConfirm }) {
    return modal({
        title,
        body: [el('p', 'mt-confirm-modal__message', message)],
        actions: [
            { label: 'Cancel', className: 'wg-gloss wg-gloss--lg', onClick: (close) => close() },
            {
                label: confirmLabel,
                className: 'wg-gloss wg-gloss--clay wg-gloss--lg',
                onClick: (close) => { close(); onConfirm(); },
            },
        ],
    });
}

/** A non-blocking inline error list, for form validation and import reports. */
export function messages(items, variant = 'alert') {
    if (!items || items.length === 0) return null;
    const wrap = el('div', 'wg-messages');
    for (const item of items) {
        const line = el('div', 'wg-message');
        line.appendChild(el('span', `wg-tag wg-tag--${variant}`, variant === 'alert' ? 'ISSUE' : 'NOTE'));
        line.appendChild(el('span', 'wg-message__text', item));
        wrap.appendChild(line);
    }
    return wrap;
}
