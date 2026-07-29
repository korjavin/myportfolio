package mcpshim

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
)

// The relay (bd myportfolio-ybp.2) does not exist yet, so everything below
// runs against fakeRelay: a real websocket server on a real listener that
// stands in for the relay AND the paired browser at once. It covers dial,
// seal, correlate, reconnect and error surfacing over the actual transport.
// What it cannot cover is the relay's own behaviour — the 64 KiB cap being
// enforced server-side, and the 4404/4409 close codes — which stays
// unverified until C2 lands.

// fakeRelay accepts the shim leg, opens each frame with the pairing key, and
// answers. A real relay never holds the key; this one does only because it is
// also standing in for the browser at the far end.
type fakeRelay struct {
	*httptest.Server

	mu        sync.Mutex
	conns     int
	lastQuery string

	// respond turns one decoded request into the responses to write back, in
	// order. Returning nothing sends nothing, which is how "no device is
	// listening" and "answer out of order" are both simulated.
	respond func(req *jsonrpc.Request) []*jsonrpc.Response
	// onConn, when set, runs on connection n (1-based) before the read loop.
	// Returning true ends the connection instead of serving it.
	onConn func(n int, c *websocket.Conn) bool
}

func newFakeRelay(t *testing.T, key []byte, pairingID string) *fakeRelay {
	t.Helper()
	r := &fakeRelay{}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Served at the real path, and the pairing codes below carry the real
		// relay_url shape (origin + relayEndpoint), so a shim that builds the
		// wrong URL 404s here instead of passing against a convenient fake.
		if req.URL.Path != relayEndpoint+"/shim" {
			http.NotFound(w, req)
			return
		}
		c, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(maxFrameBytes)

		r.mu.Lock()
		r.conns++
		n := r.conns
		r.lastQuery = req.URL.RawQuery
		onConn, respond := r.onConn, r.respond
		r.mu.Unlock()

		if onConn != nil && onConn(n, c) {
			return
		}
		ctx := req.Context()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			payload, err := OpenFrame(key, pairingID, data)
			if err != nil {
				return
			}
			msg, err := jsonrpc.DecodeMessage(payload)
			if err != nil {
				return
			}
			rpcReq, ok := msg.(*jsonrpc.Request)
			if !ok {
				continue
			}
			for _, resp := range respond(rpcReq) {
				out, err := jsonrpc.EncodeMessage(resp)
				if err != nil {
					return
				}
				frame, err := SealFrame(key, pairingID, out)
				if err != nil {
					return
				}
				if err := c.Write(ctx, websocket.MessageBinary, frame); err != nil {
					return
				}
			}
		}
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *fakeRelay) connCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.conns
}

func (r *fakeRelay) query() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastQuery
}

func (r *fakeRelay) set(fn func(*fakeRelay)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fn(r)
}

// echo answers with {"method":…,"params":…} so a test can prove the payload
// survived the round trip intact.
func echo(t *testing.T, req *jsonrpc.Request) *jsonrpc.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"method": req.Method, "params": json.RawMessage(req.Params)})
	if err != nil {
		t.Errorf("marshal echo: %v", err)
		return nil
	}
	return &jsonrpc.Response{ID: req.ID, Result: body}
}

// relayEndpoint is the path a pairing code's relay_url ends in — see the
// pinned vector, "wss://portfolio.example/api/mcp/relay".
const relayEndpoint = "/api/mcp/relay"

func newTestClient(t *testing.T) (*Client, *fakeRelay, *PairingCode) {
	t.Helper()
	pc := &PairingCode{
		PairingID: "pairing-under-test",
		Key:       bytes.Repeat([]byte{0x2a}, PairingKeyBytes),
	}
	relay := newFakeRelay(t, pc.Key, pc.PairingID)
	relay.respond = func(req *jsonrpc.Request) []*jsonrpc.Response {
		return []*jsonrpc.Response{echo(t, req)}
	}
	pc.RelayURL = wsURL(relay.URL)
	c := NewClientFromPairing(pc, nil)
	t.Cleanup(func() { _ = c.Close() })
	return c, relay, pc
}

// wsURL turns an httptest origin into a relay_url of the shape Settings mints:
// the relay ENDPOINT, not the bare origin.
func wsURL(httpURL string) string {
	return strings.Replace(httpURL, "http://", "ws://", 1) + relayEndpoint
}

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

