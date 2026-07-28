// Shared stat-item factory: a labeled value display cell.
// Used by BP averages, weight stats, and any future stat grids.
// No dependencies.

/**
 * Create a label + value stat display element.
 *
 * @param {string} label
 * @param {string} value
 * @param {object} [opts]
 * @param {string} [opts.className='stat-item']      - Root element class.
 * @param {string} [opts.labelClass='stat-label']    - Label span class.
 * @param {string} [opts.valueClass='stat-value']    - Value span class.
 * @param {string} [opts.separator='']               - Text inserted between label and value.
 * @returns {HTMLDivElement}
 */
function createStatItem(label, value, {
    className = 'stat-item',
    labelClass = 'stat-label',
    valueClass = 'stat-value',
    separator = ''
} = {}) {
    const item = document.createElement('div');
    item.className = className;

    const labelEl = document.createElement('span');
    labelEl.className = labelClass;
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = valueClass;
    valueEl.textContent = value;

    item.appendChild(labelEl);
    if (separator) item.appendChild(document.createTextNode(separator));
    item.appendChild(valueEl);
    return item;
}
