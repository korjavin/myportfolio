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
	"regexp"

	"github.com/korjavin/myportfolio/internal/store"
	"github.com/korjavin/myportfolio/web"
)

// contentSecurityPolicy hardens the E2EE origin. The threat model
// (ARCHITECTURE.md 8) rates on-origin XSS as catastrophic — it can read the
// in-memory DEK and drive the non-extractable LDK — and names a strict CSP with
// zero third-party script as the real defense.
//
// connect-src is 'self' plus the hosts the client actually fetches from,
// because §7 quotes and §5 FX rates both go browser-direct — with 'self' alone
// the browser blocks every one of those fetches and the feature is inert while
// its unit tests stay green, because there is no CSP in node. The hostnames are
// NOT written here: they are lifted from quotes.js's exported QUOTE_HOSTS and
// fx.js's exported FX_HOSTS (below), so there is one list per module of "who
// may we contact", not two that drift silently in a direction nobody notices
// until either an XSS uses the gap or a legitimate fetch is blocked and a user
// just sees a provider that never works.
//
// Never a bare `https:`/`wss:`/`*` token, on any document this origin serves: a
// same-origin child frame inherits the CSP, so one relaxed document is a bypass
// gadget for the whole origin (ARCHITECTURE.md 7).
//
// Stated honestly, since §8's posture is to name what we have NOT solved: each
// host here widens where an on-origin XSS can post a decrypted portfolio. The
// CSP narrows the exfiltration target set from "anywhere" to these three hosts
// — it does not close the hole. Three hosts is the entire budget; a fourth
// needs a reason, and adding one fails TestQuoteHostAllowlist until a human
// agrees. The third, data-api.ecb.europa.eu, was agreed on myportfolio-53h: it
// is keyless and CORS-enabled, without it every mixed-currency portfolio shows
// conversion gaps instead of a total, and it learns which currencies you hold —
// not which instruments, which is a smaller leak than the two quote hosts.
var contentSecurityPolicy = buildCSP(append(
	frozenHosts(web.StaticFS, "domain/quotes.js", "QUOTE_HOSTS"),
	frozenHosts(web.StaticFS, "domain/fx.js", "FX_HOSTS")...))

// hostLiteral lifts the values out of a frozen host map:
//
//	export const QUOTE_HOSTS = Object.freeze({
//	  coingecko: 'api.coingecko.com',
//	  ...
//	});
//
// A regex over the served asset, rather than a Go code generator or a
// hand-copied list: both modules are already embedded and already served from
// this binary (web/embed.go lists them explicitly), so reading them costs one
// ReadFile each and no build step, and there is no generated file to forget to
// regenerate. If a map is ever reformatted past what this matches, the
// derivation loses a host and TestQuoteHostAllowlist fails — a reformat cannot
// silently narrow or widen egress.
var hostLiteral = regexp.MustCompile(`'([a-z0-9][a-z0-9.\-]*\.[a-z]{2,})'`)

// frozenHosts reads one `export const <mapName> = Object.freeze({...})` out of
// one embedded module. It is parameterised rather than duplicated per module:
// the only thing that differed between the quotes and FX cases was the filename
// and the map name.
//
// It panics rather than degrading to 'self': the input is a file compiled into
// this binary, so a failure here means the binary was built wrong, and every
// test in this package runs the same code path. Falling back silently would
// reproduce exactly the bug this function exists to fix.
func frozenHosts(fsys fs.FS, path, mapName string) []string {
	src, err := fs.ReadFile(fsys, path)
	if err != nil {
		panic("server: read " + path + " for the CSP connect-src allowlist: " + err.Error())
	}
	block := regexp.MustCompile(mapName + `\s*=\s*Object\.freeze\(\{([^}]*)\}`).FindSubmatch(src)
	if block == nil {
		panic("server: no " + mapName + " = Object.freeze({...}) in " + path)
	}
	var hosts []string
	for _, m := range hostLiteral.FindAllSubmatch(block[1], -1) {
		hosts = append(hosts, string(m[1]))
	}
	if len(hosts) == 0 {
		panic("server: " + mapName + " in " + path + " has no hostnames")
	}
	return hosts
}

// buildCSP scheme-qualifies each host (`https://api.example.com`, not the bare
// hostname) so a plaintext-http document on this origin cannot be talked into
// fetching quotes or FX rates over http.
func buildCSP(connectHosts []string) string {
	connect := "'self'"
	for _, h := range connectHosts {
		connect += " https://" + h
	}
	return "default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self'; " +
		"img-src 'self'; " +
		"connect-src " + connect + "; " +
		"object-src 'none'; " +
		"base-uri 'none'; " +
		"frame-ancestors 'none'; " +
		"form-action 'none'"
}

// API holds the vault's stateful handler dependencies: the database, the
// session-cookie signing key, the in-flight WebAuthn challenges, and the
// ceremony rate limiter.
type API struct {
	db                 *store.DB
	sessionSecret      string
	registerChallenges *challengeStore
	loginChallenges    *challengeStore
	recoveryChallenges *challengeStore
	limiter            *rateLimiter
	// recoveryLimiter throttles recovery-code redemption per ACCOUNT. It is a
	// second instance of the same limiter, never a second implementation: the
	// per-IP one below keys on clientIP() and its trusted-proxy handling is
	// load-bearing (see rate_limit.go).
	recoveryLimiter *rateLimiter
	trustedProxies  []netip.Prefix
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
		recoveryChallenges: newChallengeStore(),
		limiter:            newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
		recoveryLimiter:    newRateLimiter(recoveryAttemptMax, recoveryAttemptWindow),
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

	// Recovery (Path C) is unauthenticated for the same reason: it is how
	// someone with no working passkey gets one. Redemption carries a SECOND,
	// per-account throttle inside the handler — the per-IP bucket here cannot
	// see one account being sprayed from many addresses.
	mux.HandleFunc("POST /api/recover", limitByIP(a.limiter, a.trustedProxies, a.redeemRecoveryCode))
	mux.HandleFunc("POST /api/recovery/enroll/begin", limitByIP(a.limiter, a.trustedProxies, a.recoveryEnrollBegin))
	mux.HandleFunc("POST /api/recovery/enroll/finish", limitByIP(a.limiter, a.trustedProxies, a.recoveryEnrollFinish))

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
