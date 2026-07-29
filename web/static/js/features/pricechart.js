// A security's close history, as a card.
//
// The line itself is the ported `wg-sparkline` primitive — not a second
// hand-rolled SVG renderer and not a chart library. Everything this module adds
// is around it: the delta headline, the date axis, the empty state, and the
// downsampling.
//
// DOWNSAMPLING LIVES HERE, not in the domain reader. `store.priceSeries`
// returns the truth at full daily resolution; five years of daily closes is
// ~1250 path nodes on a 360px screen, which is a node every quarter-pixel. The
// reader must stay usable for things that are not drawing.
//
// No float ever leaves this file as a number: closes are 1e8 integers, rendered
// through fmt (which is formatFixed all the way down, never toFloat). The
// sparkline does divide them — but only into pixel coordinates, which are
// geometry, not money.

import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { priceSeries } from './store.js';

// One point per ~2.5 CSS pixels at the card's widest. Past that the line is
// drawing detail no phone can resolve.
const MAX_POINTS = 120;

// ponytail: nearest-index picking, so an extreme between two kept samples is
// dropped from the line (the Low/High labels below still report it, off the
// full series). Upgrade to min/max bucketing if someone misses a spike.
function downsample(points, max) {
    if (points.length <= max) return points;
    const step = (points.length - 1) / (max - 1);
    const out = [];
    // First and last are always kept, so the line still starts and ends on the
    // dates the axis labels claim.
    for (let i = 0; i < max; i += 1) out.push(points[Math.round(i * step)]);
    return out;
}

function sparkline(series, variant) {
    if (!window.WGSparkline) throw new Error('pricechart: wg-sparkline.js must load before the screens');
    return window.WGSparkline.render({
        points: downsample(series, MAX_POINTS).map((p) => p.close),
        variant,
        width: 320,
        height: 96,
    });
}

function chartBody(series) {
    if (series.length === 0) {
        return [ui.emptyState(
            'No stored closes for this security yet. "Set price" records one, and '
            + 'a Portfolio Performance import brings the whole history with it.'
        )];
    }

    const first = series[0];
    const last = series[series.length - 1];
    const change = last.close - first.close;
    const closes = series.map((p) => p.close);
    const low = Math.min(...closes);
    const high = Math.max(...closes);

    // The headline change is a gain/loss, so it goes through ui.delta — whose
    // ▲/▼/— glyph comes from CSS. The line colour below agrees with it, but the
    // colour is never the only carrier of the sign (ARCHITECTURE.md §9).
    const head = ui.el('div', 'flex-row flex-between gap-md');
    head.appendChild(ui.el('span', 'wg-muted text-sm', `${series.length} close${series.length === 1 ? '' : 's'}`));
    head.appendChild(ui.delta(
        fmt.deltaClass(series.length > 1 ? change : null),
        series.length > 1 ? `${fmt.price(last.close)} · ${fmt.sharePercent(change, first.close)}` : fmt.price(last.close),
        { bare: true }
    ));

    const variant = series.length < 2 || change === 0 ? 'mint' : (change > 0 ? 'gain' : 'loss');

    // The date axis. Plain text rather than SVG <text>, because these two labels
    // are the whole axis at this size — but .wg-price-chart__axis resolves them
    // from the shared chart axis-tick theme, so they cannot drift away from the
    // tick styling every other chart uses. (The token names themselves stay in
    // the stylesheet: naming one here, even in a comment, is a guard failure.)
    const axis = ui.el('div', 'wg-price-chart__axis');
    axis.appendChild(ui.el('span', null, first.date));
    if (series.length > 1) axis.appendChild(ui.el('span', null, last.date));

    const plot = ui.el('div', 'wg-price-chart__plot');
    plot.appendChild(sparkline(series, variant));

    return [
        head,
        plot,
        axis,
        ui.el('p', 'wg-muted text-sm m-0', series.length > 1
            ? `Low ${fmt.price(low)} · High ${fmt.price(high)}`
            : `The only stored close for this security. A second one draws a line.`),
    ];
}

/**
 * The card, returned synchronously and filled in when the series resolves —
 * the modal that hosts it is built in one pass and must not wait on a read.
 */
export function priceHistoryCard(securityId) {
    const card = ui.el('div', 'wg-chart-card wg-price-chart');
    card.appendChild(ui.el('p', 'wg-muted text-sm m-0', 'Reading price history…'));

    priceSeries(securityId).then(
        (series) => card.replaceChildren(...chartBody(series)),
        (err) => card.replaceChildren(ui.messages([`Could not read price history: ${err.message}`]))
    );

    return card;
}
