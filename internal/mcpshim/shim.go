package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	conn, _, err := websocket.Dial(ctx, shimLegURL(pc), opts)
	if err != nil {
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
			s.failAll(fmt.Errorf("mcpshim: relay connection closed: %w", err))
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
