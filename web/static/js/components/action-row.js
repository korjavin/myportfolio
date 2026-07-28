// Shared action element factories: delete button and sync-pending badge.
// No dependencies.

/**
 * Create a standard delete button (🗑️) for list items.
 *
 * @param {function} onDelete - Called when the button is clicked.
 * @returns {HTMLButtonElement}
 */
function createDeleteButton(onDelete) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-action-btn delete';
    btn.title = 'Delete';
    btn.textContent = '🗑️';
    btn.addEventListener('click', onDelete);
    return btn;
}

/**
 * Create a standard edit button (✏️) for list items.
 *
 * @param {function} onClick - Called when the button is clicked.
 * @returns {HTMLButtonElement}
 */
function createEditButton(onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-action-btn';
    btn.title = 'Edit';
    btn.textContent = '✏️';
    btn.addEventListener('click', onClick);
    return btn;
}

/**
 * Create a modal-styled delete button (🗑️) for use inside modals.
 *
 * @param {function} onClick - Called when the button is clicked.
 * @returns {HTMLButtonElement}
 */
function createModalDeleteButton(onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-action-btn delete';
    btn.title = 'Delete';
    btn.textContent = '🗑️';
    btn.addEventListener('click', onClick);
    return btn;
}

/**
 * Create a modal-styled edit button (✏️) for use inside modals.
 *
 * @param {function} onClick - Called when the button is clicked.
 * @returns {HTMLButtonElement}
 */
function createModalEditButton(onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-action-btn';
    btn.title = 'Edit';
    btn.textContent = '✏️';
    btn.addEventListener('click', onClick);
    return btn;
}

/**
 * Create a "Pending" sync badge shown on locally-queued items.
 *
 * @returns {HTMLSpanElement}
 */
function createSyncBadge() {
    const badge = document.createElement('span');
    badge.className = 'sync-pending-badge';
    badge.textContent = 'Pending';
    return badge;
}

/**
 * Create a "Failed" sync badge shown on permanently rejected items.
 *
 * @param {string} [errorMessage] - Optional error details shown as tooltip
 * @returns {HTMLSpanElement}
 */
function createSyncRejectedBadge(errorMessage) {
    const badge = document.createElement('span');
    badge.className = 'sync-rejected-badge';
    badge.textContent = 'Failed';
    if (errorMessage) {
        badge.title = errorMessage;
    }
    return badge;
}
