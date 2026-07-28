package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The reason this file exists. Behind a reverse proxy every request's
// RemoteAddr is the proxy's, so keying the limiter on it puts the whole
// internet in one bucket and one client's retries lock everyone out.
func TestClientIP_PrefersTheProxysObservedAddress(t *testing.T) {
	for name, tc := range map[string]struct {
		remoteAddr string
		headers    map[string]string
		want       string
	}{
		"direct connection": {
			remoteAddr: "203.0.113.7:51234",
			want:       "203.0.113.7",
		},
		"behind one proxy": {
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7"},
			want:       "203.0.113.7",
		},
		// The LAST hop is the address the proxy itself saw and appended, so a
		// client that forges leading entries cannot pick its own bucket.
		"client-forged X-Forwarded-For prefix": {
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Forwarded-For": "1.2.3.4, 5.6.7.8, 203.0.113.7"},
			want:       "203.0.113.7",
		},
		"X-Real-IP fallback": {
			remoteAddr: "10.0.0.2:8080",
			headers:    map[string]string{"X-Real-IP": "203.0.113.9"},
			want:       "203.0.113.9",
		},
		"IPv6 direct": {
			remoteAddr: "[2001:db8::1]:51234",
			want:       "2001:db8::1",
		},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
		req.RemoteAddr = tc.remoteAddr
		for k, val := range tc.headers {
			req.Header.Set(k, val)
		}
		if got := clientIP(req); got != tc.want {
			t.Errorf("%s: clientIP = %q, want %q", name, got, tc.want)
		}
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
	h := limitByIP(rl, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

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
