// Wandergeek sparkline — deterministic SVG renderer for tiny trend lines.
//
// Ported from the handoff prototype (components.jsx:151-167) with one
// explicit constraint: the path stroke colour is set in CSS, not via a
// JS string. The renderer tags the <path> (and the fill + tail circle)
// with `wg-spark--<variant>` classes, and styles.css maps each variant
// to a --wg-* token.
//
// API:
//   WGSparkline.render({ points, variant, width, height }) → SVGElement | null
//
//   points    — Array<number>; returns null for empty/invalid input.
//   variant   — 'sun' | 'mint' | 'coral' | 'mint-soft' (optional).
//   width     — defaults to 150.
//   height    — defaults to 22.
//
// The returned <svg> has no inline style attributes — consumers style it
// purely through the variant class on the element itself.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEFAULT_WIDTH = 150;
    const DEFAULT_HEIGHT = 22;

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function renderSparkline(opts) {
        const options = opts || {};
        const points = Array.isArray(options.points) ? options.points.filter(Number.isFinite) : [];
        if (points.length === 0) return null;

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const variant = typeof options.variant === 'string' && options.variant.length > 0
            ? options.variant
            : null;

        const min = Math.min(...points);
        const max = Math.max(...points);
        const range = (max - min) || 1;
        // Two-point data still renders cleanly; single-point collapses to a dot.
        //
        // A degenerate series (one point, or every value identical) has no range
        // to scale against. Centering it is the only honest answer: the original
        // `(v - min) / range` puts it flat on the bottom edge, which reads as a
        // chart that failed to draw rather than as one close. Divide-by-zero is
        // already excluded by `|| 1` above; this is about where the dot lands.
        const flat = max === min;
        const single = points.length === 1;
        const lastX = points.length > 1 ? points.length - 1 : 1;
        const xOf = (i) => (single ? width / 2 : (i / lastX) * width);
        const yOf = (v) => (flat ? height / 2 : height - 2 - ((v - min) / range) * (height - 4));

        const lineD = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' ');
        const fillD = points.length > 1
            ? `${lineD} L${width.toFixed(1)} ${height.toFixed(1)} L0 ${height.toFixed(1)} Z`
            : null;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-sparkline');
        if (variant) svg.classList.add(`wg-sparkline--${variant}`);

        if (fillD) {
            const fill = document.createElementNS(SVG_NS, 'path');
            fill.setAttribute('d', fillD);
            fill.classList.add('wg-spark-fill');
            if (variant) fill.classList.add(`wg-spark-fill--${variant}`);
            svg.appendChild(fill);
        }

        const line = document.createElementNS(SVG_NS, 'path');
        line.setAttribute('d', lineD);
        line.classList.add('wg-spark');
        if (variant) line.classList.add(`wg-spark--${variant}`);
        svg.appendChild(line);

        const tail = document.createElementNS(SVG_NS, 'circle');
        tail.setAttribute('cx', xOf(points.length - 1).toFixed(1));
        tail.setAttribute('cy', yOf(points[points.length - 1]).toFixed(1));
        tail.setAttribute('r', '2.3');
        tail.classList.add('wg-spark-tail');
        if (variant) tail.classList.add(`wg-spark-tail--${variant}`);
        svg.appendChild(tail);

        return svg;
    }

    window.WGSparkline = {
        render: renderSparkline,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
