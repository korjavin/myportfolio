package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// dialAttempts and dialBackoff bound reconnection. They are small on purpose.
//
// The failure mode this design keeps producing is "the connector looks alive
// and every call times out": a shim that retries forever reports nothing, so
// the agent waits, the user sees a hang, and nothing anywhere says the relay
// is unreachable. So reconnection gives up quickly and returns the real dial
// error up through the MCP tool result, where the model can read it and say
// so. Total wall clock before giving up is ~0.75s of backoff plus whatever
// the dials themselves cost — deliberately far inside CallTimeout, so a dead
// relay is distinguishable from a live relay with no device behind it.
const (
	dialAttempts = 3
	dialBackoff  = 250 * time.Millisecond
)

// Client wraps ShimCore with reconnect-on-drop: the one object cmd/mcpshim's
// stdio server calls into for every tool invocation.
//
// The relay closes the shim leg whenever its paired device leg drops (bd
// myportfolio-ybp.2 closes both sides symmetrically), so without this a stale
// ShimCore's next Call would fail immediately with a raw transport error
// instead of the actionable offline text. Redialing first means the call
// instead waits out a fresh CallTimeout with nothing to answer it and returns
// ErrDeviceOffline, exactly like the never-paired case.
type Client struct {
	pc   *PairingCode
	opts *websocket.DialOptions

	mu   sync.Mutex
	core *ShimCore
}

// NewClient parses code (the MYPORTFOLIO_MCP_CODE env var) and returns a
// Client that dials lazily on the first Call. A malformed code fails here,
// at startup, rather than as a mystery timeout on the first question.
func NewClient(code string) (*Client, error) {
	pc, err := ParsePairingCode(code)
	if err != nil {
		return nil, err
	}
	return &Client{pc: pc}, nil
}

// NewClientFromPairing builds a Client from an already-parsed pairing code
// with the underlying dial options exposed — the seam tests use to force
// every (re)dial through a fake relay's real listener address.
func NewClientFromPairing(pc *PairingCode, opts *websocket.DialOptions) *Client {
	return &Client{pc: pc, opts: opts}
}

// Call ensures a live connection to the relay, then runs one JSON-RPC
// round-trip through it. If the cached connection turns out to have died
// between the liveness check and the write (isClosed is inherently racy
// against the relay closing it out from under us), Call redials once and
// retries — bounded at one retry, because a second failure is a real fault
// and not a race.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	core, err := c.connected(ctx)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: connect to relay: %w", err)
	}
	result, err := core.Call(ctx, method, params)
	if errors.Is(err, errConnectionDropped) {
		core, err = c.redial(ctx)
		if err != nil {
			return nil, fmt.Errorf("mcpshim: reconnect to relay: %w", err)
		}
		return core.Call(ctx, method, params)
	}
	return result, err
}

func (c *Client) connected(ctx context.Context) (*ShimCore, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.core != nil && !c.core.isClosed() {
		return c.core, nil
	}
	return c.redialLocked(ctx)
}

func (c *Client) redial(ctx context.Context) (*ShimCore, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.redialLocked(ctx)
}

// redialLocked dials up to dialAttempts times with a linear backoff, then
// gives up and returns the last error wrapped with the attempt count. It never
// loops unbounded and it never swallows the cause.
func (c *Client) redialLocked(ctx context.Context) (*ShimCore, error) {
	var lastErr error
	for attempt := 1; attempt <= dialAttempts; attempt++ {
		if attempt > 1 {
			select {
			case <-time.After(time.Duration(attempt-1) * dialBackoff):
			case <-ctx.Done():
				return nil, fmt.Errorf("mcpshim: gave up reconnecting after %d attempts: %w (last dial error: %v)", attempt-1, ctx.Err(), lastErr)
			}
		}
		core, err := DialPairing(ctx, c.pc, c.opts)
		if err == nil {
			c.core = core
			return core, nil
		}
		lastErr = err
	}
	c.core = nil
	return nil, fmt.Errorf("mcpshim: gave up reconnecting after %d attempts: %w", dialAttempts, lastErr)
}

// Close tears down the underlying connection, if one was ever dialed (Call
// connects lazily, so a Client that never made a call has nothing to close).
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.core == nil {
		return nil
	}
	return c.core.Close()
}
