// Shared empty-state and error-state element factories.
// No dependencies.

/**
 * Create a centered message element for empty or error states in lists.
 *
 * @param {string} message  - Text to display.
 * @param {object} [opts]
 * @param {string} [opts.tag='li']   - Element tag ('li', 'p', 'div', etc.)
 * @param {string} [opts.className]  - Extra CSS class (appended if provided).
 * @returns {HTMLElement}
 */
function createEmptyState(message, { tag = 'li', className } = {}) {
    const el = document.createElement(tag);
    el.className = className ? `empty-state-msg ${className}` : 'empty-state-msg';

    el.textContent = message;
    return el;
}
