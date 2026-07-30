// The pre-fetched quote universe — "stock quotes with no API key anywhere",
// without giving up ARCHITECTURE.md §7's privacy property.
//
// WHY THIS EXISTS. Measured 2026-07-30 (bd memories no-keyless-cors-stock-
// provider): there is no keyless CORS-enabled stock provider. Yahoo's
// /v8/finance/chart answers correct JSON but sends no access-control-allow-
// origin, so a browser fetch completes at the network layer and the READ is
// blocked; Stooq serves a JavaScript proof-of-work challenge instead of CSV. So
// for a user with no provider key the choice is not "proxy vs browser-direct" —
// it is "server-side fetch or no stock quotes at all".
//
// THE PRIVACY PROPERTY, which is the entire reason this is preferred over the
// consented on-demand proxy (§7's "opt-in proxy fallback", bd myportfolio-18h.8):
// this endpoint takes NO INPUT. It serves one blob covering a fixed list of
// symbols, byte-identical for every caller, and the client filters it to its own
// holdings locally. The server therefore cannot learn a holding — not because it
// promises not to look, but because every request is literally the same request.
// That is why there is no consent screen here, no per-account flag, and nothing
// to revoke.
//
// THE INSTANT IT TAKES A SYMBOL PARAMETER IT BECOMES THE PROXY, with the proxy's
// privacy cost and none of the proxy's consent flow. TestUniverseIgnoresQuery
// pins that. Two endpoints, never one with a parameter.
//
// Yahoo is UNDOCUMENTED, unversioned and unblessed, and can start refusing
// datacentre IPs without notice — it was refusing the development machine with
// HTTP 429 on the very day this was written. So it is a SOFT dependency
// throughout: a failed refresh keeps the previous blob and lets its per-symbol
// `date` fields show the staleness, and the supported path stays the user's own
// key browser-direct (§7), which still covers every symbol this list misses.
//
// NO CSP CHANGE, and no entry in quotes.js's QUOTE_HOSTS: this is a
// server-to-server fetch. The browser only ever calls our own origin, which
// connect-src 'self' already admits. Adding Yahoo to the allowlist would widen
// egress for a host the browser still cannot read from.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/myportfolio/internal/store"
)

