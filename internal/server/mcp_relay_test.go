package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"

	"github.com/korjavin/myportfolio/internal/mcpshim"
)

// relayEndpoint is the path a pairing code's relay_url ends in — the relay
// ENDPOINT, not an origin. Each leg appends only its own segment.
const relayEndpoint = "/api/mcp/relay"

// relayFixture is a signed-up account, a real listener (WebSockets need one),
// and the pairing key. The key is generated HERE and never sent anywhere: the
// browser mints it client-side, so every test that opens a frame is using
// material the server provably never had.
type relayFixture struct {
	*vault
	srv     *httptest.Server
	session *http.Cookie
	account string
	key     []byte
}

// testWait is the deadline for every "did the thing happen" wait in this
// package's relay tests. It is deliberately generous.
//
// Nothing here measures how FAST anything happens — only that a frame arrives,
// or a leg closes, and with the right code. These tests bind real websockets and
// run on shared CI runners with unpredictable neighbours, so tight deadlines
// bought nothing and lost: master went red on a beads-only commit and on a
// docs-only commit, neither of which touches Go. An intermittently-red CI is
// worse than a slow one, because people learn to re-run it without reading it.
//
// If a test ever needs to assert a latency BOUND, it should say so with its own
// named deadline rather than tightening this one.
const testWait = 60 * time.Second

func newRelayFixture(t *testing.T) *relayFixture {
	t.Helper()
	v := newVault(t)
	account, session, _ := v.signup()
	srv := httptest.NewServer(v.h)
	t.Cleanup(srv.Close)

	key := make([]byte, mcpshim.PairingKeyBytes)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate pairing key: %v", err)
	}
	return &relayFixture{vault: v, srv: srv, session: session, account: account, key: key}
}

// relayURL is the relay_url Settings will mint: origin + the relay endpoint.
func (f *relayFixture) relayURL() string {
	return strings.Replace(f.srv.URL, "http://", "ws://", 1) + relayEndpoint
}

func (f *relayFixture) mint(t *testing.T) string {
	t.Helper()
	rec := f.do(http.MethodPost, "/api/mcp/pairings", nil, f.session)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/mcp/pairings = %d, body %q", rec.Code, rec.Body.String())
	}
	var out createPairingResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode mint response: %v", err)
	}
	if out.PairingID == "" {
		t.Fatal("mint returned an empty pairing id")
	}
	return out.PairingID
}

// dial opens one leg. It returns the error rather than failing, because several
// tests are about what a rejected dial looks like.
func (f *relayFixture) dial(t *testing.T, urlStr string, cookie *http.Cookie) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	opts := &websocket.DialOptions{}
	if cookie != nil {
		opts.HTTPHeader = http.Header{"Cookie": {cookie.Name + "=" + cookie.Value}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, urlStr, opts)
	if conn != nil {
		// The test side has to raise its own limit too: coder/websocket
		// defaults to 32 KiB, half of what the relay passes through.
		conn.SetReadLimit(maxRelayFrameBytes)
		t.Cleanup(func() { conn.CloseNow() })
	}
	return conn, resp, err
}

func (f *relayFixture) dialDevice(t *testing.T, pairingID string) *websocket.Conn {
	t.Helper()
	conn, _, err := f.dial(t, f.relayURL()+"/device?pairing="+url.QueryEscape(pairingID), f.session)
	if err != nil {
		t.Fatalf("dial device leg: %v", err)
	}
	return conn
}

func (f *relayFixture) dialShim(t *testing.T, pairingID string) *websocket.Conn {
	t.Helper()
	conn, _, err := f.dial(t, f.relayURL()+"/shim?pairing="+url.QueryEscape(pairingID), nil)
	if err != nil {
		t.Fatalf("dial shim leg: %v", err)
	}
	return conn
}

// bridged mints a pairing and connects both legs.
func (f *relayFixture) bridged(t *testing.T) (pairingID string, shim, device *websocket.Conn) {
	t.Helper()
	pairingID = f.mint(t)
	device = f.dialDevice(t, pairingID)
	shim = f.dialShim(t, pairingID)
	return pairingID, shim, device
}

func writeFrame(t *testing.T, conn *websocket.Conn, frame []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func readFrame(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("relayed message type = %v, want binary", typ)
	}
	return data
}

