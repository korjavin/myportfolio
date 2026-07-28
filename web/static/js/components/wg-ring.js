// Wandergeek ring — deterministic SVG renderer for the gamification
// "closing ring" gauge (Plan 5: clarity). Apple-style circular progress: an
// arc fills clockwise from 12 o'clock as `progress` climbs from 0 to 1.
// Replaces the old relative-fill bar (hp ÷ today's highest-scoring ring),
// which could read "closed" yet still show a short bar — the fix this
// component exists for is that `closed` always means a visually full ring.
//
// The circle radius is fixed at r=15.9155 — the standard trick that makes
// the circumference ≈ 100 user units, so the dash math reads like a
// percentage (stroke-dasharray="100", and CSS computes
// stroke-dashoffset: calc(100 - var(--ring-progress))).
//
// API:
//   WGRing.render({ progress, closed, label, value, size }) → SVGElement
//
//   progress — 0..1; non-finite or out-of-range clamps to [0,1]. Ignored
//              (forced to 1) when `closed` is true — closed always means
//              a full ring, never a short one.
//   closed   — boolean; true draws a full ring, switches the arc to the
//              .wg-ring--closed tint, and adds a check mark.
//   label    — accessible name for the ring (e.g. "Adherence").
//   value    — optional value folded into the accessible name (e.g. "73%"
//              or "Closed"); not drawn as visible text inside the ring —
//              callers already render the HP/goal text next to it.
//   size     — SVG pixel width/height; defaults to 36.
//
// No inline colors and no hardcoded visual values: stroke colors resolve
// via --wg-* tokens through the .wg-ring__track / .wg-ring__progress /
// .wg-ring--closed CSS classes. The only inline value is the neutral
// --ring-progress custom property (0..100), set via style.setProperty —
// same convention as --fill-pct elsewhere in the gamification surfaces.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const RADIUS = 15.9155; // makes the circumference ≈ 100 user units
    const CIRCUMFERENCE = 100;
    const DEFAULT_SIZE = 36;
    const CENTER = 18; // viewBox is fixed at 36x36 regardless of rendered size

    function clamp01(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return 0;
        if (v < 0) return 0;
        if (v > 1) return 1;
        return v;
    }

    function svgEl(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const key in attrs) {
            node.setAttribute(key, String(attrs[key]));
        }
        return node;
    }

    function renderRing(opts) {
        const options = opts || {};
        const isClosed = !!options.closed;
        const progress = isClosed ? 1 : clamp01(options.progress);
        const label = typeof options.label === 'string' ? options.label : '';
        const value = options.value;
        const sizeNum = Number(options.size);
        const size = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : DEFAULT_SIZE;

        const svg = svgEl('svg', {
            class: 'wg-ring' + (isClosed ? ' wg-ring--closed' : ''),
            width: size,
            height: size,
            viewBox: '0 0 36 36',
            role: 'img',
        });
        const hasValue = value !== undefined && value !== null && value !== '';
        svg.setAttribute('aria-label', hasValue ? `${label}: ${value}` : label);

        svg.appendChild(svgEl('circle', {
            class: 'wg-ring__track',
            cx: CENTER, cy: CENTER, r: RADIUS,
        }));

        const arc = svgEl('circle', {
            class: 'wg-ring__progress',
            cx: CENTER, cy: CENTER, r: RADIUS,
            'stroke-dasharray': CIRCUMFERENCE,
            transform: `rotate(-90 ${CENTER} ${CENTER})`,
        });
        arc.style.setProperty('--ring-progress', String(progress * CIRCUMFERENCE));
        svg.appendChild(arc);

        if (isClosed) {
            svg.appendChild(svgEl('path', {
                class: 'wg-ring__check',
                d: 'M11 18.5l4.2 4.2L25 13',
            }));
        }

        return svg;
    }

    window.WGRing = {
        render: renderRing,
        RADIUS,
        CIRCUMFERENCE,
        DEFAULT_SIZE,
    };
})();
