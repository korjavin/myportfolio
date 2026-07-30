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
		return nil, connectErr("connect to", err)
	}
	result, err := core.Call(ctx, method, params)
	if errors.Is(err, errConnectionDropped) {
		// This core is dead; whether that is worth a redial depends on WHY,
		// and the why can still be in flight (the write fails, then readLoop
		// reads the close frame). Ask the connection that actually failed —
		// c.core may already be a newer one dialed by a concurrent Call.
		if terminal := core.awaitTerminal(ctx); terminal != nil {
			return nil, terminal
		}
		core, err = c.redial(ctx)
		if err != nil {
			return nil, connectErr("reconnect to", err)
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
	// Unless the relay already said redialing is pointless. 4404 (no pairing at
	// all) and 4409 (a live pairing this leg is not serving) are terminal: the
	// attempts would burn on a dial that can only 401, or on the same lost
	// race, and the user would get a transport error instead of the one
	// sentence that tells them to re-pair. c.core is left in place on purpose —
	// it makes every later Call answer with the same terminal error rather than
	// starting the pointless dialing over.
	if c.core != nil {
		if err := c.core.terminalErr(); err != nil {
			return nil, err
		}
	}

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
		// A terminal pairing error from the dial itself (a 401, meaning the relay
		// has no such pairing) is finished for the same reason a terminal CLOSE
		// is: the remaining attempts would re-run a dial that can only 401, and
		// wrapping it in "gave up reconnecting" would bury the sentence the user
		// has to act on behind a transport-sounding one.
		if isTerminalClose(err) {
			return nil, err
		}
		lastErr = err
	}
	c.core = nil
	return nil, fmt.Errorf("mcpshim: gave up reconnecting after %d attempts: %w", dialAttempts, lastErr)
}

// connectErr wraps a failure to reach the relay, EXCEPT for the two terminal
// pairing errors. Those are finished, user-facing sentences meant to be read by
// the model exactly as written (like ErrDeviceOffline, which Call also returns
// unwrapped); a "mcpshim: reconnect to relay:" prefix would only bury the
// instruction the user has to act on behind a transport-sounding one.
func connectErr(what string, err error) error {
	if isTerminalClose(err) {
		return err
	}
	return fmt.Errorf("mcpshim: %s relay: %w", what, err)
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
