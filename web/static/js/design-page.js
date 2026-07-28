// Bootstrap for the standalone design-system reference page (design.html).
// NOT part of the app shell — index.html is wired by a separate bead.
//
// Exists as a file rather than an inline <script> because the served CSP is
// `script-src 'self'` with no 'unsafe-inline'; an inline block would be
// silently dropped, which is the same trap architecture.no-inline-handlers
// guards against for on*= attributes.

(function () {
    function mountNav() {
        const slot = document.getElementById('nav-mount');
        if (!slot || !window.WGBottomNav) return;
        window.WGBottomNav.mount(slot, {
            active: 'dashboard',
            onChange(id) {
                // The reference page has no router; reflect the choice in the
                // hash so the active-pill behaviour is observable.
                window.location.hash = id;
            },
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountNav);
    } else {
        mountNav();
    }
})();
