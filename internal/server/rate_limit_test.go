package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// The reason this file exists, in both directions. Behind a reverse proxy every
// request's RemoteAddr is the proxy's, so keying the limiter on it puts the
// whole internet in one bucket. But a forwarded-for header from an UNTRUSTED
// peer is just a string the caller picked, so honouring it there hands out a
// fresh bucket per request and the limiter stops existing.
func TestClientIP_TrustsForwardedHeadersOnlyFromTrustedProxies(t *testing.T) {
	proxied := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}

	for name, tc := range map[string]struct {
		trusted    []netip.Prefix
		remoteAddr string
		headers    map[string]string
		want       string
	}{
		"direct connection, no headers": {
			trusted:    proxied,
			remoteAddr: "203.0.113.7:51234",
			want:       "203.0.113.7",
		},
		// The bypass. An untrusted caller's forged header must be ignored
		// entirely, so it keeps being keyed on the address it really came from.
		"untrusted peer forging X-Forwarded-For": {
			trusted:    proxied,
			remoteAddr: "203.0.113.7:51234",
			headers:    map[string]string{"X-Forwarded-For": "198.51.100.99"},
			want:       "203.0.113.7",
		},
		"untrusted peer forging X-Real-IP": {
			trusted:    proxied,
			remoteAddr: "203.0.113.7:51234",
			headers:    map[string]string{"X-Real-IP": "198.51.100.99"},
			want:       "203.0.113.7",
		},
		"trusted proxy": {
			trusted:    proxied,
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7"},
			want:       "203.0.113.7",
		},
		// The LAST hop is the address the trusted proxy itself saw and
		// appended, so a client that forges leading entries cannot pick its
		// own bucket even through a real proxy.
		"trusted proxy, client-forged prefix": {
			trusted:    proxied,
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Forwarded-For": "1.2.3.4, 5.6.7.8, 203.0.113.7"},
			want:       "203.0.113.7",
		},
		"trusted proxy, X-Real-IP fallback": {
			trusted:    proxied,
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Real-IP": "203.0.113.9"},
			want:       "203.0.113.9",
		},
		"loopback is trusted by default": {
			trusted:    defaultTrustedProxies,
			remoteAddr: "127.0.0.1:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7"},
			want:       "203.0.113.7",
		},
		// A published container port makes every request arrive from the
		// bridge gateway. That is a private address but it is NOT a proxy, so
		// it must not be trusted by default.
		"private address is not trusted by default": {
			trusted:    defaultTrustedProxies,
			remoteAddr: "172.17.0.1:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7"},
			want:       "172.17.0.1",
		},
		"nil trust list trusts nobody": {
			trusted:    nil,
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7"},
			want:       "10.0.0.2",
		},
		"IPv6 direct": {
			trusted:    proxied,
			remoteAddr: "[2001:db8::1]:51234",
			want:       "2001:db8::1",
		},
		"IPv6 loopback is trusted by default": {
			trusted:    defaultTrustedProxies,
			remoteAddr: "[::1]:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7"},
			want:       "203.0.113.7",
		},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
		req.RemoteAddr = tc.remoteAddr
		for k, val := range tc.headers {
			req.Header.Set(k, val)
		}
		if got := clientIP(req, tc.trusted); got != tc.want {
			t.Errorf("%s: clientIP = %q, want %q", name, got, tc.want)
		}
	}
}

// The regression test for the real bypass this shipped with: one caller
// rotating X-Forwarded-For got 90 ceremonies through a limit of 30, because the
// header was believed before the peer was checked.
func TestCeremonyLimiter_CannotBeBypassedByForgingForwardedFor(t *testing.T) {
	v := newVault(t)

	allowed := 0
	for i := range ceremonyRateLimitMax * 3 {
		req := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
		req.Host = testHost
		req.RemoteAddr = "203.0.113.7:40000" // one attacker, one real address
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i%250))
		rec := httptest.NewRecorder()
		v.h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			allowed++
		}
	}
	if allowed > ceremonyRateLimitMax {
		t.Fatalf("one caller rotating X-Forwarded-For got %d ceremonies through a limit of %d",
			allowed, ceremonyRateLimitMax)
	}
}

func TestParseTrustedProxies(t *testing.T) {
	if got, err := ParseTrustedProxies("  "); err != nil || len(got) != len(defaultTrustedProxies) {
		t.Fatalf("empty spec = %v, %v; want the loopback defaults", got, err)
	}
	got, err := ParseTrustedProxies("10.0.0.0/8, 192.168.1.5 ,fd00::/8")
	if err != nil {
		t.Fatalf("ParseTrustedProxies: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("parsed %d prefixes, want 3: %v", len(got), got)
	}
	// A bare address is the obvious way to name one proxy; it must mean that
	// host exactly, not silently widen.
	if !got[1].Contains(netip.MustParseAddr("192.168.1.5")) || got[1].Contains(netip.MustParseAddr("192.168.1.6")) {
		t.Errorf("bare address parsed to %v, want a single host", got[1])
	}
	if _, err := ParseTrustedProxies("not-an-address"); err == nil {
		t.Error("a malformed spec was accepted; it must fail at boot, not silently trust nothing")
	}
}

func TestRateLimiter_AllowsUpToMaxPerKeyThenRejects(t *testing.T) {
	rl := newRateLimiter(3, time.Minute)

	for i := range 3 {
		if !rl.Allow("a") {
			t.Fatalf("hit %d for key a was rejected below the limit", i+1)
		}
	}
	if rl.Allow("a") {
		t.Fatal("the 4th hit for key a was allowed past a limit of 3")
	}
	// Buckets are per key: one noisy client must not throttle anyone else.
	if !rl.Allow("b") {
		t.Fatal("key b was rejected because key a exhausted its own bucket")
	}
}

func TestRateLimiter_WindowExpiry(t *testing.T) {
	rl := newRateLimiter(1, 20*time.Millisecond)
	if !rl.Allow("a") {
		t.Fatal("first hit rejected")
	}
	if rl.Allow("a") {
		t.Fatal("second hit inside the window was allowed")
	}
	time.Sleep(30 * time.Millisecond)
	if !rl.Allow("a") {
		t.Fatal("hit after the window elapsed was still rejected")
	}
}

func TestLimitByIP_Returns429WithNoDetail(t *testing.T) {
	rl := newRateLimiter(1, time.Minute)
	h := limitByIP(rl, defaultTrustedProxies, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	call := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
		req.RemoteAddr = "203.0.113.7:1234"
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}
	if got := call().Code; got != http.StatusOK {
		t.Fatalf("first call = %d, want 200", got)
	}
	rec := call()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second call = %d, want 429", rec.Code)
	}
	// The 429 must not become an enumeration oracle: it says nothing about
	// whether any account or credential exists.
	body := strings.ToLower(rec.Body.String())
	for _, leak := range []string{"account", "credential", "unknown", "exists"} {
		if strings.Contains(body, leak) {
			t.Errorf("429 body %q leaks %q", rec.Body.String(), leak)
		}
	}
}

func TestCeremonyRoutesAreRateLimited(t *testing.T) {
	v := newVault(t)
	var last int
	for range ceremonyRateLimitMax + 1 {
		last = v.do(http.MethodPost, "/api/webauthn/login/begin", nil).Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("hit %d past the ceremony limit = %d, want 429", ceremonyRateLimitMax+1, last)
	}
}