// expectClose reads until the connection closes and asserts the status code.
// Every rejection on the device leg is an accept-then-close, because a browser
// WebSocket cannot see a handshake status — so the code IS the error channel.
func expectClose(t *testing.T, conn *websocket.Conn, want websocket.StatusCode, what string) {
	t.Helper()
	// A liveness assertion, not a latency one: nothing here measures how FAST
	// the close arrives, only that it does and carries the right code. 5s lost
	// under concurrent load on a busy machine (~1 run in 3), and an
	// intermittently-red CI is worse than a slow one — people learn to re-run it
	// without reading it. CI runs on shared runners with unpredictable
	// neighbours, so the deadline is generous rather than tight.
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	_, _, err := conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != want {
		t.Fatalf("%s: close status %d, want %d (err: %v)", what, got, want, err)
	}
}

// TestRelayPipesFramesByteIdenticallyBothWays is the relay's whole job: opaque
// bytes in, the same opaque bytes out, in both directions.
func TestRelayPipesFramesByteIdenticallyBothWays(t *testing.T) {
	f := newRelayFixture(t)
	pairingID, shim, device := f.bridged(t)

	for _, tc := range []struct {
		name         string
		from, to     *websocket.Conn
		payload      string
		fromIsDevice bool
	}{
		{"shim to device", shim, device, `{"jsonrpc":"2.0","id":1,"method":"mcp_call"}`, false},
		{"device to shim", device, shim, `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frame, err := mcpshim.SealFrame(f.key, pairingID, []byte(tc.payload))
			if err != nil {
				t.Fatalf("seal: %v", err)
			}
			writeFrame(t, tc.from, frame)
			got := readFrame(t, tc.to)
			if !bytes.Equal(got, frame) {
				t.Fatalf("relayed frame differs: got %d bytes, sent %d", len(got), len(frame))
			}
			// And it is still a real frame at the far end, not just equal bytes.
			payload, err := mcpshim.OpenFrame(f.key, pairingID, got)
			if err != nil {
				t.Fatalf("open relayed frame: %v", err)
			}
			if string(payload) != tc.payload {
				t.Fatalf("payload = %q, want %q", payload, tc.payload)
			}
		})
	}
}

// TestRelayCarriesAFrameItCannotOpen is the property the whole design rests on.
// The relay is handed a frame, forwards it, and cannot read a byte of it: the
// key was generated in this test and never transmitted, and none of the material
// the server DOES hold opens the frame.
func TestRelayCarriesAFrameItCannotOpen(t *testing.T) {
	f := newRelayFixture(t)
	pairingID, shim, device := f.bridged(t)

	secret := `{"jsonrpc":"2.0","id":1,"params":{"holdings":"AAPL 12 shares"}}`
	frame, err := mcpshim.SealFrame(f.key, pairingID, []byte(secret))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	writeFrame(t, shim, frame)
	relayed := readFrame(t, device)

	// The plaintext never crosses the wire, and neither does the key.
	if bytes.Contains(relayed, []byte("AAPL")) {
		t.Fatal("the relayed frame carries plaintext")
	}
	if bytes.Contains(relayed, f.key) {
		t.Fatal("the relayed frame carries the pairing key")
	}

	// Everything the server has ever seen about this pairing, in the shapes a
	// key could plausibly be derived into. None of it opens the frame.
	for name, candidate := range map[string][]byte{
		"pairing id":        sha256Of(pairingID),
		"account id":        sha256Of(f.account),
		"session secret":    sha256Of(testSessionSecret),
		"session token":     sha256Of(f.session.Value),
		"pairing id padded": padTo32([]byte(pairingID)),
		"zeroes":            make([]byte, mcpshim.PairingKeyBytes),
	} {
		if _, err := mcpshim.OpenFrame(candidate, pairingID, relayed); err == nil {
			t.Fatalf("the frame opened under a key derived from the %s — the relay is not blind", name)
		}
	}

	// Positive control: it opens only under the key that never left this test.
	if _, err := mcpshim.OpenFrame(f.key, pairingID, relayed); err != nil {
		t.Fatalf("the frame does not open under the real pairing key either: %v", err)
	}
}

func sha256Of(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

func padTo32(b []byte) []byte {
	out := make([]byte, mcpshim.PairingKeyBytes)
	copy(out, b)
	return out
}

// TestMintResponseCarriesOnlyThePairingID: the pairing key is generated in the
// browser and folded into the one-time code. If it ever reached this endpoint —
// or came back from it — the relay would stop being blind.
func TestMintResponseCarriesOnlyThePairingID(t *testing.T) {
	f := newRelayFixture(t)
	rec := f.do(http.MethodPost, "/api/mcp/pairings", nil, f.session)

	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode mint response: %v", err)
	}
	if len(out) != 1 || out["pairing_id"] == "" {
		t.Fatalf("mint response = %v, want exactly {pairing_id}", out)
	}
	for _, form := range []string{hex.EncodeToString(f.key), string(f.key)} {
		if strings.Contains(rec.Body.String(), form) {
			t.Fatal("the mint response carries the pairing key")
		}
	}
}

// TestRelayFrameCapMatchesTheShimContract pins the cap arithmetic against
// mcpshim's exported constant rather than restating it. The cap is on the FRAME,
// so the usable payload is 28 bytes smaller — re-deriving that in each of C2, C3
// and C4 is how one of them ends up silently dropping the largest answers.
func TestRelayFrameCapMatchesTheShimContract(t *testing.T) {
	if maxRelayFrameBytes != 64<<10 {
		t.Fatalf("relay frame cap = %d, want 65536 (ARCHITECTURE.md §11)", maxRelayFrameBytes)
	}
	if mcpshim.FrameOverheadBytes != 28 {
		t.Fatalf("mcpshim.FrameOverheadBytes = %d, want 28 (nonce 12 + tag 16)", mcpshim.FrameOverheadBytes)
	}
	frame, err := mcpshim.SealFrame(make([]byte, mcpshim.PairingKeyBytes), "p",
		make([]byte, maxRelayFrameBytes-mcpshim.FrameOverheadBytes))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(frame) != maxRelayFrameBytes {
		t.Fatalf("largest payload seals to %d bytes, want exactly the cap %d", len(frame), maxRelayFrameBytes)
	}
}

// TestRelayPassesTheLargestLegalFrame: exactly at the cap must go through, or
// the biggest answers vanish while everything smaller works.
func TestRelayPassesTheLargestLegalFrame(t *testing.T) {
	f := newRelayFixture(t)
	pairingID, shim, device := f.bridged(t)

	frame, err := mcpshim.SealFrame(f.key, pairingID, bytes.Repeat([]byte("x"), maxRelayFrameBytes-mcpshim.FrameOverheadBytes))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(frame) != maxRelayFrameBytes {
		t.Fatalf("frame is %d bytes, want %d", len(frame), maxRelayFrameBytes)
	}
	writeFrame(t, shim, frame)
	if got := readFrame(t, device); !bytes.Equal(got, frame) {
		t.Fatalf("largest legal frame did not survive: got %d bytes", len(got))
	}
}

// TestRelayRejectsAnOversizedFrame: one byte over the cap and the sender is
// closed with 1009 — and its peer goes down with it, since a leg that dies takes
// the bridge with it.
func TestRelayRejectsAnOversizedFrame(t *testing.T) {
	f := newRelayFixture(t)
	pairingID, shim, device := f.bridged(t)

	frame, err := mcpshim.SealFrame(f.key, pairingID, bytes.Repeat([]byte("x"), maxRelayFrameBytes-mcpshim.FrameOverheadBytes+1))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	// The write itself may or may not error depending on when the relay's close
	// lands; what matters is that the frame is refused and never forwarded.
	_ = shim.Write(ctx, websocket.MessageBinary, frame)

	expectClose(t, shim, websocket.StatusMessageTooBig, "oversized sender")
	expectClose(t, device, websocket.StatusNormalClosure, "peer of an oversized sender")
}

// TestDeviceLegWithNoPairingGets4404 — and 4404 means the browser's vault record
// is a tombstone pointing at nothing, so it purges.
func TestDeviceLegWithNoPairingGets4404(t *testing.T) {
	f := newRelayFixture(t)
	conn, _, err := f.dial(t, f.relayURL()+"/device?pairing=whatever", f.session)
	if err != nil {
		t.Fatalf("the device leg must ACCEPT and then close, not reject the upgrade: %v", err)
	}
	expectClose(t, conn, StatusNoPairing, "device leg with no pairing minted")
}

// TestDeviceLegNotServingThePairingGets4409, from both directions a leg can be
// wrong: a stale id, and no id at all. Neither may purge — the account has a
// live pairing and the CRDT-synced record names it.
func TestDeviceLegNotServingThePairingGets4409(t *testing.T) {
	for _, tc := range []struct {
		name  string
		query string
	}{
		{"stale pairing id", "?pairing=an-id-from-before-the-re-pair"},
		{"no pairing id at all", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRelayFixture(t)
			f.mint(t)
			conn, _, err := f.dial(t, f.relayURL()+"/device"+tc.query, f.session)
			if err != nil {
				t.Fatalf("the device leg must ACCEPT and then close: %v", err)
			}
			expectClose(t, conn, StatusPairingReplaced, tc.name)
		})
	}
}

// TestTheTwoCloseCodesAreDistinguishable. They are reacted to in opposite ways —
// 4404 purges the vault record, 4409 must not — so a responder has to be able to
// tell them apart from the close code alone.
func TestTheTwoCloseCodesAreDistinguishable(t *testing.T) {
	if StatusNoPairing == StatusPairingReplaced {
		t.Fatal("4404 and 4409 collapsed into one code")
	}
	if StatusNoPairing != 4404 || StatusPairingReplaced != 4409 {
		t.Fatalf("close codes = %d/%d, want 4404/4409 (ARCHITECTURE.md §11, pinned)", StatusNoPairing, StatusPairingReplaced)
	}

	f := newRelayFixture(t)
	// No pairing at all.
	noPairing, _, err := f.dial(t, f.relayURL()+"/device?pairing=x", f.session)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	expectClose(t, noPairing, StatusNoPairing, "no pairing")

	// A live pairing this leg is not serving.
	f.mint(t)
	stale, _, err := f.dial(t, f.relayURL()+"/device?pairing=x", f.session)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	expectClose(t, stale, StatusPairingReplaced, "stale pairing")
}

// TestEvictedDeviceLegIsClosedWith4409, not abruptly. This is the second of the
// two places 4409 comes from and the subtle one: an abrupt close reaches the
// browser as 1006, which reads as a transient drop and gets retried — and the
// retry presents the same still-current id, passes the check, and evicts its
// replacement. Two unlocked devices then evict each other forever.
func TestEvictedDeviceLegIsClosedWith4409(t *testing.T) {
	f := newRelayFixture(t)
	pairingID := f.mint(t)

	first := f.dialDevice(t, pairingID)
	second := f.dialDevice(t, pairingID)

	expectClose(t, first, StatusPairingReplaced, "evicted device leg")

	// The replacement owns the bridge: the evicted leg's teardown must not have
	// taken it down too.
	shim := f.dialShim(t, pairingID)
	frame, err := mcpshim.SealFrame(f.key, pairingID, []byte(`{"jsonrpc":"2.0","id":9}`))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	writeFrame(t, shim, frame)
	if got := readFrame(t, second); !bytes.Equal(got, frame) {
		t.Fatal("the surviving device leg did not receive the frame")
	}
}

// TestADroppedLegClosesTheOther, in both directions.
func TestADroppedLegClosesTheOther(t *testing.T) {
	t.Run("shim drops", func(t *testing.T) {
		f := newRelayFixture(t)
		_, shim, device := f.bridged(t)
		shim.CloseNow()
		expectClose(t, device, websocket.StatusNormalClosure, "device after the shim dropped")
	})
	t.Run("device drops", func(t *testing.T) {
		f := newRelayFixture(t)
		_, shim, device := f.bridged(t)
		device.CloseNow()
		expectClose(t, shim, websocket.StatusNormalClosure, "shim after the device dropped")
	})
}

// TestRevokeClosesTheLegsWith4404: after Disconnect the account has no pairing
// at all, so the record really is a tombstone and the responder should purge.
func TestRevokeClosesTheLegsWith4404(t *testing.T) {
	f := newRelayFixture(t)
	_, shim, device := f.bridged(t)

	if rec := f.do(http.MethodDelete, "/api/mcp/pairings", nil, f.session); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/mcp/pairings = %d, body %q", rec.Code, rec.Body.String())
	}
	expectClose(t, device, StatusNoPairing, "device leg after revoke")
	expectClose(t, shim, StatusNoPairing, "shim leg after revoke")
}

// TestReMintClosesTheOldLegsWith4409: re-pairing leaves the account WITH a
// pairing, so a device on the old id must step aside without purging — purging
// would delete the record every other device is about to adopt.
func TestReMintClosesTheOldLegsWith4409(t *testing.T) {
	f := newRelayFixture(t)
	oldID, shim, device := f.bridged(t)

	newID := f.mint(t)
	if newID == oldID {
		t.Fatal("re-minting returned the same pairing id")
	}
	expectClose(t, device, StatusPairingReplaced, "device leg after a re-mint")
	expectClose(t, shim, StatusPairingReplaced, "shim leg after a re-mint")

	// The old id is dead as a shim credential too.
	if _, resp, err := f.dial(t, f.relayURL()+"/shim?pairing="+oldID, nil); err == nil {
		t.Fatal("the old pairing id still opens a shim leg")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stale shim dial = %v (resp %v), want 401", err, resp)
	}
}

// TestShimLegRejectsAnUnknownPairing at the handshake — unlike the device leg,
// the caller here is a Go process that can read an HTTP status.
func TestShimLegRejectsAnUnknownPairing(t *testing.T) {
	f := newRelayFixture(t)
	f.mint(t)
	for _, q := range []string{"?pairing=not-a-real-pairing", ""} {
		_, resp, err := f.dial(t, f.relayURL()+"/shim"+q, nil)
		if err == nil {
			t.Fatalf("shim dial with %q succeeded", q)
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("shim dial with %q: resp %v, want 401", q, resp)
		}
	}
}

// TestPairingEndpointsRequireASession.
func TestPairingEndpointsRequireASession(t *testing.T) {
	f := newRelayFixture(t)
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		if rec := f.do(method, "/api/mcp/pairings", nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s /api/mcp/pairings without a session = %d, want 401", method, rec.Code)
		}
	}
	// So does the device leg — and there it is a handshake rejection, because an
	// unauthenticated caller has no pairing to be told about.
	if _, resp, err := f.dial(t, f.relayURL()+"/device?pairing=x", nil); err == nil {
		t.Fatal("the device leg accepted a caller with no session")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("device dial without a session: resp %v, want 401", resp)
	}
}

// postPairingFrom drives the mint endpoint from a specific peer, so the test can
// see which bucket the limiter used.
func (f *relayFixture) postPairingFrom(remoteAddr, forwardedFor string) int {
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/pairings", nil)
	req.Host = testHost
	req.RemoteAddr = remoteAddr
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	req.AddCookie(f.session)
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	return rec.Code
}

// TestPairingMintIsRateLimitedPerClient pins that mint goes through the EXISTING
// limiter, buckets included. A second limiter keying on RemoteAddr would put
// every user behind a reverse proxy into one bucket — that exact bypass was
// found here once, 90 ceremonies through a limit of 30.
func TestPairingMintIsRateLimitedPerClient(t *testing.T) {
	f := newRelayFixture(t)
	const peer = "192.0.2.10:4444"

	allowed := 0
	for i := 0; i < ceremonyRateLimitMax+5; i++ {
		if f.postPairingFrom(peer, "") == http.StatusTooManyRequests {
			break
		}
		allowed++
	}
	if allowed == 0 || allowed >= ceremonyRateLimitMax+5 {
		t.Fatalf("mint allowed %d requests from one peer; the limiter is not applied", allowed)
	}
	if allowed != ceremonyRateLimitMax {
		t.Fatalf("mint allowed %d requests, want %d — mint must share the ceremony budget", allowed, ceremonyRateLimitMax)
	}

	// A different client is unaffected: the bucket is per-caller, not global.
	if code := f.postPairingFrom("198.51.100.7:5555", ""); code != http.StatusOK {
		t.Fatalf("a second client got %d while the first was throttled; the limiter is global", code)
	}
	// And behind a trusted proxy the forwarded address is what buckets, which is
	// the load-bearing half of clientIP.
	if code := f.postPairingFrom("127.0.0.1:6666", "203.0.113.9"); code != http.StatusOK {
		t.Fatalf("a forwarded client got %d; the trusted-proxy path is not being used", code)
	}
}

// TestRelayServesThePinnedRelayEndpoint binds the SERVER half of §11's path pin
// to the same vector file the shim half is pinned against. relay_url is the
// endpoint; each leg appends only its own segment. Serving anything else 404s
// every real pairing while passing every test that mints its own code.
func TestRelayServesThePinnedRelayEndpoint(t *testing.T) {
	raw, err := os.ReadFile("../mcpshim/testdata/mcp_frame_vectors.json")
	if err != nil {
		t.Fatalf("read the pinned vectors: %v", err)
	}
	var v struct {
		RelayURL string `json:"relay_url"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode the pinned vectors: %v", err)
	}
	pinned, err := url.Parse(v.RelayURL)
	if err != nil {
		t.Fatalf("parse the pinned relay_url %q: %v", v.RelayURL, err)
	}
	if pinned.Path != relayEndpoint {
		t.Fatalf("pinned relay_url path = %q, want %q", pinned.Path, relayEndpoint)
	}

	// Dial the pinned PATH against this server's origin: only the origin is
	// substituted, so a route served anywhere else fails here.
	f := newRelayFixture(t)
	base := strings.Replace(f.srv.URL, "http://", "ws://", 1) + pinned.Path
	pairingID := f.mint(t)
	if _, _, err := f.dial(t, base+"/shim?pairing="+pairingID, nil); err != nil {
		t.Fatalf("the shim leg is not served at the pinned path %s/shim: %v", pinned.Path, err)
	}
	if _, _, err := f.dial(t, base+"/device?pairing="+pairingID, f.session); err != nil {
		t.Fatalf("the device leg is not served at the pinned path %s/device: %v", pinned.Path, err)
	}
}

// respondOnDevice is a stand-in for the browser responder (C4): it opens each
// frame, echoes the request back as a JSON-RPC result, and seals the reply. It
// exists so the end-to-end test drives the REAL shim client through the REAL
// relay rather than through a fake of either.
func respondOnDevice(t *testing.T, conn *websocket.Conn, key []byte, pairingID string) {
	t.Helper()
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		payload, err := mcpshim.OpenFrame(key, pairingID, data)
		if err != nil {
			continue
		}
		msg, err := jsonrpc.DecodeMessage(payload)
		if err != nil {
			continue
		}
		req, ok := msg.(*jsonrpc.Request)
		if !ok {
			continue
		}
		body, err := json.Marshal(map[string]any{"method": req.Method, "params": json.RawMessage(req.Params)})
		if err != nil {
			return
		}
		out, err := jsonrpc.EncodeMessage(&jsonrpc.Response{ID: req.ID, Result: body})
		if err != nil {
			return
		}
		frame, err := mcpshim.SealFrame(key, pairingID, out)
		if err != nil {
			return
		}
		if err := conn.Write(context.Background(), websocket.MessageBinary, frame); err != nil {
			return
		}
	}
}

