package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/korjavin/myportfolio/internal/mcpshim"
)

// selfRequest is the request enable's SSRF check binds a pairing code's relay_url
// to: one whose Host is the origin the account holder actually reached. Every
// test that enables a connector has to build one, which is the point — there is
// no way to call enable without supplying the host the URL must match.
func selfRequest() *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/remote", nil)
	req.Host = testHost
	return req
}

// selfRequest for a fixture behind a real listener on a random port. Both halves
// are needed: relayURLIsSelf pins the port to what a browser origin produces, so
// a non-standard port is accepted only when it is this process's real listen port,
// which net/http reports through LocalAddrContextKey.
func (f *relayFixture) selfRequest() *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/remote", nil)
	req.Host = strings.TrimPrefix(f.srv.URL, "http://")
	return req.WithContext(context.WithValue(req.Context(), http.LocalAddrContextKey, f.srv.Listener.Addr()))
}

// enableHosted turns the hosted connector on for the fixture's account, through
// the registry the served handler holds, the way H3's Settings handler will.
func (f *relayFixture) enableHosted(t *testing.T, pairingID string) string {
	t.Helper()
	token, err := f.api.mcpRemote.enable(t.Context(), f.account, &mcpshim.PairingCode{
		RelayURL:  f.relayURL(),
		PairingID: pairingID,
		Key:       f.key,
	}, f.selfRequest())
	if err != nil {
		t.Fatalf("enable the hosted connector: %v", err)
	}
	return token
}

// connectHosted opens a real streamable-HTTP MCP session against /mcp/<token> —
// the same transport claude.ai and ChatGPT speak, against the real route.
func (f *relayFixture) connectHosted(t *testing.T, token string) *sdkmcp.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	session, err := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "hosted-endpoint-test", Version: "1"}, nil).
		Connect(ctx, &sdkmcp.StreamableClientTransport{Endpoint: f.srv.URL + "/mcp/" + token}, nil)
	if err != nil {
		t.Fatalf("connect to the hosted endpoint: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

// callHosted runs one tool call and returns the result, failing on a PROTOCOL
// error. That distinction is the whole reason this helper asserts rather than
// returning the error: the SDK turns a *jsonrpc.Error into a top-level failure an
// MCP client renders as "the connector is broken", which the model never reads —
// so every failure this endpoint can produce has to come back as a tool result.
func callHosted(t *testing.T, session *sdkmcp.ClientSession, name string, args map[string]any) *sdkmcp.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	res, err := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("tools/call %s came back as a protocol error, which the client renders as a broken connector and the model never reads: %v", name, err)
	}
	return res
}

func resultText(t *testing.T, res *sdkmcp.CallToolResult) string {
	t.Helper()
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*sdkmcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

// shortenCallTimeout makes the no-device path observable without waiting out the
// production 30s. Nothing else in the process reads it, and these tests do not run
// in parallel.
func shortenCallTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	prev := mcpshim.CallTimeout
	mcpshim.CallTimeout = d
	t.Cleanup(func() { mcpshim.CallTimeout = prev })
}

// The bead's headline acceptance, and the owner's sentence: a URL the user pastes
// into Claude proxies to their unlocked device. Everything in between is real —
// the route, the token check, the streamable transport, the internal shim client,
// the relay, the sealed frames — and the only stand-in is the browser responder,
// which is JavaScript (web/static/js/core/mcp-responder.js) and cannot run here.
func TestHostedEndpointReachesTheDeviceThroughTheRelay(t *testing.T) {
	f := newRelayFixture(t)
	pairingID := f.mint(t)
	go respondOnDevice(t, f.dialDevice(t, pairingID), f.key, pairingID)

	session := f.connectHosted(t, f.enableHosted(t, pairingID))
	res := callHosted(t, session, "mcp_call", map[string]any{
		"operation_id": "portfolio.holdings",
		"params":       map[string]any{"as_of": "2026-07-30"},
	})

	if res.IsError {
		t.Fatalf("the call failed: %s", resultText(t, res))
	}
	text := resultText(t, res)
	for _, want := range []string{"mcp_call", "portfolio.holdings", "2026-07-30"} {
		if !strings.Contains(text, want) {
			t.Fatalf("the call did not reach the device and come back with %q: %s", want, text)
		}
	}
}

