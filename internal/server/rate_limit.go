package server

import (
	"fmt"
	"net/http"
	"net/netip"
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

// defaultTrustedProxies is what X-Forwarded-For is believed from when nothing
// is configured: loopback only.
//
// Loopback is the one source that cannot be reached by a remote attacker at
// all, so trusting it is safe by construction, and it covers the common
// "reverse proxy on the same host" deployment with no configuration. Anything
// else — a proxy on a Docker network, a separate load balancer — has to be
// named explicitly, because "private address" is NOT the same as "is my proxy":
// with a published container port, every request on the planet arrives from the
// bridge gateway's private address, and trusting that would let any caller
// forge a fresh bucket per request.
var defaultTrustedProxies = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
}

// ParseTrustedProxies parses a comma-separated CIDR list (the
// MYPORTFOLIO_TRUSTED_PROXIES setting) naming the reverse proxies whose
// forwarded-for headers may be believed. An empty spec yields
// defaultTrustedProxies.
//
// This has to be configuration rather than a constant because the two ways of
// getting it wrong fail in opposite directions, and only the operator knows
// which topology they have:
//
//   - Trusting too much: any caller sets X-Forwarded-For to a fresh value per
//     request and the ceremony limiter stops existing.
//   - Trusting too little: behind a proxy, every user shares the proxy's single
//     bucket, so one client's retries throttle everybody.
func ParseTrustedProxies(spec string) ([]netip.Prefix, error) {
	if strings.TrimSpace(spec) == "" {
		return defaultTrustedProxies, nil
	}
	var out []netip.Prefix
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(part)
		if err != nil {
			// An address without a mask is the obvious way to write this, so
			// accept it as a single-host prefix rather than failing on it.
			addr, addrErr := netip.ParseAddr(part)
			if addrErr != nil {
				return nil, fmt.Errorf("trusted proxies: %q is not a CIDR block or IP address: %w", part, err)
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		out = append(out, prefix.Masked())
	}
	return out, nil
}

// clientIP returns the caller's IP for rate-limiting, believing forwarded-for
// headers only when the request actually arrived from a trusted proxy.
//
// The forwarded-for handling is load-bearing: behind a reverse proxy every
// request's RemoteAddr is the PROXY's address, so keying on it alone puts every
// user into one bucket and one client's retries throttle everyone — an outage
// dressed as a protection.
//
// But it is only safe when the immediate peer is a proxy that overwrites or
// appends the header itself. From an untrusted peer these headers are just
// caller-supplied strings, and honouring them turns the limiter into a no-op:
// rotate the value, get a fresh bucket, repeat. Hence the trust check first.
func clientIP(r *http.Request, trusted []netip.Prefix) string {
	peer := peerAddr(r.RemoteAddr)
	if !trustsPeer(trusted, peer) {
		return peer
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// The LAST hop is the address the trusted proxy itself observed and
		// appended; entries before it may have been forged by the client.
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	return peer
}

// peerAddr is the bare address of the immediate TCP peer.
func peerAddr(remoteAddr string) string {
	if ap, err := netip.ParseAddrPort(remoteAddr); err == nil {
		return ap.Addr().Unmap().String()
	}
	if addr, err := netip.ParseAddr(remoteAddr); err == nil {
		return addr.Unmap().String()
	}
	// Unparseable (a Unix socket, a test fake). Use it verbatim: an opaque but
	// consistent key still buckets correctly, which is all the limiter needs.
	return remoteAddr
}

func trustsPeer(trusted []netip.Prefix, peer string) bool {
	addr, err := netip.ParseAddr(peer)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, prefix := range trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// limitByIP wraps h so each client IP gets at most limiter.max hits per window.
// On reject it returns a bare 429 with no detail — identical for every caller
// regardless of whether the account or credential exists, so it adds no
// enumeration oracle to the deliberately-uniform ceremony error surface.
func limitByIP(limiter *rateLimiter, trusted []netip.Prefix, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow(clientIP(r, trusted)) {
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
