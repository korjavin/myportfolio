package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
)

// maxFrameBytes is the relay's per-frame cap (bd myportfolio-ybp.2, 64 KiB),
// which is on the WHOLE frame — nonce and tag included. coder/websocket
// defaults to a 32 KiB read limit, so without SetReadLimit the shim would
// tear down the connection on any 32–64 KiB response the relay itself passed
// through fine, and that surfaces as a spurious ErrDeviceOffline rather than
// as "the answer was too big".
//
// The usable payload is maxFrameBytes - FrameOverheadBytes; frame.go owns
// that arithmetic and TestFramePayloadCeiling pins it, because C2, C3 and C4
// each deriving it independently is how one of them ends up off by 28 bytes
// and silently drops exactly the largest answers.
//
// ponytail: kept in lockstep with the relay by hand — importing
// internal/server from the shim is the wrong dependency direction, and the
// shim must stay buildable as a standalone client binary.
const maxFrameBytes = 64 << 10

// CallTimeout bounds how long Call waits for a correlated response. There is
// exactly one reason a call never returns on this transport: no unlocked
// browser tab is on the other end of the relay. The relay only pipes opaque
// frames (ARCHITECTURE.md §11) — it can neither answer nor fabricate a
// response — so the timeout maps directly onto ErrDeviceOffline.
//
// A var, not a const, only so the tests can shorten it — nothing in
// production assigns to it.
var CallTimeout = 30 * time.Second

// ErrDeviceOffline is Call's error when no response arrives within
// CallTimeout. It is relayed verbatim to the model, so it states the product
// limitation (§11: "every call requires a live, unlocked browser tab; there
// is no server-side fallback, by design") rather than leaving an agent to
// guess it should retry.
//
// It asserts "your pairing code is valid" on purpose, and that assertion is
// only honest because ParsePairingCode carries a checksum: before that, a
// single mistyped character had a ~11% chance of yielding a plausible-looking
// WRONG key, and a wrong key produces frames the browser cannot open — which
// arrives here as a timeout and reads as exactly this message. Those two
// causes were indistinguishable, so the user with a typo concluded the
// product was broken. The shim now refuses to start on a bad code, so by the
// time anyone can see this text, the code really is fine and the sentence
// rules a typo out rather than leaving it as the first thing to suspect.
//
//nolint:staticcheck // ST1005: a terminal, user-facing sentence shown to the model, not a wrapped Go error.
var ErrDeviceOffline = errors.New("No unlocked device is online to answer. Your pairing code is valid — this is not a typo — but nothing is listening on the other end: open your portfolio in a browser tab and unlock it, then retry. This connector talks to your device, not to a server, because your data is end-to-end encrypted and the server holds only ciphertext.")

// The relay's two application close codes, mirrored rather than imported:
// internal/server is the wrong dependency direction for a standalone client
// (see maxFrameBytes). internal/server.StatusNoPairing and
// StatusPairingReplaced are the definitions, and they are pinned from that side
// by TestRevokeClosesTheLegsWith4404 / TestReMintClosesTheOldLegsWith4409.
//
// They are NOT interchangeable (ARCHITECTURE.md §11) and neither is a transient
// drop: 4404 means the account has no pairing at all, so every redial re-runs a
// dial that can only 401; 4409 means a live pairing exists but this leg is not
// serving it, so every redial re-runs the same lost race. Anything else —
// 1006, a normal closure when the peer leg drops, a broken TCP connection — is
// exactly the case reconnect exists for and must keep reconnecting.
const (
	statusNoPairing       websocket.StatusCode = 4404
	statusPairingReplaced websocket.StatusCode = 4409
)