// TestEndToEndThroughTheRealShimClient runs a whole tool call across the real
// relay: a pairing code of exactly the shape Settings mints, parsed and dialed
// by C3's own client, answered by a responder holding the key. Nothing here is
// a fake relay, and nothing tells the shim where the legs live except the code.
func TestEndToEndThroughTheRealShimClient(t *testing.T) {
	f := newRelayFixture(t)
	pairingID := f.mint(t)
	device := f.dialDevice(t, pairingID)
	go respondOnDevice(t, device, f.key, pairingID)

	code, err := mcpshim.FormatPairingCode(&mcpshim.PairingCode{
		RelayURL:  f.relayURL(),
		PairingID: pairingID,
		Key:       f.key,
	})
	if err != nil {
		t.Fatalf("format pairing code: %v", err)
	}
	client, err := mcpshim.NewClient(code)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	raw, err := client.Call(ctx, "mcp_help", mcpshim.HelpInput{Topic: "performance"})
	if err != nil {
		t.Fatalf("Call through the real relay: %v", err)
	}
	var got struct {
		Method string            `json:"method"`
		Params mcpshim.HelpInput `json:"params"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if got.Method != "mcp_help" || got.Params.Topic != "performance" {
		t.Fatalf("round trip lost the request: %+v", got)
	}
}