// The universe. A checked-in list, deliberately not a config file, a database
// table or an admin UI: it changes when someone edits this file and opens a pull
// request, which is the right amount of ceremony for "which few hundred symbols
// do we pre-fetch". A symbol outside it falls back to the user's own key, which
// already works — so being incomplete is graceful, and being slightly wrong
// (a delisted or mistyped ticker) costs one skipped request per cycle.
//
// Scope: US large caps and the common US ETFs, plus the European listings a
// EUR-reporting portfolio actually holds — XETRA, Amsterdam, Paris, Milan,
// Madrid, Zurich, the Nordics — and the big UCITS accumulating ETFs.
//
// London (.L) is deliberately ABSENT. Yahoo quotes LSE lines in pence and
// reports the currency as "GBp", and a pence close applied to a GBP position is
// wrong by 100x. The client already refuses a currency mismatch, so including
// them would only burn requests to produce entries nothing may use.
//
// No crypto: CoinGecko is keyless AND CORS-enabled, so crypto already works
// browser-direct and routing it through here would be a privacy regression for
// no gain.
const universeSymbolList = `
AAPL MSFT NVDA AMZN GOOGL GOOG META TSLA AVGO BRK-B LLY JPM V UNH XOM MA JNJ PG
COST HD ABBV WMT MRK NFLX KO PEP ADBE CVX CRM BAC AMD TMO ACN MCD ABT PM CSCO
ORCL WFC IBM GE DIS INTU QCOM NOW TXN CAT AMGN VZ DHR NEE PFE SPGI UNP RTX LOW
AXP HON AMAT BKNG COP ETN BLK SYK TJX MS PGR BSX C ADP MDT VRTX GILD LMT SCHW
MMC CB ADI PLD MU DE SO REGN BMY ELV CI FI KLAC PANW SBUX ZTS CME ICE MO DUK
EOG SHW AON APH CSX ITW MCK NOC WM PYPL SNPS CDNS EMR MSI ORLY FDX GD PSA TGT
NSC ROP AJG APD MAR ECL CARR SLB TT AZO HCA MET AIG PCAR TRV OXY KMB ADSK NXPI
CTAS DXCM EW IDXX ROST TEL MNST F GM DAL UAL ABNB UBER PLTR COIN SHOP SNOW
CRWD DDOG NET ZS MDB SPOT INTC

SPY VOO IVV VTI QQQ VEA VWO IEFA IEMG AGG BND VIG VYM SCHD DIA IWM IJH IJR EFA
GLD SLV TLT LQD HYG VNQ XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC ARKK

SAP.DE SIE.DE ALV.DE DTE.DE AIR.DE MBG.DE BMW.DE VOW3.DE BAS.DE BAYN.DE MRK.DE
MUV2.DE DBK.DE DB1.DE ADS.DE IFX.DE RWE.DE EOAN.DE DHL.DE HEI.DE SHL.DE
HNR1.DE SY1.DE VNA.DE BEI.DE CBK.DE FRE.DE PAH3.DE P911.DE ZAL.DE 1COV.DE
CON.DE HEN3.DE QIA.DE SRT3.DE MTX.DE RHM.DE

VWCE.DE EUNL.DE SXR8.DE VUSA.DE IUSQ.DE VGWL.DE IUSA.DE XDWD.DE SPYY.DE
EXS1.DE EXXT.DE IS3N.DE IBC3.DE SXRV.DE VWCE.MI AGGH.MI SWDA.MI VWRL.AS
IWDA.AS EMIM.AS VUSD.AS

ASML.AS ADYEN.AS INGA.AS PHIA.AS HEIA.AS AD.AS DSFIR.AS WKL.AS REN.AS AKZA.AS
KPN.AS NN.AS ABN.AS PRX.AS UMG.AS BESI.AS ASM.AS RAND.AS IMCD.AS

MC.PA OR.PA TTE.PA SAN.PA AIR.PA SU.PA AI.PA EL.PA BNP.PA CS.PA DG.PA RMS.PA
KER.PA SAF.PA ORA.PA CAP.PA VIE.PA ACA.PA GLE.PA STLAP.PA RI.PA BN.PA LR.PA
HO.PA ENGI.PA PUB.PA ML.PA SGO.PA VIV.PA EN.PA

ENI.MI ISP.MI UCG.MI ENEL.MI STLAM.MI G.MI RACE.MI PRY.MI MONC.MI TIT.MI

SAN.MC IBE.MC ITX.MC BBVA.MC TEF.MC AENA.MC REP.MC FER.MC

NESN.SW ROG.SW NOVN.SW UBSG.SW ZURN.SW ABBN.SW CFR.SW SIKA.SW LONN.SW GIVN.SW

NOVO-B.CO ASSA-B.ST VOLV-B.ST ATCO-A.ST ERIC-B.ST INVE-B.ST NDA-SE.ST
SEB-A.ST HEXA-B.ST EQNR.OL DNB.OL NOKIA.HE SAMPO.HE
`

var universeSymbols = strings.Fields(universeSymbolList)

// Delay between upstream requests. The endpoint is single-symbol, so one cycle
// is len(universeSymbols) requests — a couple of minutes at this pace, four
// times a day, from one IP.
//
// THIS IS THE CALIBRATION KNOB, and the one number here most likely to need
// turning: Yahoo publishes no rate limit and enforces one anyway (it was
// answering 429 to the development machine on the day this was written). Raise
// it if the logs show refusals — there is no deadline on a daily close. A var
// only so the tests need not wait it out.
var universePace = 500 * time.Millisecond

// The upstream. A var only so a test can point it at a local double — nothing at
// runtime rewrites it. It is NOT in quotes.js's QUOTE_HOSTS and must not be: the
// browser never contacts it (landmine 4). See the file header.
var universeChartURL = "https://query1.finance.yahoo.com/v8/finance/chart/"

