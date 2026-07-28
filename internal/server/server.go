// Package server holds myportfolio's HTTP handlers: the PWA shell plus, in
// later beads, the WebAuthn ceremonies, the encrypted state blob, and the
// opt-in quote proxy.
//
// Single origin (ARCHITECTURE.md 8.2). Unlike medtracker's internal/cloudserver
// there is no Host-based routing layer here: no wildcard DNS, no wildcard
// certificate, no per-account subdomain, and no invite/claim-token
// provisioning. An account is resolved from the session or the asserted
// credential, never from the Host header — which is also why cold unlock costs
// one discoverable-credential assertion that returns {account_id, envelope}
// instead of the client knowing its account up front.
package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/netip"

	"github.com/korjavin/myportfolio/internal/store"
)

// contentSecurityPolicy hardens the E2EE origin. The threat model
// (ARCHITECTURE.md 8) rates on-origin XSS as catastrophic — it can read the
// in-memory DEK and drive the non-extractable LDK — and names a strict CSP with
// zero third-party script as the real defense.
//
// connect-src is 'self' for now. A9 replaces it with an allowlist derived from
// the account's configured quote-provider hostnames. It must never become a
// bare `https:`: that single token is exactly what lets an XSS POST a decrypted
// portfolio to any origin it likes (ARCHITECTURE.md 7).
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self'; " +
	"img-src 'self'; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"frame-ancestors 'none'; " +
	"form-action 'none'"

// API holds the vault's stateful handler dependencies: the database, the
// session-cookie signing key, the in-flight WebAuthn challenges, and the
// ceremony rate limiter.
type API struct {
	db                 *store.DB
	sessionSecret      string
	registerChallenges *challengeStore
	loginChallenges    *challengeStore
	limiter            *rateLimiter
	trustedProxies     []netip.Prefix
}

// New builds the single-origin handler.
//
//   - staticFS is the web/static tree (the PWA shell).
//   - db backs the readiness probe and the vault.
//   - sessionSecret signs session cookies; it comes from
//     store.DB.SessionSecret, so it survives a restart.
//   - trustedProxies names the reverse proxies whose forwarded-for headers the
//     ceremony rate limiter may believe (see ParseTrustedProxies). Pass nil to
//     trust none, which keys every caller on its real TCP peer.
func New(staticFS fs.FS, db *store.DB, sessionSecret string, trustedProxies []netip.Prefix) http.Handler {
	api := &API{
		db:                 db,
		sessionSecret:      sessionSecret,
		registerChallenges: newChallengeStore(),
		loginChallenges:    newChallengeStore(),
		limiter:            newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
		trustedProxies:     trustedProxies,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /readyz", readyz(db))
	api.registerRoutes(mux)
	// Go 1.22 pattern: "GET /" matches every path no more specific route
	// claimed, and leaves r.URL.Path untouched, so the file server sees the
	// request path as-is. A non-GET to /healthz falls through to here and gets
	// 405 rather than a stray asset lookup.
	mux.Handle("GET /", http.FileServerFS(staticFS))
	return securityHeaders(mux)
}

func (a *API) registerRoutes(mux *http.ServeMux) {
	// Ceremony routes are unauthenticated by definition — they are how a caller
	// becomes authenticated — so they are the ones that need per-IP throttling.
	mux.HandleFunc("POST /api/webauthn/register/begin", limitByIP(a.limiter, a.trustedProxies, a.registerBegin))
	mux.HandleFunc("POST /api/webauthn/register/finish", limitByIP(a.limiter, a.trustedProxies, a.registerFinish))
	mux.HandleFunc("POST /api/webauthn/login/begin", limitByIP(a.limiter, a.trustedProxies, a.loginBegin))
	mux.HandleFunc("POST /api/webauthn/login/finish", limitByIP(a.limiter, a.trustedProxies, a.loginFinish))

	// Everything else is behind a session, which also re-checks that the
	// session's credential has not been revoked.
	mux.Handle("PUT /api/recovery-material", a.requireSession(http.HandlerFunc(a.putRecoveryMaterial)))
	mux.Handle("GET /api/state", a.requireSession(http.HandlerFunc(a.getState)))
	mux.Handle("PUT /api/state", a.requireSession(http.HandlerFunc(a.putState)))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		// ponytail: revalidate everything. Correct but slow — no asset carries a
		// fingerprint yet, so nothing else would ever bust a cached copy of a
		// poisoned or stale bundle. Flip to immutable long-lived caching only
		// once every path is versioned (ARCHITECTURE.md 8, "versioned immutable
		// assets, service-worker-pinned bundles").
		h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