// THE ERROR THE OWNER ASKED FOR BY NAME, and the shape it has to arrive in.
//
// The pairing is live, so the shim leg dials fine; there is simply no device leg,
// which is §11's standing limitation and the steady state whenever nobody has a
// tab open. This must come back as a TOOL RESULT carrying ErrDeviceOffline's text
// — not as a protocol error (callHosted fails on that: the client would render it
// as a broken connector and the model would never read the sentence), and not as a
// hang.
func TestHostedEndpointAnswersNoUnlockedDeviceAsAToolResult(t *testing.T) {
	shortenCallTimeout(t, 500*time.Millisecond)
	f := newRelayFixture(t)
	session := f.connectHosted(t, f.enableHosted(t, f.mint(t)))

	res := callHosted(t, session, "mcp_help", nil)
	if !res.IsError {
		t.Fatal("the no-device case reported success, so the model has no signal that nothing answered")
	}
	text := resultText(t, res)
	// The actionable half: the user must learn to go and unlock a tab.
	for _, want := range []string{"No unlocked device is online to answer", "unlock"} {
		if !strings.Contains(text, want) {
			t.Fatalf("tool result = %q, want it to carry %q", text, want)
		}
	}
}

// After a restart the token resolves but the pairing is gone: the relay's pairing
// table is in-memory by design (§11) and has no restore seam, so a surviving
// connector dials a pairing the relay has forgotten. Revoking the pairing while
// leaving the connector enabled reproduces that state exactly.
//
// The bead expected this to land on the "no unlocked device" message. It must NOT:
// unlocking a tab cannot fix it, because that tab's own device leg is being closed
// with 4404 too. The honest, actionable answer is "re-pair from Settings", and the
// three failure modes stay distinguishable precisely so this one can say it.
func TestHostedEndpointTellsTheUserToRePairWhenTheRelayForgotThePairing(t *testing.T) {
	shortenCallTimeout(t, 500*time.Millisecond)
	f := newRelayFixture(t)
	session := f.connectHosted(t, f.enableHosted(t, f.mint(t)))
	f.api.pairings.revoke(f.account)

	res := callHosted(t, session, "mcp_help", nil)
	if !res.IsError {
		t.Fatal("a call against a forgotten pairing reported success")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "This pairing no longer exists") || !strings.Contains(text, "re-pair from Settings") {
		t.Fatalf("tool result = %q, want ErrPairingGone's re-pair instruction", text)
	}
	// A bare timeout, or the offline text, would send the user to unlock a tab
	// that cannot help.
	if strings.Contains(text, "No unlocked device is online") {
		t.Error("a forgotten pairing was reported as an offline device — the two need different user actions")
	}
}

// A connector revoked between the token check and the call must be refused. This
// is the race mcp_remote.go's entry.call exists for, made deterministic: the entry
// is revoked but still in the registry, exactly what a request that resolved its
// token a moment before the user hit disconnect is holding.
//
// If this endpoint routed through entry.client instead, the revocation would be
// invisible here — Client.Close leaves the client able to redial — and the call
// would go through, or time out into the offline message.
func TestHostedEndpointRefusesAConnectorRevokedMidFlight(t *testing.T) {
	shortenCallTimeout(t, 500*time.Millisecond)
	f := newRelayFixture(t)
	pairingID := f.mint(t)
	go respondOnDevice(t, f.dialDevice(t, pairingID), f.key, pairingID)
	token := f.enableHosted(t, pairingID)
	session := f.connectHosted(t, token)

	entry := f.api.mcpRemote.lookup(token)
	if entry == nil {
		t.Fatal("the freshly minted token does not resolve")
	}
	closeEntry(entry)

	res := callHosted(t, session, "mcp_help", nil)
	if !res.IsError {
		t.Fatal("a revoked connector answered the call")
	}
	if text := resultText(t, res); !strings.Contains(text, "disconnected or replaced") {
		t.Fatalf("tool result = %q, want the revoked-connector instruction", text)
	}
}

// Disabling the connector must stop the URL working immediately, and must do so
// with the same uniform rejection a token that never existed gets.
func TestHostedEndpointRefusesADisabledConnector(t *testing.T) {
	f := newRelayFixture(t)
	token := f.enableHosted(t, f.mint(t))
	if code := f.postHosted(t, token); code != http.StatusOK {
		t.Fatalf("POST /mcp/<token> while enabled = %d, want 200", code)
	}

	if err := f.api.mcpRemote.disable(t.Context(), f.account); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if code := f.postHosted(t, token); code != http.StatusNotFound {
		t.Fatalf("POST /mcp/<token> after disable = %d, want 404", code)
	}
}