// ErrPairingGone (4404) and ErrPairingReplaced (4409) are terminal: no amount
// of redialing changes either, so the shim stops and says what to DO instead.
//
// Like ErrDeviceOffline these are shown verbatim to the model, and all three
// must stay mutually distinguishable — conflating them is what produces "the
// connector looks alive and every call times out", a symptom that points
// nowhere. ErrDeviceOffline means the pairing is fine and no tab is open (wait
// and retry); these two mean the pairing itself is not usable from here (act).
//
//nolint:staticcheck // ST1005: terminal, user-facing sentences, not wrapped Go errors.
var (
	ErrPairingGone = errors.New("This pairing no longer exists. The relay reports no active pairing for this account, so no device can be reached with this code and reconnecting cannot help. Open your portfolio in a browser, unlock it, and re-pair from Settings to mint a new code, then restart this connector with it.")

	//nolint:staticcheck // ST1005: as above.
	ErrPairingReplaced = errors.New("Another connection took over this pairing. A newer connector, or a newer pairing minted from Settings, replaced this one, so this connection has been retired and reconnecting would only lose the same race. If you re-paired, restart this connector with the new code from Settings; if a second copy of this connector is running, stop it and keep one.")
)

// isTerminalClose reports whether err is one of the two relay closes that no
// redial can fix.
func isTerminalClose(err error) bool {
	return errors.Is(err, ErrPairingGone) || errors.Is(err, ErrPairingReplaced)
}

// errConnectionDropped marks a Call failure caused by this ShimCore's own
// connection having already died — most often because the relay closed the
// shim leg in lockstep with its paired device leg dropping. Client matches it
// with errors.Is to redial and retry once, so the caller ends up waiting out
// a real CallTimeout against a fresh connection (and thus sees
// ErrDeviceOffline) instead of a raw transport error.
var errConnectionDropped = errors.New("mcpshim: connection dropped")

// ShimCore is one live connection to the relay's shim leg: the pairing key,
// the socket, and the table correlating outstanding requests to responses by
// JSON-RPC id.
//
// The key lives here and goes nowhere else. It is passed to SealFrame and
// OpenFrame and to nothing else in this file — no URL, no header, no log
// line, no error string. That is the single property the whole connector
// rests on.
type ShimCore struct {
	conn      *websocket.Conn
	key       []byte
	pairingID string

	nextID atomic.Int64

	mu       sync.Mutex
	pending  map[string]chan *jsonrpc.Response
	closed   chan struct{}
	closeErr error
}

// shimLegURL is where the shim leg lives, derived from the pairing code's
// relay_url.
//
// relay_url is the relay ENDPOINT, not the origin — the pinned vector
// (testdata/mcp_frame_vectors.json) has "wss://portfolio.example/api/mcp/relay",
// and Settings mints codes in that shape. So only "/shim" is appended here.
// This is a divergence from medicationtrackerbot, whose relay_url is a bare
// origin and whose shim therefore appends the whole "/api/mcp/relay/shim"
// path; porting that line verbatim dials
// ".../api/mcp/relay/api/mcp/relay/shim", which 404s against every real
// pairing while passing any test that mints its own code from a bare
// listener address. TestShimLegURLMatchesThePinnedRelayURL pins it against
// the vector instead, so the two halves cannot drift.
//
// The pairing id is query-escaped because the shim did not choose it — the
// browser did — and an id containing "&", "/" or "#" would otherwise rewrite
// the URL. The browser responder escapes it on its leg too.
func shimLegURL(pc *PairingCode) string {
	return strings.TrimSuffix(pc.RelayURL, "/") + "/shim?pairing=" + url.QueryEscape(pc.PairingID)
}

