// Wandergeek stale-data badge — small chip surfaced in screen headers to
// communicate read freshness. Ported from ../medicationtrackerbot.
//
// PORT NOTE: the sibling's `mountFromKey(...)` is NOT here. It read the
// `api_cache` Dexie table through `window.MedTrackerDB.ApiCache`, which is
// that app's cache layer and does not exist in this one. `render` and
// `formatLabel` below are pure and domain-neutral; whichever bead lands the
// quote/price cache should add its own thin mount helper that resolves a
// fetchedAt timestamp and calls `render`.
//
// Tone selection is deterministic from {fetchedAt, isOffline, staleAfterMs}:
//   • online + recent  → neutral tone (`Updated 5m ago`)
//   • online + old     → warning tone (`Updated 2h ago`)
//   • offline + fresh  → warning tone, prefixed (`Offline · 12m old`)
//   • offline + stale  → warning tone, prefixed (`Offline · 3h old`)
//   • no fetchedAt     → neutral fallback (`Never updated` / `Offline · no cache`)
//
// API:
//   WGStaleBadge.render({ fetchedAt, isOffline, staleAfterMs, now }) → HTMLElement
//   WGStaleBadge.formatLabel({ fetchedAt, isOffline, now })          → string
//
//   fetchedAt    — ms epoch timestamp the cache was populated. Optional.
//   isOffline    — bool (true also for 5xx-as-offline). Optional.
//   staleAfterMs — age threshold (ms) past which the warning tone kicks in.
//                  Defaults to 1h.
//   now          — injectable clock for testing (defaults to Date.now()).
//
// Visual values come exclusively from `.wg-stale-badge` + tone modifier
// classes in styles.css; this module never sets a colour or background.

(function () {
    const HOUR_MS = 60 * 60 * 1000;
    const MINUTE_MS = 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const DEFAULT_STALE_AFTER_MS = HOUR_MS;

    function asNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function formatAge(ageMs) {
        if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';
        if (ageMs < MINUTE_MS) return 'just now';
        if (ageMs < HOUR_MS) {
            const m = Math.floor(ageMs / MINUTE_MS);
            return `${m}m`;
        }
        if (ageMs < DAY_MS) {
            const h = Math.floor(ageMs / HOUR_MS);
            return `${h}h`;
        }
        const d = Math.floor(ageMs / DAY_MS);
        return `${d}d`;
    }

    function formatLabel({ fetchedAt, isOffline, now } = {}) {
        const ts = asNumber(fetchedAt);
        const clock = asNumber(now) ?? Date.now();
        const offline = !!isOffline;

        if (ts === null) {
            return offline ? 'Offline · no cache' : 'Never updated';
        }

        const ageMs = Math.max(0, clock - ts);
        const ageLabel = formatAge(ageMs);

        if (offline) {
            if (ageLabel === 'just now') return 'Offline · just now';
            return `Offline · ${ageLabel} old`;
        }

        if (ageLabel === 'just now') return 'Updated just now';
        return `Updated ${ageLabel} ago`;
    }

    function renderStaleBadge(opts) {
        const options = opts || {};
        const ts = asNumber(options.fetchedAt);
        const offline = !!options.isOffline;
        const staleAfterMs = asNumber(options.staleAfterMs) ?? DEFAULT_STALE_AFTER_MS;
        const clock = asNumber(options.now) ?? Date.now();

        const span = document.createElement('span');
        span.classList.add('wg-stale-badge');

        const ageMs = ts === null ? Infinity : Math.max(0, clock - ts);
        const isStaleByAge = ageMs > staleAfterMs;
        const isWarning = offline || (ts !== null && isStaleByAge);

        span.classList.add(isWarning ? 'wg-stale-badge--warning' : 'wg-stale-badge--neutral');
        if (offline) {
            span.classList.add('wg-stale-badge--offline');
        }

        span.textContent = formatLabel({ fetchedAt: ts, isOffline: offline, now: clock });
        span.setAttribute('role', 'status');
        span.setAttribute('aria-live', 'polite');

        return span;
    }

    window.WGStaleBadge = {
        render: renderStaleBadge,
        formatLabel,
    };
})();
