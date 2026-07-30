package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/myportfolio/internal/store"
)

func newUniverseServer(t *testing.T) (http.Handler, *store.DB) {
	t.Helper()
	db, err := store.Open(context.Background(), t.TempDir()+"/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return New(testFS(), db, testSessionSecret, defaultTrustedProxies), db
}

// chartJSON is a /v8/finance/chart response with one usable bar plus a trailing
// null one, which is what the endpoint really returns mid-session.
func chartJSON(currency string, gmtOffset, ts int64, close string) string {
	i := strconv.FormatInt
	return `{"chart":{"result":[{"meta":{"currency":"` + currency +
		`","gmtoffset":` + i(gmtOffset, 10) + `},"timestamp":[` + i(ts-86400, 10) + `,` + i(ts, 10) +
		`],"indicators":{"quote":[{"close":[1.5,` + close + `]}]}}],"error":null}}`
}

// withUpstream points the refresher at a local double and shortens the pace so a
// test is not gated on the real inter-request delay.
func withUpstream(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	prevURL, prevPace := universeChartURL, universePace
	universeChartURL = srv.URL + "/v8/finance/chart/"
	universePace = time.Millisecond
	t.Cleanup(func() { universeChartURL, universePace = prevURL, prevPace })
}

func setSymbols(t *testing.T, symbols ...string) {
	t.Helper()
	prev := universeSymbols
	universeSymbols = symbols
	t.Cleanup(func() { universeSymbols = prev })
}

// LANDMINE 1, and the reason this design is preferred over the consented proxy:
// the endpoint must never accept a symbol. Any query string it is handed must
// produce the same bytes as none at all — otherwise it is an on-demand proxy
// wearing a cache's clothes, and the server can be asked what you hold.
func TestUniverseIgnoresQuery(t *testing.T) {
	h, db := newUniverseServer(t)
	if err := db.PutQuoteUniverse(context.Background(),
		[]byte(`{"asOf":"2026-07-30T06:00:00Z","quotes":{"AAPL":{"date":"2026-07-29","close":"1.5","currency":"USD"}}}`),
		time.Unix(1_780_000_000, 0)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	base := get(t, h, "/api/quotes/universe").Body.String()
	for _, q := range []string{
		"?symbol=AAPL",
		"?symbols=AAPL,MSFT",
		"?symbol=SECRET-HOLDING",
		"?q=&symbol=&filter=AAPL",
	} {
		rec := get(t, h, "/api/quotes/universe"+q)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", q, rec.Code)
		}
		if rec.Body.String() != base {
			t.Fatalf("%s: body differs from the unparameterised response.\n got: %s\nwant: %s",
				q, rec.Body.String(), base)
		}
	}
}

// The same landmine, pinned at the source level, because the byte-identity test
// above would still pass if a future edit read a parameter and used it for
// something other than the body — logging it, say, which is exactly the leak.
func TestUniverseHandlerReadsNoRequestInput(t *testing.T) {
	src, err := os.ReadFile("universe.go")
	if err != nil {
		t.Fatalf("read universe.go: %v", err)
	}
	// Comments in this file legitimately discuss parameters; the forbidden thing
	// is the code that would read one.
	for _, forbidden := range []string{"URL.Query", "FormValue", "PathValue", "ParseForm", "URL.RawQuery"} {
		if strings.Contains(string(src), forbidden) {
			t.Errorf("universe.go calls %s. This endpoint must take NO input: the moment it does, "+
				"it is the consented on-demand proxy (bd myportfolio-18h.8) without the consent, "+
				"and the server can be asked which symbols you hold.", forbidden)
		}
	}
}

// Two different callers, no session cookie, no API key configured anywhere: the
// same bytes. That is the whole contract.
func TestUniverseIsIdenticalAndUnauthenticated(t *testing.T) {
	h, db := newUniverseServer(t)
	body := []byte(`{"asOf":"2026-07-30T06:00:00Z","quotes":{"VWCE.DE":{"date":"2026-07-29","close":"142.7","currency":"EUR"}}}`)
	if err := db.PutQuoteUniverse(context.Background(), body, time.Unix(1_780_000_000, 0)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/quotes/universe", nil))

	second := httptest.NewRecorder()
	other := httptest.NewRequest(http.MethodGet, "/api/quotes/universe", nil)
	other.Header.Set("Cookie", "mp_session=someone-elses")
	other.RemoteAddr = "203.0.113.9:1234"
	h.ServeHTTP(second, other)

	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("status %d / %d", first.Code, second.Code)
	}
	if first.Body.String() != string(body) || second.Body.String() != string(body) {
		t.Fatalf("bodies are not the stored bytes:\n%q\n%q", first.Body.String(), second.Body.String())
	}
	if ct := first.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	// Cacheable, unlike every other response on this origin — it is the same
	// bytes for everyone, so a shared cache leaks nothing.
	if cc := first.Header().Get("Cache-Control"); !strings.Contains(cc, "public") {
		t.Errorf("Cache-Control = %q, want a public directive", cc)
	}
}

func TestUniverseETagRevalidates(t *testing.T) {
	h, db := newUniverseServer(t)
	if err := db.PutQuoteUniverse(context.Background(),
		[]byte(`{"asOf":"x","quotes":{}}`), time.Unix(1_780_000_000, 0)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	first := get(t, h, "/api/quotes/universe")
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag")
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/quotes/universe", nil)
	req.Header.Set("If-None-Match", etag)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 carried a body: %q", rec.Body.String())
	}
}

// Cold start, before any refresh has succeeded: a 200 with an empty universe, not
// a 5xx. The client's "this symbol is not in the universe" path and its "there is
// no universe" path are then the same path, so nothing has to handle an error.
func TestUniverseServesEmptyBeforeFirstRefresh(t *testing.T) {
	h, _ := newUniverseServer(t)
	rec := get(t, h, "/api/quotes/universe")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var blob universeBlob
	if err := json.Unmarshal(rec.Body.Bytes(), &blob); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(blob.Quotes) != 0 {
		t.Fatalf("quotes = %v, want empty", blob.Quotes)
	}
}

func TestRefreshUniverseFetchesAndForwardsTheLiteral(t *testing.T) {
	_, db := newUniverseServer(t)
	setSymbols(t, "AAPL", "SAP.DE")
	var sawCookie, sawReferer bool
	withUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			sawCookie = true
		}
		if r.Header.Get("Referer") != "" {
			sawReferer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/AAPL"):
			// The ugly float32 artifact Yahoo really sends. It must arrive at the
			// client digit-for-digit: this server does not round money.
			_, _ = w.Write([]byte(chartJSON("USD", -14400, 1_753_790_400, "213.88999938964844")))
		case strings.HasSuffix(r.URL.Path, "/SAP.DE"):
			_, _ = w.Write([]byte(chartJSON("EUR", 7200, 1_753_790_400, "251.55")))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	if err := refreshQuoteUniverse(context.Background(), db, http.DefaultClient,
		func() time.Time { return time.Unix(1_780_000_000, 0) }); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if sawCookie || sawReferer {
		t.Error("the upstream fetch carried a Cookie or Referer; nothing of any caller may go upstream")
	}

	body, _, err := db.GetQuoteUniverse(context.Background())
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var blob universeBlob
	if err := json.Unmarshal(body, &blob); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := blob.Quotes["AAPL"].Close; got != "213.88999938964844" {
		t.Errorf("AAPL close = %q, want the upstream literal unrounded", got)
	}
	if got := blob.Quotes["AAPL"].Currency; got != "USD" {
		t.Errorf("AAPL currency = %q", got)
	}
	// The exchange's own calendar day, from meta.gmtoffset — not the bar's UTC
	// day, which would misdate any exchange whose session does not sit inside a
	// UTC date.
	// 1753790400 is 2025-07-29 12:00Z; +7200 keeps it inside the exchange's own
	// 29th. A UTC-day reading would agree here and disagree for Tokyo, which is
	// why the offset is applied at all.
	if got := blob.Quotes["SAP.DE"].Date; got != "2025-07-29" {
		t.Errorf("SAP.DE date = %q, want 2025-07-29", got)
	}
	if blob.AsOf == "" {
		t.Error("asOf is empty")
	}
}

// LANDMINE 2. An upstream that refuses everything must leave the previous blob
// exactly as it was — never a 500, never an empty blob overwriting good data.
func TestRefreshUniverseKeepsPreviousBlobWhenUpstreamRefuses(t *testing.T) {
	_, db := newUniverseServer(t)
	setSymbols(t, "AAPL", "MSFT", "SAP.DE")
	good := []byte(`{"asOf":"2026-07-20T06:00:00Z","quotes":{"AAPL":{"date":"2026-07-17","close":"200","currency":"USD"}}}`)
	if err := db.PutQuoteUniverse(context.Background(), good, time.Unix(1_779_000_000, 0)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	withUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	err := refreshQuoteUniverse(context.Background(), db, http.DefaultClient, time.Now)
	if err == nil {
		t.Fatal("a total upstream failure should report an error to its caller")
	}

	body, at, readErr := db.GetQuoteUniverse(context.Background())
	if readErr != nil {
		t.Fatalf("read back: %v", readErr)
	}
	if string(body) != string(good) || at != 1_779_000_000 {
		t.Fatalf("the previous blob was disturbed: %s (at %d)", body, at)
	}
}

// A partial outage degrades per symbol: the ones that answered are fresh, the
// ones that did not keep the close they had, and each entry's own `date` is what
// tells the client which is which.
func TestRefreshUniverseCarriesOverWhatItCouldNotRefetch(t *testing.T) {
	_, db := newUniverseServer(t)
	setSymbols(t, "AAPL", "MSFT")
	if err := db.PutQuoteUniverse(context.Background(),
		[]byte(`{"asOf":"2026-07-20T06:00:00Z","quotes":{`+
			`"AAPL":{"date":"2026-07-17","close":"200","currency":"USD"},`+
			`"MSFT":{"date":"2026-07-17","close":"400","currency":"USD"}}}`),
		time.Unix(1_779_000_000, 0)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	withUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/AAPL") {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(chartJSON("USD", -14400, 1_753_790_400, "213.5")))
	})
	if err := refreshQuoteUniverse(context.Background(), db, http.DefaultClient, time.Now); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	body, _, err := db.GetQuoteUniverse(context.Background())
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var blob universeBlob
	if err := json.Unmarshal(body, &blob); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := blob.Quotes["AAPL"].Close; got != "213.5" {
		t.Errorf("AAPL close = %q, want the fresh one", got)
	}
	if got := blob.Quotes["MSFT"].Close; got != "400" {
		t.Errorf("MSFT close = %q, want the carried-over one", got)
	}
	if got := blob.Quotes["MSFT"].Date; got != "2026-07-17" {
		t.Errorf("MSFT date = %q, want the old date so staleness is visible", got)
	}
}

// A symbol dropped from the list is dropped from the blob: the checked-in list is
// the contract, so a removed ticker must not live on in the stored copy forever.
func TestRefreshUniverseDropsSymbolsNoLongerOnTheList(t *testing.T) {
	_, db := newUniverseServer(t)
	setSymbols(t, "AAPL")
	if err := db.PutQuoteUniverse(context.Background(),
		[]byte(`{"asOf":"x","quotes":{"AAPL":{"date":"2026-07-17","close":"200","currency":"USD"},`+
			`"GONE":{"date":"2026-07-17","close":"1","currency":"USD"}}}`),
		time.Unix(1_779_000_000, 0)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	withUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(chartJSON("USD", -14400, 1_753_790_400, "213.5")))
	})
	if err := refreshQuoteUniverse(context.Background(), db, http.DefaultClient, time.Now); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	body, _, err := db.GetQuoteUniverse(context.Background())
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if strings.Contains(string(body), "GONE") {
		t.Fatalf("a delisted symbol survived the refresh: %s", body)
	}
}