// DialPairing connects to the relay's shim leg for pc. opts may be nil; it is
// the seam a test uses to point every dial at an httptest.Server's real
// listener while the pairing still carries its production relay URL.
func DialPairing(ctx context.Context, pc *PairingCode, opts *websocket.DialOptions) (*ShimCore, error) {
	conn, resp, err := websocket.Dial(ctx, shimLegURL(pc), opts)
	if err != nil {
		// A 401 on the shim leg has exactly one cause: the relay has no live
		// pairing with this id (internal/server.shimSocket rejects at the
		// handshake and nowhere else). That is the same fact close code 4404
		// carries, so report the same terminal error rather than a transport
		// fault, and stop dialing.
		//
		// This is the path a RESTART takes, and it is the common one — the
		// relay's pairing table is in-memory by design (§11 "Restarts remain
		// unhandled, deliberately"), so every redeploy leaves a configured
		// connector dialing a pairing the relay has forgotten. Without this the
		// user gets "gave up reconnecting after 3 attempts: … 401" — a transport
		// error, i.e. the looks-alive-and-fails symptom §11 keeps having to
		// stamp out — instead of the sentence that tells them to re-pair. It is
		// deliberately NOT ErrDeviceOffline: unlocking a tab cannot fix this,
		// because the tab's own device leg is being closed with 4404 too.
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return nil, ErrPairingGone
		}
		return nil, fmt.Errorf("mcpshim: dial relay: %w", err)
	}
	conn.SetReadLimit(maxFrameBytes)
	s := &ShimCore{
		conn:      conn,
		key:       pc.Key,
		pairingID: pc.PairingID,
		pending:   make(map[string]chan *jsonrpc.Response),
		closed:    make(chan struct{}),
	}
	go s.readLoop()
	return s, nil
}

// Call sends method/params as one sealed JSON-RPC request and waits up to
// CallTimeout for the correlated response.
func (s *ShimCore) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, err := jsonrpc.MakeID(float64(s.nextID.Add(1)))
	if err != nil {
		return nil, err
	}
	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: marshal params: %w", err)
	}
	payload, err := jsonrpc.EncodeMessage(&jsonrpc.Request{ID: id, Method: method, Params: rawParams})
	if err != nil {
		return nil, fmt.Errorf("mcpshim: encode request: %w", err)
	}
	frame, err := SealFrame(s.key, s.pairingID, payload)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: seal frame: %w", err)
	}

	key := fmt.Sprint(id.Raw())
	respCh := make(chan *jsonrpc.Response, 1)
	s.mu.Lock()
	s.pending[key] = respCh
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, key)
		s.mu.Unlock()
	}()

	if err := s.conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
		return nil, fmt.Errorf("%w: write frame: %w", errConnectionDropped, err)
	}

	timer := time.NewTimer(CallTimeout)
	defer timer.Stop()
	select {
	case resp := <-respCh:
		if resp.Error != nil {
			// Deliberately NOT returned as the *jsonrpc.Error it arrived as.
			// The SDK special-cases that type and re-emits it as a protocol
			// error on the outer stdio connection, where an MCP client reads
			// it as "the connector is broken" and the model never sees the
			// text. These are ordinary operation failures from the responder
			// — an unknown operation_id, bad params — and the model has to
			// read them to correct itself. Flattening to a plain error makes
			// the SDK wrap it in a tool result with isError, which is what
			// the MCP spec reserves for exactly this.
			//
			// This is also what makes §11's mcp_execute rule work: the
			// responder answers that call with an explicit error saying a
			// server-side script runner would have nothing to read. That
			// sentence exists to stop an agent retrying forever, and it only
			// does its job if it reaches the agent.
			msg := resp.Error.Error()
			var wireErr *jsonrpc.Error
			if errors.As(resp.Error, &wireErr) {
				msg = fmt.Sprintf("%s (responder error %d)", wireErr.Message, wireErr.Code)
			}
			return nil, errors.New(msg)
		}
		return resp.Result, nil
	case <-timer.C:
		return nil, ErrDeviceOffline
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.closed:
		return nil, fmt.Errorf("%w: %w", errConnectionDropped, s.closeErr)
	}
}

// Close tears down the relay connection.
func (s *ShimCore) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "shim closing")
}

