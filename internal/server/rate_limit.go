package server

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ceremonyRateLimitMax / ceremonyRateLimitWindow bound the unauthenticated
// WebAuthn ceremonies per client IP. These are human-paced flows — signing up,
// or unlocking after clearing site data, makes a handful of requests — so the
// ceiling is deliberately generous: it slows credential-stuffing without ever
// tripping a legitimate person.
const (
	ceremonyRateLimitMax    = 30
	ceremonyRateLimitWindow = time.Minute
)

// clientIP returns the caller's IP for rate-limiting.
//
// This handling is load-bearing, not defensive boilerplate. Deployed behind a
// reverse proxy (Traefik, Caddy, nginx), RemoteAddr is the PROXY's address, so
// keying on it alone puts every user on the planet into one bucket — a single
// client's retries would then rate-limit everyone's login at once. That is an
// outage dressed as a protection, and the sibling project shipped it once.
//
// The last X-Forwarded-For hop is the address the proxy itself observed and
// appended, so a client-supplied X-Forwarded-For header cannot spoof it; only
// then X-Real-IP, then RemoteAddr for a direct connection.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

// limitByIP wraps h so each client IP gets at most limiter.max hits per window.
// On reject it returns a bare 429 with no detail — identical for every caller
// regardless of whether the account or credential exists, so it adds no
// enumeration oracle to the deliberately-uniform ceremony error surface.
func limitByIP(limiter *rateLimiter, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow(clientIP(r)) {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

// rateLimiter is a small sliding-window per-key rate limiter.
//
// ponytail: in-memory and single-process, plus one cleanup goroutine per
// limiter (one per server). Fine for a self-hosted single binary; a
// horizontally-scaled deployment would need the counter in SQLite or Redis, and
// the goroutine would need a lifecycle.
type rateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	hits   map[string][]time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		window: window,
		max:    max,
		hits:   make(map[string][]time.Time),
	}
	rl.startCleanup()
	return rl
}

// startCleanup evicts idle keys so the map does not grow without bound: Allow
// prunes only the key it touches, so an IP that fires once and never returns
// would otherwise be remembered forever.
func (r *rateLimiter) startCleanup() {
	ticker := time.NewTicker(r.window)
	go func() {
		for range ticker.C {
			r.cleanup()
		}
	}()
}

func (r *rateLimiter) cleanup() {
	cutoff := time.Now().Add(-r.window)
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, hits := range r.hits {
		if len(hits) == 0 || hits[len(hits)-1].Before(cutoff) {
			delete(r.hits, key)
		}
	}
}

// Allow reports whether the caller identified by key has fewer than max hits in
// the trailing window, recording the hit when it does.
func (r *rateLimiter) Allow(key string) bool {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	hits := r.hits[key]
	cutoff := now.Add(-r.window)
	pruned := hits[:0]
	for _, t := range hits {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	if len(pruned) >= r.max {
		r.hits[key] = pruned
		return false
	}
	r.hits[key] = append(pruned, now)
	return true
}