// keyForms is every encoding the pairing key could plausibly be leaked in.
func keyForms(key []byte) []string {
	return []string{
		hex.EncodeToString(key),
		base64.StdEncoding.EncodeToString(key),
		base64.RawURLEncoding.EncodeToString(key),
		string(key),
	}
}

func TestClientCallRoundTrip(t *testing.T) {
	c, relay, pc := newTestClient(t)

	raw, err := c.Call(t.Context(), "mcp_help", HelpInput{Topic: "performance"})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	var got struct {
		Method string    `json:"method"`
		Params HelpInput `json:"params"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if got.Method != "mcp_help" || got.Params.Topic != "performance" {
		t.Fatalf("round trip lost the request: %+v", got)
	}
	// The shim leg is authenticated by possession of the pairing id, so the
	// relay sees that. The key is not in the URL and must never be.
	if q := relay.query(); q != "pairing="+pc.PairingID {
		t.Fatalf("dial query = %q, want pairing=%s", q, pc.PairingID)
	}
	for _, form := range keyForms(pc.Key) {
		if strings.Contains(relay.query(), form) {
			t.Fatalf("dial URL leaks the pairing key: %q", relay.query())
		}
	}
}

// TestShimLegURLMatchesThePinnedRelayURL binds the dialed URL to the pairing
// code the BROWSER mints, taken from the vector both suites read — not to a
// convenient origin invented by this test.
//
// This is the bug the pin exists for: relay_url is the relay endpoint here,
// while medicationtrackerbot's is a bare origin. Porting its dial line
// verbatim appends the whole path a second time, so every real pairing 404s
// while every self-minted test code passes.
func TestShimLegURLMatchesThePinnedRelayURL(t *testing.T) {
	v, _ := loadVectors(t)
	pc, err := ParsePairingCode(v.PairingCode)
	if err != nil {
		t.Fatalf("parse pinned pairing code: %v", err)
	}
	if pc.RelayURL != v.RelayURL {
		t.Fatalf("pinned code's relay_url = %q, want %q", pc.RelayURL, v.RelayURL)
	}
	want := v.RelayURL + "/shim?pairing=" + pc.PairingID
	if got := shimLegURL(pc); got != want {
		t.Fatalf("shim leg URL = %q, want %q", got, want)
	}
	if strings.Count(shimLegURL(pc), "/api/mcp/relay") != 1 {
		t.Fatalf("shim leg URL repeats the relay path: %q", shimLegURL(pc))
	}
}

// TestShimLegURLEscapesThePairingID: the browser chose the id, not the shim.
// An id carrying "&" or "/" must not be able to rewrite the URL.
func TestShimLegURLEscapesThePairingID(t *testing.T) {
	got := shimLegURL(&PairingCode{RelayURL: "wss://r.example/api/mcp/relay", PairingID: "a/b&role=device"})
	want := "wss://r.example/api/mcp/relay/shim?pairing=a%2Fb%26role%3Ddevice"
	if got != want {
		t.Fatalf("shim leg URL = %q, want %q", got, want)
	}
}

// TestResponderErrorsAreNotProtocolErrors: an "unknown operation_id" from the
// browser is an ordinary tool failure the model must READ and correct, not a
// transport fault. The SDK re-emits a *jsonrpc.Error as a protocol error on
// the outer stdio connection, where the model never sees the text — so Call
// must flatten it first. §11's mcp_execute refusal travels this same path,
// and it only stops an agent retrying forever if the agent can read it.
func TestResponderErrorsAreNotProtocolErrors(t *testing.T) {
	c, relay, _ := newTestClient(t)
	relay.set(func(r *fakeRelay) {
		r.respond = func(req *jsonrpc.Request) []*jsonrpc.Response {
			return []*jsonrpc.Response{{
				ID:    req.ID,
				Error: &jsonrpc.Error{Code: -32602, Message: "unknown operation_id \"portfolio.nope\""},
			}}
		}
	})

	_, err := c.Call(t.Context(), "mcp_call", CallInput{OperationID: "portfolio.nope"})
	if err == nil {
		t.Fatal("expected the responder's error")
	}
	var wireErr *jsonrpc.Error
	if errors.As(err, &wireErr) {
		t.Fatalf("responder error surfaced as *jsonrpc.Error, which the SDK turns into a protocol error: %v", err)
	}
	if !strings.Contains(err.Error(), "unknown operation_id") {
		t.Fatalf("responder's message did not survive: %v", err)
	}
}

// TestCallsCorrelateByID: the relay answers two in-flight requests in reverse
// order. Without the pending table keyed on the JSON-RPC id, each caller gets
// the other's answer — and with only one call in flight every implementation
// looks correct.
func TestCallsCorrelateByID(t *testing.T) {
	c, relay, _ := newTestClient(t)
	var (
		held    *jsonrpc.Response
		arrived = make(chan struct{})
	)
	relay.set(func(r *fakeRelay) {
		r.respond = func(req *jsonrpc.Request) []*jsonrpc.Response {
			// Serialized by the relay's single read loop, so no lock needed.
			if held == nil {
				held = echo(t, req)
				close(arrived)
				return nil // hold the first answer back
			}
			// Answer the second request first, then release the first.
			return []*jsonrpc.Response{echo(t, req), held}
		}
	})

	firstDone := make(chan json.RawMessage, 1)
	firstErr := make(chan error, 1)
	go func() {
		raw, err := c.Call(t.Context(), "mcp_call", CallInput{OperationID: "first"})
		firstErr <- err
		firstDone <- raw
	}()

	// Wait until the first request has reached the relay and been held, so the
	// two are genuinely in flight together.
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("first request never reached the relay")
	}

	second, err := c.Call(t.Context(), "mcp_call", CallInput{OperationID: "second"})
	if err != nil {
		t.Fatalf("second Call: %v", err)
	}
	if !bytes.Contains(second, []byte(`"second"`)) {
		t.Fatalf("second call got the wrong answer: %s", second)
	}
	if err := <-firstErr; err != nil {
		t.Fatalf("first Call: %v", err)
	}
	if first := <-firstDone; !bytes.Contains(first, []byte(`"first"`)) {
		t.Fatalf("first call got the wrong answer: %s", first)
	}
}

// TestClientReconnectsAfterDrop is the "dropped connection reconnects"
// acceptance criterion: the relay hangs up mid-session, which is what it does
// when the paired device leg drops. The next call must dial a fresh leg and
// succeed rather than fail with a transport error.
func TestClientReconnectsAfterDrop(t *testing.T) {
	c, relay, _ := newTestClient(t)
	relay.set(func(r *fakeRelay) {
		r.onConn = func(n int, conn *websocket.Conn) bool {
			if n == 1 {
				conn.Close(websocket.StatusGoingAway, "device leg dropped")
				return true
			}
			return false
		}
	})

	core, err := c.connected(t.Context())
	if err != nil {
		t.Fatalf("initial connect: %v", err)
	}
	// Wait for the drop to be observed so this exercises connected()'s redial
	// deterministically instead of racing the write path.
	deadline := time.Now().Add(5 * time.Second)
	for !core.isClosed() {
		if time.Now().After(deadline) {
			t.Fatal("readLoop never noticed the relay hang up")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// A Call on the dead core must surface errConnectionDropped — the sentinel
	// Client.Call matches to redial and retry once.
	if _, err := core.Call(t.Context(), "mcp_help", HelpInput{}); !errors.Is(err, errConnectionDropped) {
		t.Fatalf("dead core Call error = %v, want errConnectionDropped", err)
	}

	if _, err := c.Call(t.Context(), "mcp_help", HelpInput{}); err != nil {
		t.Fatalf("Call after drop: %v", err)
	}
	if n := relay.connCount(); n != 2 {
		t.Fatalf("relay saw %d connections, want 2 (one dropped, one redialed)", n)
	}
}

// TestReconnectIsBoundedAndReportsTheCause is the landmine: an unbounded
// silent retry loop is how "the connector looks alive and every call times
// out" ships. Reconnection must give up quickly and hand back the real cause.
func TestReconnectIsBoundedAndReportsTheCause(t *testing.T) {
	pc := &PairingCode{PairingID: "p", Key: bytes.Repeat([]byte{7}, PairingKeyBytes)}
	relay := newFakeRelay(t, pc.Key, pc.PairingID)
	pc.RelayURL = wsURL(relay.URL)
	relay.Close() // nothing is listening now

	c := NewClientFromPairing(pc, nil)
	start := time.Now()
	_, err := c.Call(t.Context(), "mcp_help", HelpInput{})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("Call against a dead relay returned no error")
	}
	if !strings.Contains(err.Error(), "gave up reconnecting after 3 attempts") {
		t.Fatalf("error does not report giving up: %v", err)
	}
	if !strings.Contains(err.Error(), "dial relay") {
		t.Fatalf("error does not carry the underlying dial cause: %v", err)
	}
	// Must land far inside CallTimeout so an unreachable relay is
	// distinguishable from a reachable relay with no device behind it.
	if elapsed >= CallTimeout {
		t.Fatalf("reconnect took %v, want well under CallTimeout %v", elapsed, CallTimeout)
	}
}

// TestNoDeviceAnsweringYieldsActionableError: the relay is up, the frame goes
// through, nothing answers. That is the design's standing limitation and it
// must read as such rather than as a hang.
func TestNoDeviceAnsweringYieldsActionableError(t *testing.T) {
	old := CallTimeout
	CallTimeout = 150 * time.Millisecond
	t.Cleanup(func() { CallTimeout = old })

	c, relay, _ := newTestClient(t)
	relay.set(func(r *fakeRelay) {
		r.respond = func(*jsonrpc.Request) []*jsonrpc.Response { return nil }
	})

	_, err := c.Call(t.Context(), "mcp_help", HelpInput{})
	if !errors.Is(err, ErrDeviceOffline) {
		t.Fatalf("Call error = %v, want ErrDeviceOffline", err)
	}
	if !strings.Contains(err.Error(), "unlock") {
		t.Fatalf("offline error is not actionable: %v", err)
	}
}

// TestUnopenableFramesAreDropped: the relay is untrusted, so a frame it
// injects that will not open under our key and our pairing id must be ignored
// — not crash the read loop, and not resolve a pending call.
func TestUnopenableFramesAreDropped(t *testing.T) {
	c, relay, pc := newTestClient(t)
	relay.set(func(r *fakeRelay) {
		r.onConn = func(_ int, conn *websocket.Conn) bool {
			ctx := context.Background()
			_ = conn.Write(ctx, websocket.MessageBinary, []byte("not a frame at all"))
			// A well-formed frame sealed for a DIFFERENT pairing must not open
			// either — that binding is what stops a cross-pairing replay.
			other, err := SealFrame(pc.Key, "some-other-pairing", []byte(`{"jsonrpc":"2.0","id":1,"result":{"injected":true}}`))
			if err != nil {
				t.Errorf("seal other-pairing frame: %v", err)
				return true
			}
			_ = conn.Write(ctx, websocket.MessageBinary, other)
			return false // fall through to the normal read loop
		}
	})

	raw, err := c.Call(t.Context(), "mcp_help", HelpInput{Query: "dividends"})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if bytes.Contains(raw, []byte("injected")) {
		t.Fatalf("an unopenable frame resolved the call: %s", raw)
	}
	if !bytes.Contains(raw, []byte("dividends")) {
		t.Fatalf("did not get the real answer: %s", raw)
	}
}

// TestFramePayloadCeiling pins the read limit against frame.go's overhead
// constant. C2, C3 and C4 each deriving this independently is how one ends up
// 28 bytes off and drops exactly the largest answers, which reads as "big
// queries hang".
func TestFramePayloadCeiling(t *testing.T) {
	if maxFrameBytes != 65536 {
		t.Fatalf("maxFrameBytes = %d, want 65536 (the relay's 64 KiB cap)", maxFrameBytes)
	}
	if got := maxFrameBytes - FrameOverheadBytes; got != 65508 {
		t.Fatalf("largest usable payload = %d, want 65508", got)
	}
}

// TestLargePayloadRoundTrips: a response just under the cap must survive.
// coder/websocket's default read limit is 32 KiB, so without SetReadLimit this
// fails — and it would have failed as a spurious "device offline", not as a
// size error.
func TestLargePayloadRoundTrips(t *testing.T) {
	c, relay, _ := newTestClient(t)
	// A JSON string result whose sealed frame lands just under the cap.
	big := strings.Repeat("x", 60000)
	relay.set(func(r *fakeRelay) {
		r.respond = func(req *jsonrpc.Request) []*jsonrpc.Response {
			body, err := json.Marshal(big)
			if err != nil {
				t.Errorf("marshal big: %v", err)
				return nil
			}
			return []*jsonrpc.Response{{ID: req.ID, Result: body}}
		}
	})
	raw, err := c.Call(t.Context(), "mcp_help", HelpInput{})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	var got string
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != len(big) {
		t.Fatalf("payload truncated: got %d bytes, want %d", len(got), len(big))
	}
}

// TestPairingKeyNeverAppearsInErrors: the key is the one secret this binary
// holds. It goes into SealFrame/OpenFrame and nowhere else — not a URL, not an
// error string.
func TestPairingKeyNeverAppearsInErrors(t *testing.T) {
	pc := &PairingCode{
		RelayURL:  "ws://127.0.0.1:1", // connection refused
		PairingID: "p",
		Key:       bytes.Repeat([]byte{0x5c}, PairingKeyBytes),
	}
	c := NewClientFromPairing(pc, nil)
	_, err := c.Call(t.Context(), "mcp_help", HelpInput{})
	if err == nil {
		t.Fatal("expected a dial error")
	}
	for _, form := range keyForms(pc.Key) {
		if strings.Contains(err.Error(), form) {
			t.Fatalf("error leaks the pairing key: %v", err)
		}
	}
}

// codeFor (mcpshim_test.go) builds a well-formed code — correct checksum
// group — around an arbitrary JSON body, so a test can reach the rejection
// paths that live PAST the checksum.

// TestInvalidPairingCodeIsActionable: a bad code must name its defect at
// startup, not surface later as an unexplained timeout. NewClient is the only
// gate — cmd/mcpshim exits on its error before the MCP server ever starts.
func TestInvalidPairingCodeIsActionable(t *testing.T) {
	for name, tc := range map[string]struct{ code, want string }{
		"empty":         {"", `missing "mpmcp1." prefix`},
		"wrong app":     {"mtmcp1.abcd.efgh", `missing "mpmcp1." prefix`},
		"no checksum":   {"mpmcp1." + b64(`{"relay_url":"wss://r"}`), "missing its checksum group"},
		"bad base64":    {"mpmcp1.!!!!.abcd", "decode pairing code"},
		"bad checksum":  {"mpmcp1." + b64(`{"relay_url":"wss://r"}`) + ".zzzz", "checksum mismatch"},
		"not json":      {codeFor("hello"), "unmarshal pairing code"},
		"short key":     {codeFor(`{"relay_url":"wss://r","pairing_id":"p","key":"AAAA"}`), "pairing key is 3 bytes"},
		"no relay url":  {codeFor(`{"pairing_id":"p","key":"AAAA"}`), "missing relay_url or pairing_id"},
		"no pairing id": {codeFor(`{"relay_url":"wss://r","key":"AAAA"}`), "missing relay_url or pairing_id"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewClient(tc.code)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

// TestMistypedCodeIsNotConfusableWithOffline is the whole point of the
// checksum, asserted from the shim's side. A single mistyped character used to
// have a real chance of parsing into a WRONG key, and a wrong key seals frames
// the browser cannot open — which arrives as a timeout and reads as
// ErrDeviceOffline, the design's own documented limitation. The two causes
// must now be told apart: the typo cannot reach a running shim at all, and
// each message rules the other out in words.
func TestMistypedCodeIsNotConfusableWithOffline(t *testing.T) {
	good, err := FormatPairingCode(&PairingCode{
		RelayURL:  "wss://relay.example",
		PairingID: "pairing-under-test",
		Key:       bytes.Repeat([]byte{0x2a}, PairingKeyBytes),
	})
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if _, err := NewClient(good); err != nil {
		t.Fatalf("a freshly minted code must parse: %v", err)
	}

	// Every single-character substitution in the body must be rejected, not
	// turned into a different-but-plausible key.
	body := strings.TrimPrefix(good, PairingCodePrefix)
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	substitutions, accepted := 0, 0
	for i := range body {
		if body[i] == '.' {
			continue
		}
		for _, c := range alphabet {
			if byte(c) == body[i] {
				continue
			}
			mutated := PairingCodePrefix + body[:i] + string(c) + body[i+1:]
			substitutions++
			if _, err := NewClient(mutated); err == nil {
				accepted++
			}
		}
	}
	if substitutions == 0 {
		t.Fatal("generated no substitutions")
	}
	if accepted != 0 {
		t.Fatalf("%d of %d single-character typos parsed cleanly — each one becomes an unattributable 'no device online'", accepted, substitutions)
	}

	// And the two user-facing messages must each rule the other out, so
	// neither is read as the other when one does occur.
	_, parseErr := NewClient(PairingCodePrefix + body[:len(body)-1] + "A")
	if parseErr == nil {
		t.Fatal("expected a parse error")
	}
	if !strings.Contains(parseErr.Error(), "mistyped") {
		t.Fatalf("parse error does not say the code was mistyped: %v", parseErr)
	}
	if !strings.Contains(ErrDeviceOffline.Error(), "not a typo") {
		t.Fatalf("offline error does not rule out a typo: %v", ErrDeviceOffline)
	}
}