const (
	// How often the universe is re-fetched. These are DAILY closes, so this is
	// about catching the day's close reasonably soon after it prints, not about
	// intraday freshness. Four cycles a day also means a symbol Yahoo refused
	// once gets three more chances before the day is out.
	universeInterval = 6 * time.Hour

	// Consecutive refusals (429/403) before a cycle gives up. Yahoo blocks by IP
	// for a while once it decides to, so hundreds of further requests would only
	// prove the point at its expense and ours. The previous blob stands.
	universeGiveUpAfter = 15

	// Per-request deadline and body cap. A chart response is a few KB; anything
	// enormously larger is not the endpoint we think it is.
	universeRequestTimeout = 15 * time.Second
	universeMaxBodyBytes   = 1 << 20

	// How long a shared cache may keep the blob. It is identical for every
	// caller and contains no user data, so `public` is correct here even though
	// every other response on this origin is no-store.
	universeMaxAgeSeconds = 1800

	// Sent upstream instead of a browser's User-Agent. Honest about who is
	// calling: if Yahoo ever serves us only when we pretend to be Chrome, that
	// is Yahoo telling us this dependency is unwelcome, and the answer is to
	// respect it rather than to lie better.
	universeUserAgent = "myportfolio/1.0 (+https://github.com/korjavin/myportfolio)"
)

// universeQuote is one symbol's latest daily close.
//
// Close is a STRING carrying the digits exactly as the upstream printed them,
// and that is load-bearing (§5, landmine 6): money crosses the float boundary
// exactly once, in web/domain/quotes.js's priceUnits/parseFixed, at the 1e8
// price scale — the same place every other provider crosses it. This server
// never parses a price. It validates the shape of the literal and forwards it,
// the way Twelve Data's decimal strings already flow through untouched.
//
// Currency is the upstream's own currency code, forwarded verbatim so the client
// can REFUSE a mismatch against the security's currency. That check is what
// makes matching by ticker safe: "SAN.PA" priced in EUR must never be applied to
// a position denominated in something else.
type universeQuote struct {
	Date     string `json:"date"`
	Close    string `json:"close"`
	Currency string `json:"currency"`
}

// universeBlob is the response body.
//
// AsOf is when the refresh that produced this blob ran — NOT the age of every
// close in it. A cycle where Yahoo refused half the list keeps the previous
// closes for those symbols, and each entry's own `date` is what says how old it
// is. Reporting one age for the whole blob would hide exactly that.
type universeBlob struct {
	AsOf   string                   `json:"asOf"`
	Quotes map[string]universeQuote `json:"quotes"`
}

// What the endpoint answers before any refresh has ever succeeded. A 200 with no
// quotes rather than a 5xx: the client's fallback for "the universe does not
// have this symbol" is the same code path as for "the universe has nothing at
// all", so an empty blob needs no error handling anywhere and cannot turn a cold
// start into a broken screen (landmine 2).
var emptyUniverse = []byte(`{"asOf":"","quotes":{}}`)

// getQuoteUniverse serves the blob. No parameters, no session, no logging of who
// asked — see the file header.
func (a *API) getQuoteUniverse(w http.ResponseWriter, r *http.Request) {
	body, updatedAt, err := a.db.GetQuoteUniverse(r.Context())
	if err != nil {
		// Never a hard error: the whole feature is optional, and a client that
		// gets nothing here just uses its own provider.
		slog.Error("universe: read", "error", err)
		body, updatedAt = nil, 0
	}
	if len(body) == 0 {
		body, updatedAt = emptyUniverse, 0
	}

	// The store row changes only when a refresh commits, so its timestamp plus
	// length identifies the bytes. Deliberately not a hash of the body: the
	// hash's only advantage would be catching two different bodies stored in the
	// same second with the same length, and there is one writer running four
	// times a day.
	etag := `"u` + strconv.FormatInt(updatedAt, 10) + `-` + strconv.Itoa(len(body)) + `"`

	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("ETag", etag)
	// Overrides securityHeaders' blanket no-store, and this is the one response
	// on the origin where that is right: it is the same bytes for everyone.
	h.Set("Cache-Control", "public, max-age="+strconv.Itoa(universeMaxAgeSeconds))
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(body)
}

