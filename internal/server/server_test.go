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

	for _, path := range []string{"/", "/js/core/crypto.js", "/healthz", "/nope.js"} {
		rec := get(t, h, path)
		csp := rec.Header().Get("Content-Security-Policy")
		if csp == "" {
			t.Errorf("GET %s: no Content-Security-Policy", path)
			continue
		}
		for _, want := range []string{
			"default-src 'self'", "script-src 'self'", "connect-src 'self'",
			"object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'",
		} {
			if !strings.Contains(csp, want) {
				t.Errorf("GET %s: CSP %q missing %q", path, csp, want)
			}
		}
		for _, banned := range []string{"unsafe-inline", "unsafe-eval", "https:", "*"} {
			if strings.Contains(csp, banned) {
				t.Errorf("GET %s: CSP %q contains banned token %q", path, csp, banned)
			}
		}
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