// A null-only window, a zero close and a non-numeric close are all bad payloads,
// not quotes: letting one through would value a position at nothing.
func TestFetchYahooCloseRejectsUnusablePayloads(t *testing.T) {
	cases := map[string]string{
		"all-null closes":  `{"chart":{"result":[{"meta":{"currency":"USD","gmtoffset":0},"timestamp":[1753790400],"indicators":{"quote":[{"close":[null]}]}}]}}`,
		"zero close":       `{"chart":{"result":[{"meta":{"currency":"USD","gmtoffset":0},"timestamp":[1753790400],"indicators":{"quote":[{"close":[0.00]}]}}]}}`,
		"negative close":   `{"chart":{"result":[{"meta":{"currency":"USD","gmtoffset":0},"timestamp":[1753790400],"indicators":{"quote":[{"close":[-3.5]}]}}]}}`,
		"string close":     `{"chart":{"result":[{"meta":{"currency":"USD","gmtoffset":0},"timestamp":[1753790400],"indicators":{"quote":[{"close":["oops"]}]}}]}}`,
		"no currency":      `{"chart":{"result":[{"meta":{"gmtoffset":0},"timestamp":[1753790400],"indicators":{"quote":[{"close":[12.5]}]}}]}}`,
		"no result":        `{"chart":{"result":[],"error":{"code":"Not Found"}}}`,
		"nonsense payload": `{"chart":{}}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(payload))
			}))
			defer srv.Close()
			prev := universeChartURL
			universeChartURL = srv.URL + "/chart/"
			defer func() { universeChartURL = prev }()

			if _, err := fetchYahooClose(context.Background(), http.DefaultClient, "AAPL"); err == nil {
				t.Fatal("accepted an unusable payload")
			}
		})
	}
}

// The list is checked in, so the guard is that it is a list of plausible symbols
// and not, say, prose that strings.Fields happily shredded.
func TestUniverseSymbolListIsWellFormed(t *testing.T) {
	if len(universeSymbols) < 100 {
		t.Fatalf("only %d symbols; the list is meant to cover the common case", len(universeSymbols))
	}
	seen := make(map[string]bool, len(universeSymbols))
	for _, s := range universeSymbols {
		if seen[s] {
			t.Errorf("duplicate symbol %q — a duplicate is a wasted upstream request every cycle", s)
		}
		seen[s] = true
		if s != strings.ToUpper(s) || strings.ContainsAny(s, "/?&#") {
			t.Errorf("implausible symbol %q", s)
		}
		// London lines are quoted in pence with currency "GBp"; a pence close on a
		// GBP position is wrong by 100x, and the client refuses the mismatch, so
		// fetching them would only burn requests.
		if strings.HasSuffix(s, ".L") {
			t.Errorf("%q is a London line: Yahoo quotes those in pence (GBp)", s)
		}
	}
}

// LANDMINE 4: no CSP change. The browser only ever calls our own origin for this,
// so the upstream host must not appear in the connect-src allowlist.
func TestUniverseUpstreamIsNotInTheCSP(t *testing.T) {
	if strings.Contains(contentSecurityPolicy, "yahoo") {
		t.Fatalf("the upstream host reached connect-src: %s", contentSecurityPolicy)
	}
	if !strings.Contains(contentSecurityPolicy, "connect-src 'self'") {
		t.Fatalf("connect-src no longer starts at 'self': %s", contentSecurityPolicy)
	}
}