// StartQuoteUniverse refreshes the universe until ctx is done. One goroutine
// with one ticker, started from main — not a scheduler abstraction, because
// there is one job.
//
// It is intentionally NOT started by New(): the handler and the refresher share
// only the database row, so tests get the endpoint with no goroutine reaching
// out to the internet.
func StartQuoteUniverse(ctx context.Context, db *store.DB) {
	// A dedicated client with NO cookie jar (landmine 3: nothing of the caller's
	// goes upstream — and there is no caller, the refresh runs on a timer).
	client := &http.Client{Timeout: universeRequestTimeout}
	for {
		_, updatedAt, err := db.GetQuoteUniverse(ctx)
		// Skip the immediate refresh when the stored blob is still young. Without
		// this, a crash-looping or frequently redeployed container re-fetches the
		// whole universe on every boot, which is the surest way to get an IP
		// banned by an endpoint that publishes no rate limit.
		if err != nil || time.Since(time.Unix(updatedAt, 0)) >= universeInterval {
			if err := refreshQuoteUniverse(ctx, db, client, time.Now); err != nil && ctx.Err() == nil {
				slog.Warn("universe: refresh failed, previous blob stands", "error", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(universeInterval):
		}
	}
}

// refreshQuoteUniverse fetches every symbol and replaces the stored blob.
//
// The merge is the soft-dependency guarantee (landmine 2): a symbol the upstream
// refused this cycle keeps the close it had, so a partial outage degrades
// per-symbol instead of deleting good data. A cycle that fetched NOTHING new
// writes nothing at all — otherwise it would restamp `asOf` and claim freshness
// it does not have.
//
// Symbols dropped from universeSymbols are dropped from the blob: the list is
// the contract, so a removed ticker must not live on forever in the stored copy.
func refreshQuoteUniverse(ctx context.Context, db *store.DB, client *http.Client, now func() time.Time) error {
	previous := loadPreviousQuotes(ctx, db)

	quotes := make(map[string]universeQuote, len(universeSymbols))
	fresh, refused, failed := 0, 0, 0
fetch:
	for i, symbol := range universeSymbols {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(universePace):
			}
		}
		quote, err := fetchYahooClose(ctx, client, symbol)
		switch {
		case err == nil:
			quotes[symbol] = quote
			fresh++
			refused = 0
		case errors.Is(err, errUpstreamRefused):
			refused++
			failed++
			if refused >= universeGiveUpAfter {
				slog.Warn("universe: upstream is refusing us, abandoning this cycle",
					"consecutive_refusals", refused, "fetched", fresh, "symbols", len(universeSymbols))
				// A break, not a return: whatever landed before the wall is still
				// worth storing alongside the previous closes.
				break fetch
			}
		default:
			// One symbol's problem — a delisted ticker, a null close, a shape we
			// do not recognise. Never logged with anything about a caller,
			// because there is no caller.
			failed++
		}
	}
	if fresh == 0 {
		return fmt.Errorf("universe: no symbol resolved (%d failures over %d symbols)", failed, len(universeSymbols))
	}
	// Fill the gaps from the previous blob, for symbols still on the list.
	for _, symbol := range universeSymbols {
		if _, ok := quotes[symbol]; ok {
			continue
		}
		if old, ok := previous[symbol]; ok {
			quotes[symbol] = old
		}
	}

	// Encoded ONCE, here, and stored as bytes. encoding/json sorts map keys, so
	// this is deterministic — but determinism is not what the endpoint promises:
	// it promises the same bytes, and serving the stored bytes is how that is
	// guaranteed rather than argued.
	body, err := json.Marshal(universeBlob{AsOf: now().UTC().Format(time.RFC3339), Quotes: quotes})
	if err != nil {
		return fmt.Errorf("universe: encode blob: %w", err)
	}
	if err := db.PutQuoteUniverse(ctx, body, now()); err != nil {
		return err
	}
	// A count is all there is worth recording (landmine 3).
	slog.Info("universe: refreshed", "fetched", fresh, "carried_over", len(quotes)-fresh,
		"failed", failed, "symbols", len(universeSymbols), "bytes", len(body))
	return nil
}

// loadPreviousQuotes reads the stored blob's quotes, or an empty map. A stored
// blob we cannot parse is treated as absent rather than fatal — it can only have
// come from an older or newer build of this file.
func loadPreviousQuotes(ctx context.Context, db *store.DB) map[string]universeQuote {
	body, _, err := db.GetQuoteUniverse(ctx)
	if err != nil || len(body) == 0 {
		return nil
	}
	var blob universeBlob
	if err := json.Unmarshal(body, &blob); err != nil {
		return nil
	}
	return blob.Quotes
}