// isClosed reports whether readLoop has already torn this connection down —
// most commonly because the relay closed the shim leg when the paired device
// went offline. Client uses it to decide whether a call needs a fresh dial.
func (s *ShimCore) isClosed() bool {
	select {
	case <-s.closed:
		return true
	default:
		return false
	}
}

// readLoop opens and decodes inbound frames, delivering each Response to its
// correlated Call. A frame that fails to decrypt or decode is dropped — the
// relay is untrusted and anything it injects that we cannot open is by
// definition not from our paired device. A read error ends the connection and
// releases every outstanding Call through the closed channel.
func (s *ShimCore) readLoop() {
	ctx := context.Background()
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			s.failAll(closeReason(err))
			return
		}
		payload, err := OpenFrame(s.key, s.pairingID, data)
		if err != nil {
			continue
		}
		msg, err := jsonrpc.DecodeMessage(payload)
		if err != nil {
			continue
		}
		resp, ok := msg.(*jsonrpc.Response)
		if !ok {
			continue
		}
		key := fmt.Sprint(resp.ID.Raw())
		s.mu.Lock()
		ch, ok := s.pending[key]
		delete(s.pending, key)
		s.mu.Unlock()
		if ok {
			ch <- resp
		}
	}
}

// closeReason turns readLoop's read error into the error every outstanding
// Call sees. The relay's two terminal close codes become their own sentinels;
// everything else stays an ordinary transport error that Client redials on.
func closeReason(err error) error {
	switch websocket.CloseStatus(err) {
	case statusNoPairing:
		return ErrPairingGone
	case statusPairingReplaced:
		return ErrPairingReplaced
	}
	return fmt.Errorf("mcpshim: relay connection closed: %w", err)
}

// terminalCloseGrace bounds how long awaitTerminal waits for the REASON a
// dying connection died.
//
// A Call's write can fail microseconds before readLoop reads the close frame
// carrying 4404 or 4409 — the relay closes gracefully, but the two events race.
// Treating that as "no reason given" throws the close code away and redials
// into a pairing that cannot come back, which is the bug this whole change
// exists to fix, reintroduced as a flake.
//
// This wait is ONLY ever paid on a connection whose write just failed — the
// socket is already gone — and ctx still bounds it, so a healthy call pays
// nothing. That is what makes it safe to be genuinely generous.
//
// It was 250ms, and that comment claimed 250ms was generous. It is not, on a
// loaded CI runner or a loaded laptop: losing this race throws the close code
// away, the shim redials, and the call then burns the full 30s CallTimeout to
// return ErrDeviceOffline. The user sees Claude hang for half a minute and then
// say "no device online" when the truth was "another connection took over your
// pairing" — a fourth source of the looks-alive-and-times-out symptom that the
// pairing checksum, the dial URL and the close codes were each fixed to stop
// producing. Being 200ms slower on a dead socket is free; being wrong is not.
const terminalCloseGrace = 5 * time.Second

// awaitTerminal waits for this connection to finish tearing down and reports
// the terminal close it died of, or nil. Only ever called on a connection whose
// Call just failed, so the wait is paid on a socket that is already gone.
func (s *ShimCore) awaitTerminal(ctx context.Context) error {
	timer := time.NewTimer(terminalCloseGrace)
	defer timer.Stop()
	select {
	case <-s.closed:
	case <-timer.C:
	case <-ctx.Done():
	}
	return s.terminalErr()
}

// terminalErr reports the terminal close this connection died of, or nil if it
// is alive or died of something a redial could fix. Reading closeErr needs no
// lock here: failAll assigns it before closing s.closed, so observing the
// closed channel is the happens-before edge.
func (s *ShimCore) terminalErr() error {
	select {
	case <-s.closed:
		if isTerminalClose(s.closeErr) {
			return s.closeErr
		}
	default:
	}
	return nil
}

func (s *ShimCore) failAll(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.closed:
	default:
		s.closeErr = err
		close(s.closed)
	}
}