// postHosted sends one initialize over the raw transport and returns the status.
// Raw rather than through the SDK client because the interesting answers here are
// HTTP-level rejections, which the client reports as an opaque connect failure.
func (f *relayFixture) postHosted(t *testing.T, token string, header ...[2]string) int {
	t.Helper()
	body := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"1"}}}`)
	req, err := http.NewRequest(http.MethodPost, f.srv.URL+"/mcp/"+token, body)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for _, h := range header {
		req.Header.Set(h[0], h[1])
	}
	resp, err := f.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /mcp/<token>: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

// A wrong token is refused uniformly and the rejection says nothing — not whether
// the token was the right length, not whether any account exists, and above all
// never the real token. Failed lookups are then throttled per client IP.
func TestHostedEndpointRefusesAndThrottlesWrongTokens(t *testing.T) {
	f := newRelayFixture(t)
	real := f.enableHosted(t, f.mint(t))

	// Same length as a live token, and one character off, so nothing about the
	// answer can depend on how close a guess was.
	near := "A" + real[1:]
	for _, bad := range []string{near, "nope", strings.Repeat("z", len(real))} {
		if code := f.postHosted(t, bad); code != http.StatusNotFound {
			t.Fatalf("POST /mcp/%s… = %d, want 404", bad[:4], code)
		}
	}

	// Burn the rest of this IP's failed-lookup budget; the next miss is a 429.
	var got int
	for i := 0; i < hostedFailMax+1; i++ {
		got = f.postHosted(t, "nope")
	}
	if got != http.StatusTooManyRequests {
		t.Fatalf("failed lookup %d from one IP = %d, want 429", hostedFailMax+1, got)
	}
	// The live token still works: the throttle is on failures, not on the account.
	if code := f.postHosted(t, real); code != http.StatusOK {
		t.Fatalf("POST /mcp/<real token> after throttling misses = %d, want 200", code)
	}
}

// Successful calls are throttled per token, so a retry-storming hosted client
// cannot hammer the relay-and-device round trip unbounded.
func TestHostedEndpointThrottlesCallsPerToken(t *testing.T) {
	f := newRelayFixture(t)
	token := f.enableHosted(t, f.mint(t))

	var got int
	for i := 0; i < hostedCallMax+1; i++ {
		got = f.postHosted(t, token)
	}
	if got != http.StatusTooManyRequests {
		t.Fatalf("request %d with a valid token = %d, want 429", hostedCallMax+1, got)
	}
}

// THE CONSENT TEXT LIVES IN THE TOOL DESCRIPTION and that placement is the whole
// point: the model reads it and relays it, unlike a settings screen nobody
// re-reads. §11 is explicit that Tier 2 gives up the blind-relay property and
// that this is "not a detail to bury".
func TestHostedToolDescriptionsCarryTheConsentText(t *testing.T) {
	f := newRelayFixture(t)
	session := f.connectHosted(t, f.enableHosted(t, f.mint(t)))

	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	res, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	if len(res.Tools) != 2 {
		t.Fatalf("advertised %d tools, want exactly mcp_help and mcp_call", len(res.Tools))
	}
	for _, tool := range res.Tools {
		for _, want := range []string{
			// The disclosure itself: the server is in the middle and sees the
			// traffic in plaintext.
			"sees these MCP requests and responses in plaintext",
			// The actionable half: Tier 1 is the tier that keeps the key off the
			// server, and the user is told it exists.
			"mcpshim",
			// The product limitation §11 says belongs in user-facing copy.
			"unlocked myportfolio browser tab",
		} {
			if !strings.Contains(tool.Description, want) {
				t.Errorf("%s description is missing the consent text %q: %q", tool.Name, want, tool.Description)
			}
		}
		// Tier 1's claim is false for this tier, and §11 forbids describing it
		// as zero knowledge. A copy-paste of the shim's suffix must fail here.
		for _, forbidden := range []string{"never to a server", "zero knowledge", "zero-knowledge"} {
			if strings.Contains(strings.ToLower(tool.Description), forbidden) {
				t.Errorf("%s description claims %q, which is untrue for the hosted tier", tool.Name, forbidden)
			}
		}
	}
}

// The token is a capability. It must not reach a log line — not on the call path,
// not on the rejection path, and not through the limiter that keys on it.
func TestHostedEndpointNeverLogsTheToken(t *testing.T) {
	shortenCallTimeout(t, 500*time.Millisecond)
	f := newRelayFixture(t)
	token := f.enableHosted(t, f.mint(t))

	buf := captureLog(t)
	session := f.connectHosted(t, token)
	callHosted(t, session, "mcp_help", nil)
	f.postHosted(t, "wrong-token-entirely")

	if strings.Contains(buf.String(), token) {
		t.Fatalf("the connector token reached the log: %s", buf.String())
	}
}

// A 404 body must not carry the token back either — an echo would put it in the
// caller's logs and in any proxy in between.
func TestHostedEndpointDoesNotEchoTheToken(t *testing.T) {
	f := newRelayFixture(t)
	resp, err := f.srv.Client().Get(f.srv.URL + "/mcp/some-guessed-token")
	if err != nil {
		t.Fatalf("GET /mcp/<token>: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 512)
	n, _ := resp.Body.Read(buf)
	if strings.Contains(string(buf[:n]), "some-guessed-token") {
		t.Fatalf("the rejection echoed the token: %q", buf[:n])
	}
}

// THE SSRF GUARD. enable dials pc.RelayURL, so a pairing code the account holder
// submitted must be bound to the request's own host first — otherwise an
// authenticated user aims this server's dial at any host or port it can reach and
// triggers it by hitting their own connector URL.
func TestRelayURLIsSelf(t *testing.T) {
	const reqHost = "portfolio.example"
	for _, tc := range []struct {
		name, relayURL, host, listenPort string
		want                             bool
	}{
		{name: "the shape Settings mints", relayURL: "wss://portfolio.example/api/mcp/relay", host: reqHost, want: true},
		{name: "plain ws for local dev", relayURL: "ws://portfolio.example/api/mcp/relay", host: reqHost, want: true},
		{name: "explicit standard port", relayURL: "wss://portfolio.example:443/api/mcp/relay", host: reqHost, want: true},
		{name: "trailing slash", relayURL: "wss://portfolio.example/api/mcp/relay/", host: reqHost, want: true},
		{name: "the request's own port survives a port-suffixed Host", relayURL: "ws://portfolio.example:8080/api/mcp/relay", host: reqHost + ":8080", listenPort: "8080", want: true},

		{name: "another host entirely", relayURL: "wss://evil.example/api/mcp/relay", host: reqHost},
		{name: "link-local metadata service", relayURL: "ws://169.254.169.254/api/mcp/relay", host: reqHost},
		{name: "loopback when the request is not", relayURL: "ws://127.0.0.1/api/mcp/relay", host: reqHost},
		// The port is what makes an internal port scan possible: every
		// "<host>:<port>" resolves to this same server, so a port taken from the
		// caller's URL would let it dial any service on this machine.
		{name: "our host but an internal port", relayURL: "ws://portfolio.example:6379/api/mcp/relay", host: reqHost},
		{name: "our host but an internal port claimed as the listener", relayURL: "ws://portfolio.example:6379/api/mcp/relay", host: reqHost, listenPort: "8080"},
		{name: "not a websocket scheme", relayURL: "https://portfolio.example/api/mcp/relay", host: reqHost},
		{name: "file scheme", relayURL: "file:///etc/passwd", host: reqHost},
		// The sibling's relay_url is a bare origin; ours carries the endpoint.
		// Accepting a bare origin would 404 every dial (§11).
		{name: "bare origin, the sibling's shape", relayURL: "wss://portfolio.example", host: reqHost},
		{name: "some other path on our host", relayURL: "wss://portfolio.example/api/state", host: reqHost},
		{name: "the endpoint with something appended", relayURL: "wss://portfolio.example/api/mcp/relay/../../admin", host: reqHost},
		{name: "credentials riding along", relayURL: "wss://user:pass@portfolio.example/api/mcp/relay", host: reqHost},
		{name: "a query riding along", relayURL: "wss://portfolio.example/api/mcp/relay?pairing=x", host: reqHost},
		{name: "unparseable", relayURL: "://", host: reqHost},
		{name: "empty", relayURL: "", host: reqHost},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := relayURLIsSelf(tc.relayURL, tc.host, tc.listenPort); got != tc.want {
				t.Errorf("relayURLIsSelf(%q, %q, %q) = %v, want %v", tc.relayURL, tc.host, tc.listenPort, got, tc.want)
			}
		})
	}
}

// And the guard is on enable itself, not on a caller that has to remember it: a
// foreign relay_url must be refused before anything is dialed, persisted, or
// installed.
func TestEnableRefusesAForeignRelayURL(t *testing.T) {
	f := newRemoteFixture(t)
	foreign := &mcpshim.PairingCode{RelayURL: "ws://169.254.169.254/api/mcp/relay", PairingID: "p", Key: f.key}

	if _, err := f.registry.enable(t.Context(), f.account, foreign, selfRequest()); err == nil {
		t.Fatal("enable accepted a pairing code aimed at another host — that is an SSRF")
	}
	if _, ok := f.row(t); ok {
		t.Error("the rejected enable persisted a row anyway")
	}
	if _, ok := f.registry.tokenFor(f.account); ok {
		t.Error("the rejected enable installed a live entry anyway")
	}
}

// The route is the only one here that answers without a session cookie, so make
// that deliberate rather than incidental: it is reachable unauthenticated, and
// nothing else new is.
func TestHostedEndpointIsTheOnlyCookielessRoute(t *testing.T) {
	f := newRelayFixture(t)
	token := f.enableHosted(t, f.mint(t))

	// No cookie jar at all on this client.
	if code := f.postHosted(t, token); code != http.StatusOK {
		t.Fatalf("POST /mcp/<token> without a session = %d, want 200", code)
	}
	// A neighbouring path must not become a second cookieless surface.
	resp, err := f.srv.Client().Get(f.srv.URL + "/api/state")
	if err != nil {
		t.Fatalf("GET /api/state: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /api/state without a session = %d, want 401", resp.StatusCode)
	}
}
