// Wandergeek stroke-icon registry. Ported from ../medicationtrackerbot with
// the medication/fitness icons dropped (pill, apple, drop, dumbbell, scale,
// footprints, heart, moon, barcode, camera, phone) and `layers` + `list` added
// for the Holdings and Transactions nav slots.
//
// Single source for the 24px line icons used throughout the app.
// Each entry stores only the inner SVG markup (paths, rects, circles); the
// wrapper <svg> is built by iconSvg() with a shared attribute set — so every
// icon has consistent viewBox, stroke behavior, and aria semantics.
//
// API:
//   WGIcons.paths                        — read-only map of name → inner SVG string
//   WGIcons.iconSvg(name, { size?, stroke? }) — returns an <svg> SVGElement
//
// No inline styles or color literals: consumers style strokes via CSS
// (`currentColor` is the default), matching the no-hardcoded-hex rule.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const PATHS = {
        chevronLeft: '<path d="m15 18-6-6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
        trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
        pencil: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 6-6"/>',
        bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        back: '<path d="m15 18-6-6 6-6"/>',
        // Added for this app's nav slots: Holdings (stacked layers) and
        // Transactions (list). Same stroke style as the rest of the set.
        layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
        // Added beyond the handoff prototype: Settings (gear) for the
        // bottom-nav Settings slot — there is no "More" aggregator.
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    };

    // Parse the icon's inner markup into SVG-namespaced children. We go via a
    // wrapper <svg> so DOMParser treats descendants as SVG regardless of how
    // the host builds the icon (jsdom's innerHTML setter on SVGElement can
    // otherwise emit HTMLUnknownElement nodes for `<path>` etc.).
    function parseSvgChildren(inner) {
        const doc = new DOMParser().parseFromString(
            `<svg xmlns="${SVG_NS}">${inner}</svg>`,
            'image/svg+xml'
        );
        return Array.from(doc.documentElement.childNodes);
    }

    function iconSvg(name, opts) {
        const inner = PATHS[name];
        if (!inner) {
            throw new Error(`WGIcons.iconSvg: unknown icon "${name}"`);
        }
        const size = (opts && opts.size) || 20;
        const stroke = (opts && opts.stroke) || 1.8;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', String(stroke));
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('data-wg-icon', name);
        for (const child of parseSvgChildren(inner)) {
            svg.appendChild(child);
        }
        return svg;
    }

    window.WGIcons = {
        paths: PATHS,
        iconSvg,
    };
})();