// errUpstreamRefused is a rate limit or a block — a property of the upstream and
// of our IP, not of the symbol, so the cycle stops rather than working through
// the rest of the list proving it.
var errUpstreamRefused = errors.New("upstream refused the request")

// yahooChart is the slice of /v8/finance/chart we read.
//
// Close is []json.Number so the decimal literal survives verbatim; a null close
// (a holiday, a halted session) decodes to the empty string, which is exactly
// how it is detected below.
type yahooChart struct {
	Chart struct {
		Result []struct {
			Meta struct {
				Currency  string `json:"currency"`
				GMTOffset int64  `json:"gmtoffset"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Close []json.Number `json:"close"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
	} `json:"chart"`
}

// A plain unsigned decimal literal. Not a money parse — this server never turns
// a price into a number (see universeQuote) — just a refusal to forward whatever
// an upstream happens to put in that slot into a field a client will parse.
var decimalLiteral = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)

// fetchYahooClose returns the most recent non-null daily close for one symbol.
//
// range=5d rather than 1d because the newest close a stock market can have is
// often days old: over a weekend plus a public holiday, a 1d window can be empty
// and there is nothing to serve. Five days always contains at least one session.
func fetchYahooClose(ctx context.Context, client *http.Client, symbol string) (universeQuote, error) {
	var zero universeQuote

	// PathEscape, even though every symbol in the list is a literal in this
	// file: the day someone adds a ticker with a slash or a caret, a hand-built
	// path would quietly request something else.
	endpoint := universeChartURL + url.PathEscape(symbol) + "?range=5d&interval=1d"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return zero, err
	}
	// Exactly two headers, and no Referer, no cookies, no forwarded-for: the
	// upstream learns that myportfolio wants a close, and nothing about anyone.
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", universeUserAgent)

	res, err := client.Do(req)
	if err != nil {
		return zero, err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusTooManyRequests || res.StatusCode == http.StatusForbidden:
		return zero, fmt.Errorf("%w: HTTP %d", errUpstreamRefused, res.StatusCode)
	case res.StatusCode != http.StatusOK:
		return zero, fmt.Errorf("%s: HTTP %d", symbol, res.StatusCode)
	}

	var payload yahooChart
	if err := json.NewDecoder(io.LimitReader(res.Body, universeMaxBodyBytes)).Decode(&payload); err != nil {
		return zero, fmt.Errorf("%s: decode: %w", symbol, err)
	}
	if len(payload.Chart.Result) == 0 || len(payload.Chart.Result[0].Indicators.Quote) == 0 {
		return zero, fmt.Errorf("%s: no chart result", symbol)
	}
	result := payload.Chart.Result[0]
	closes := result.Indicators.Quote[0].Close
	if result.Meta.Currency == "" {
		// Without a currency the client cannot check that this price belongs to
		// the position it would be applied to, so the quote is unusable.
		return zero, fmt.Errorf("%s: no currency in meta", symbol)
	}

	// Backwards: the last usable bar is the one we want, and the trailing bars
	// are the ones most likely to be null (today's session, before its close).
	for i := min(len(closes), len(result.Timestamp)) - 1; i >= 0; i-- {
		lit := strings.TrimSpace(closes[i].String())
		// A zero, negative or unparseable price is not a quote, it is a bad
		// payload — the same judgement quotes.js's priceUnits makes, made here
		// too so a null-shaped hole never reaches a client as a valid-looking
		// field.
		if !decimalLiteral.MatchString(lit) || strings.Trim(lit, "0.") == "" {
			continue
		}
		// The exchange's own calendar day, from its own UTC offset — which is
		// what a daily close is dated by, and what Twelve Data's `datetime`
		// already returns. Using the bar's UTC day instead would label a Tokyo or
		// Auckland session with the wrong date.
		day := time.Unix(result.Timestamp[i]+result.Meta.GMTOffset, 0).UTC().Format(time.DateOnly)
		return universeQuote{Date: day, Close: lit, Currency: result.Meta.Currency}, nil
	}
	return zero, fmt.Errorf("%s: no non-null close in the window", symbol)
}
