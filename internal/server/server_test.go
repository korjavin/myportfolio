package server

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/korjavin/myportfolio/internal/store"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":        &fstest.MapFile{Data: []byte("<!doctype html><title>myportfolio</title>")},
		"js/core/crypto.js": &fstest.MapFile{Data: []byte("export const SUITE_VERSION = 1;\n")},
	}
}

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	db, err := store.Open(context.Background(), t.TempDir()+"/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return New(testFS(), db, testSessionSecret, defaultTrustedProxies)
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestHealthz(t *testing.T) {
	rec := get(t, newTestServer(t), "/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /healthz = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok"`) {
		t.Errorf("body = %q, want a status:ok document", rec.Body.String())
	}
}

func TestReadyz(t *testing.T) {
	rec := get(t, newTestServer(t), "/readyz")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /readyz = %d, want 200; body %q", rec.Code, rec.Body.String())
	}
}

// A handle whose database is gone must not report ready — the whole reason
// readyz reads a table instead of pinging.
func TestReadyzUnreadableDatabase(t *testing.T) {
	// One call: each t.TempDir() invocation returns a *different* directory, so
	// the leak assertion below must compare against the path we actually used.
	dir := t.TempDir()
	db, err := store.Open(context.Background(), dir+"/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	db.Close()

	rec := get(t, New(testFS(), db, testSessionSecret, defaultTrustedProxies), "/readyz")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz on a closed database = %d, want 503", rec.Code)
	}
	if strings.Contains(rec.Body.String(), dir) {
		t.Error("readyz leaked a filesystem path to an unauthenticated caller")
	}
}

// readyDB is satisfied by *store.DB; a compile-time check beats discovering the
// mismatch when main.go is wired up.
var _ readyDB = (*store.DB)(nil)
var _ readyDB = (*sql.DB)(nil)

func TestServesStaticAssets(t *testing.T) {
	h := newTestServer(t)

	for _, tc := range []struct{ path, want string }{
		{"/", "myportfolio"},
		{"/js/core/crypto.js", "SUITE_VERSION"},
	} {
		rec := get(t, h, tc.path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", tc.path, rec.Code)
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("GET %s body = %q, want it to contain %q", tc.path, rec.Body.String(), tc.want)
		}
	}

	if rec := get(t, h, "/nope.js"); rec.Code != http.StatusNotFound {
		t.Errorf("GET /nope.js = %d, want 404", rec.Code)
	}
}

// The CSP is the origin's real defense against an XSS reading the in-memory DEK
// (ARCHITECTURE.md 8). A bare `https:`/`*` in connect-src or an 'unsafe-inline'
// script-src would silently undo it, so assert the shape rather than just
// presence.
func TestSecurityHeaders(t *testing.T) {
	h := newTestServer(t)

	for _, path := range cspRoutes {
		rec := get(t, h, path)
		csp := rec.Header().Get("Content-Security-Policy")
		if csp == "" {
			t.Errorf("GET %s: no Content-Security-Policy", path)
			continue
		}
		for _, want := range []string{
			"default-src 'self'", "script-src 'self'",
			"object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'",
		} {
			if !strings.Contains(csp, want) {
				t.Errorf("GET %s: CSP %q missing %q", path, csp, want)
			}
		}
		for _, banned := range []string{"unsafe-inline", "unsafe-eval"} {
			if strings.Contains(csp, banned) {
				t.Errorf("GET %s: CSP %q contains banned token %q", path, csp, banned)
			}
		}
		assertNoWildcardSource(t, path, csp)
		for header, want := range map[string]string{
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options":        "DENY",
			"Referrer-Policy":        "no-referrer",
		} {
			if got := rec.Header().Get(header); got != want {
				t.Errorf("GET %s: %s = %q, want %q", path, header, got, want)
			}
		}
	}
}

// cspRoutes is every distinct way a response leaves this handler: the shell, a
// static asset, a domain module, the JSON probes, an unauthenticated API route,
// and a 404 from the file server. The policy has to hold on ALL of them, not
// just the shell — a same-origin child frame inherits the CSP of the document
// it loads, so one relaxed document is a bypass gadget for the whole origin.
var cspRoutes = []string{"/", "/js/core/crypto.js", "/domain/quotes.js", "/healthz", "/readyz", "/api/state", "/nope.js"}

// assertNoWildcardSource rejects scheme-only and wildcard sources anywhere in
// the policy. A bare `https:` in connect-src is exactly the token that lets an
// XSS POST a decrypted portfolio to any origin it likes (ARCHITECTURE.md 7);
// `wss:`, `data:` and `*` are the same hole spelled differently. Host sources
// like `https://api.coingecko.com` are the point of A9 and are fine — hence a
// token check and not a substring check, which cannot tell the two apart.
func assertNoWildcardSource(t *testing.T, path, csp string) {
	t.Helper()
	for _, directive := range strings.Split(csp, ";") {
		for _, tok := range strings.Fields(directive) {
			switch {
			case strings.HasSuffix(tok, ":"):
				t.Errorf("GET %s: CSP %q has bare scheme token %q", path, csp, tok)
			case strings.Contains(tok, "*"):
				t.Errorf("GET %s: CSP %q has wildcard token %q", path, csp, tok)
			}
		}
	}
}

func cspDirective(csp, name string) string {
	for _, directive := range strings.Split(csp, ";") {
		if fields := strings.Fields(directive); len(fields) > 0 && fields[0] == name {
			return strings.Join(fields[1:], " ")
		}
	}
	return ""
}

// A9. connect-src is derived from quotes.js's exported QUOTE_HOSTS and fx.js's
// exported FX_HOSTS, so it cannot drift out of sync with what the client
// actually fetches — there is one list per module, not a second copy in Go. The
// flip side is that editing either map silently changes what this origin is
// allowed to talk to, so this pin is the human gate: every host here is one
// more place an on-origin XSS could post a decrypted portfolio, and widening
// the set has to be typed twice, on purpose. This test failing means either a
// host map changed (agree with it, then update the pin) or the derivation
// stopped matching a file (fix the derivation — the fetcher is inert without
// it, which is the bug A9 exists to fix, and myportfolio-53h is the second time
// it shipped).
//
// The ECB host was added on myportfolio-53h, deliberately: FX_HOSTS shipped in
// B8 with nothing deriving from it, so createFxDomain().refresh() could only
// ever report fetch_failed in a real browser. Three hosts is the budget now; a
// fourth still reds this test until someone types it.
func TestQuoteHostAllowlist(t *testing.T) {
	const want = "'self' https://api.coingecko.com https://api.twelvedata.com https://data-api.ecb.europa.eu"

	h := newTestServer(t)
	for _, path := range cspRoutes {
		csp := get(t, h, path).Header().Get("Content-Security-Policy")
		if got := cspDirective(csp, "connect-src"); got != want {
			t.Errorf("GET %s: connect-src = %q, want %q", path, got, want)
		}
	}
}

// Single origin (ARCHITECTURE.md 8.2): the Host header selects nothing. Any
// host reaches the same app, so no wildcard DNS/cert and no account resolution
// can ever hang off it.
func TestHostHeaderIsNotRouting(t *testing.T) {
	h := newTestServer(t)
	for _, host := range []string{"myportfolio.example", "someone-else.myportfolio.example", "127.0.0.1:8080"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET / with Host %q = %d, want 200", host, rec.Code)
		}
	}
}

func TestNonGetMethodsAreRejected(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /healthz = %d, want 405", rec.Code)
	}
}
