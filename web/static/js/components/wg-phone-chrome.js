// Wandergeek phone chrome: iPhone-style frame around the SPA on desktop.
// On mobile/PWA, a media query in styles.css collapses the chrome so the app
// fills the viewport. No inline styles — all sizing/colors live in CSS.
//
// API:
//   WGPhoneChrome.mount(rootEl)   — wraps rootEl in the chrome in place; rootEl
//                                   becomes the .wg-phone-screen content slot.
//   WGPhoneChrome.create()        — returns a detached chrome element with an
//                                   empty .wg-phone-screen ready for content.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const STATUS_ICONS = [
        {
            width: 17,
            height: 11,
            viewBox: '0 0 17 11',
            fill: 'currentColor',
            rects: [
                { x: 0, y: 7, width: 3, height: 4, rx: 0.6 },
                { x: 4.5, y: 5, width: 3, height: 6, rx: 0.6 },
                { x: 9, y: 2.5, width: 3, height: 8.5, rx: 0.6 },
                { x: 13.5, y: 0, width: 3, height: 11, rx: 0.6 },
            ],
        },
        {
            width: 16,
            height: 11,
            viewBox: '0 0 16 11',
            fill: 'currentColor',
            paths: [
                'M8 2C10 2 11.8 2.8 13.2 4L14.1 3.1C12.5 1.5 10.3 0.5 8 0.5C5.7 0.5 3.5 1.5 1.9 3.1L2.8 4C4.2 2.8 6 2 8 2Z',
                'M8 5.5C9.2 5.5 10.3 6 11.1 6.8L12 5.9C10.9 4.8 9.5 4.1 8 4.1C6.5 4.1 5.1 4.8 4 5.9L4.9 6.8C5.7 6 6.8 5.5 8 5.5Z',
            ],
            circle: { cx: 8, cy: 9, r: 1.4 },
        },
        {
            width: 26,
            height: 12,
            viewBox: '0 0 26 12',
            fill: 'none',
            // Battery: outline rect (stroke), inner fill rect, nub path.
            customRects: [
                { x: 0.5, y: 0.5, width: 22, height: 11, rx: 3, stroke: 'currentColor', 'stroke-opacity': '0.5' },
                { x: 2, y: 2, width: 19, height: 8, rx: 1.5, fill: 'currentColor' },
            ],
            customPath: {
                d: 'M24 3.5v5c0.7-0.3 1.3-1.1 1.3-1.75V5.25c0-0.65-0.6-1.45-1.3-1.75z',
                fill: 'currentColor',
                'fill-opacity': '0.5',
            },
        },
    ];

    function svgEl(tag, attrs) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
            el.setAttribute(k, String(v));
        }
        return el;
    }

    function buildSignalIcon(spec) {
        const svg = svgEl('svg', {
            width: spec.width,
            height: spec.height,
            viewBox: spec.viewBox,
            fill: spec.fill,
            'aria-hidden': 'true',
        });
        for (const r of spec.rects) {
            svg.appendChild(svgEl('rect', r));
        }
        return svg;
    }

    function buildWifiIcon(spec) {
        const svg = svgEl('svg', {
            width: spec.width,
            height: spec.height,
            viewBox: spec.viewBox,
            fill: spec.fill,
            'aria-hidden': 'true',
        });
        for (const d of spec.paths) {
            svg.appendChild(svgEl('path', { d }));
        }
        svg.appendChild(svgEl('circle', spec.circle));
        return svg;
    }

    function buildBatteryIcon(spec) {
        const svg = svgEl('svg', {
            width: spec.width,
            height: spec.height,
            viewBox: spec.viewBox,
            fill: spec.fill,
            'aria-hidden': 'true',
        });
        for (const r of spec.customRects) {
            svg.appendChild(svgEl('rect', r));
        }
        svg.appendChild(svgEl('path', spec.customPath));
        return svg;
    }

    function buildStatusBar() {
        const bar = document.createElement('div');
        bar.className = 'wg-status-bar';

        const time = document.createElement('span');
        time.className = 'wg-status-bar__time';
        time.textContent = '9:41';
        bar.appendChild(time);

        const icons = document.createElement('div');
        icons.className = 'wg-status-bar__icons';
        icons.appendChild(buildSignalIcon(STATUS_ICONS[0]));
        icons.appendChild(buildWifiIcon(STATUS_ICONS[1]));
        icons.appendChild(buildBatteryIcon(STATUS_ICONS[2]));
        bar.appendChild(icons);

        return bar;
    }

    function buildDynamicIsland() {
        const island = document.createElement('div');
        island.className = 'wg-dynamic-island';
        island.setAttribute('aria-hidden', 'true');
        return island;
    }

    function buildHomeIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'wg-home-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        return indicator;
    }

    /**
     * Build a detached chrome wrapper with an empty content slot.
     * @returns {{ root: HTMLElement, screen: HTMLElement, slot: HTMLElement }}
     */
    function createPhoneChrome() {
        const root = document.createElement('div');
        root.className = 'wg-phone';

        const screen = document.createElement('div');
        screen.className = 'wg-phone-screen';

        screen.appendChild(buildDynamicIsland());
        screen.appendChild(buildStatusBar());

        const slot = document.createElement('div');
        slot.className = 'wg-phone-screen__content';
        screen.appendChild(slot);

        screen.appendChild(buildHomeIndicator());
        root.appendChild(screen);

        return { root, screen, slot };
    }

    /**
     * Wrap an existing content element in the chrome, in place.
     * After mounting, `rootEl` lives inside `.wg-phone-screen__content`,
     * and the chrome occupies `rootEl`'s previous position in the DOM.
     *
     * @param {HTMLElement} rootEl
     * @returns {HTMLElement} the chrome element (.wg-phone)
     */
    function mountPhoneChrome(rootEl) {
        if (!rootEl || !(rootEl instanceof Element)) {
            throw new TypeError('mountPhoneChrome: rootEl must be an Element');
        }
        const { root, slot } = createPhoneChrome();
        const parent = rootEl.parentNode;
        if (parent) {
            parent.insertBefore(root, rootEl);
        }
        slot.appendChild(rootEl);
        return root;
    }

    window.WGPhoneChrome = {
        mount: mountPhoneChrome,
        create: createPhoneChrome,
    };
})();
