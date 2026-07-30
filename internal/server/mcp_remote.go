package server

// The hosted-connector registry (ARCHITECTURE.md §11 Tier 2): the server-side
// state behind a URL the user pastes into Claude or ChatGPT. Ported from
// medicationtrackerbot's internal/cloudserver/mcp_remote.go.
//
// Nothing here is routed to the internet. The streamable-HTTP endpoint that
// authenticates against this registry, and the Settings routes that enable and
// revoke, are separate beads; this file is the state and the lifecycle they
// both need, so that "enabled" has exactly one meaning and revoking has exactly
// one place to be wrong.
//
// Three rules the port carries and this file must not lose:
//
//   - The token is a CAPABILITY. It never reaches a log line, an error string, or
//     a metrics label. TestMCPRemoteTokenNeverReachesTheLog pins that.
//   - Tokens are compared in constant time, never with ==.
//   - Disabling, re-minting and deleting an account each leave NO openable
//     pairing key on disk. A revoked connector whose key is still decryptable is
//     not revoked.
//
// Where this deliberately diverges from the sibling, per §11 "Where we diverge":
// its token is short enough to type across devices, so entropy is scarce and a
// per-account failed-attempt throttle is its actual security boundary. Ours is
// copied into a config file and never retyped, so the token is high-entropy and
// brute force stops being the boundary. That matters twice over here because we
// are single origin (§8.2): the sibling resolves the account from the subdomain
// BEFORE checking the token and can therefore scope a throttle to it, while for
// us the token is the only identifier there is until it is looked up, so a
// per-account throttle is not even expressible. Per-IP throttling at the
// endpoint remains worth having as defence in depth — it is just not what makes
// the token unguessable.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/korjavin/myportfolio/internal/mcpshim"
	"github.com/korjavin/myportfolio/internal/store"
)

// mcpRemoteTokenBytes is 256 bits of entropy, rendered as 43 base64url
// characters in the connector URL's path.
//
// The bead's floor is 128 bits; the extra 16 bytes cost one longer URL that
// nobody types and buy the argument outright — at 256 bits there is no
// brute-force story left to reason about, so the endpoint's rate limiting can be
// defence in depth instead of load-bearing. Deliberately NOT the sibling's
// 6-symbol Crockford base32 code: that alphabet exists to survive being read
// aloud and retyped, a constraint we do not have.
const mcpRemoteTokenBytes = 32

// generateMCPRemoteToken mints one connector token. base64url without padding,
// so it is a single URL path segment needing no escaping.
func generateMCPRemoteToken() (string, error) {
	b := make([]byte, mcpRemoteTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("server: mcp remote: generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// constantTimeTokenEqual compares two tokens without leaking, through timing,
// how many leading bytes matched.
//
// The length precheck is not constant-time and does not need to be: every live
// token is the same fixed length, which is public (it is visible in the URL
// format we document), so length carries no secret. crypto/hmac.Equal has the
// same precheck for the same reason.
func constantTimeTokenEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// errConnectorRevoked is what a call through a torn-down entry gets. It is the
// user's own action, so it says what to do about it rather than sounding like a
// fault: the model relays this text.
var errConnectorRevoked = errors.New("this connector was disconnected or replaced — open your portfolio's Settings and enable the connector again to get a new URL")

// mcpRemoteEntry is one enabled account's live connector: the token that
// authenticates it and the shim client that dials the relay on the account's
// behalf. The plaintext pairing key exists nowhere else in the process — it
// lives inside the client's pairing code and is never copied out.
//
// Route calls through the entry's own call method, never through entry.client
// directly. Removing an entry from the registry does not by itself stop it: a
// request that resolved its token a moment before the user hit disconnect still
// holds this pointer, and mcpshim.Client.Close only closes the current
// connection without marking the client unusable — so the next Call would
// happily REDIAL with the revoked pairing. revoked is what actually ends it, and
// it is set before the close (codex review found this).
type mcpRemoteEntry struct {
	token   string
	client  *mcpshim.Client
	revoked atomic.Bool
}

// call runs one MCP call for this connector, refusing once the connector has
// been revoked. The check-then-call gap is one instruction wide and cannot be
// closed — a call already inside the relay round trip finishes, exactly as a
// request already past requireSession does when a device is revoked mid-flight.
// What it does close is the unbounded case: a stale entry that keeps working
// indefinitely because nothing ever told it to stop.
func (e *mcpRemoteEntry) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if e.revoked.Load() {
		return nil, errConnectorRevoked
	}
	return e.client.Call(ctx, method, params)
}

// mcpRemoteRegistry is the process's view of which accounts have the hosted
// connector enabled, kept in step with the mcp_remote table.
//
// Both halves are needed. The table is the durable truth (a restart must not
// silently revoke a connector the user configured in Claude), and the in-memory
// entries hold the opened pairing key and the live client, because the sealed
// key on disk cannot answer a call.
type mcpRemoteRegistry struct {
	db            *store.DB
	sessionSecret string

	// lifecycleMu serializes whole enable/disable critical sections against each
	// other, the sibling's lifecycleMu minus its relay hook (our relay has no
	// hosted-mode seam and this bead does not add one).
	//
	// It is not decoration. Both operations are a durable write followed by a map
	// mutation, so without it a simultaneous enable and disable can interleave as
	// enable-writes-row, disable-deletes-row, disable-stops-nothing,
	// enable-installs-entry — leaving a live entry whose token still authenticates
	// for an account whose row is gone and whose user just clicked disconnect.
	// It is the outermost lock; mu is only ever taken while holding it, or alone.
	lifecycleMu sync.Mutex

	mu    sync.RWMutex
	byAcc map[string]*mcpRemoteEntry
}

func newMCPRemoteRegistry(db *store.DB, sessionSecret string) *mcpRemoteRegistry {
	return &mcpRemoteRegistry{db: db, sessionSecret: sessionSecret, byAcc: make(map[string]*mcpRemoteEntry)}
}

// restore rebuilds the registry from every persisted enablement. Called once at
// boot, before anything can serve.
//
// A row that cannot be opened is logged and skipped, never fatal: rotating the
// session secret orphans every stored pairing key (mcp_seal.go), and an operator
// who has just rotated must still get a booting server. Those users have to
// re-pair, and that consequence belongs in the deployment docs rather than in a
// panic here.
//
// The pairing itself is NOT restored, and cannot be by this bead: the relay's
// pairing table is in-memory on purpose (§11's "Restarts remain unhandled,
// deliberately") and it has no restore seam. So a connector that survives a
// restart resolves its token but dials a pairing the relay has forgotten, and
// the caller gets §11's actionable "no unlocked device" error until the user
// re-pairs. Closing that gap needs a seam in mcp_relay.go, which this bead may
// not touch.
func (r *mcpRemoteRegistry) restore(ctx context.Context) {
	rows, err := r.db.ListMCPRemote(ctx)
	if err != nil {
		slog.Error("mcp remote: list persisted connectors", "error", err)
		return
	}
	for _, row := range rows {
		key, err := openPairingKey(r.sessionSecret, row.PairingKeyCT, row.PairingKeyNonce)
		if err != nil {
			slog.Error("mcp remote: cannot open stored pairing key — has the session secret been rotated? this account must re-pair",
				"account_id", row.AccountID, "error", err)
			continue
		}
		r.install(row.AccountID, row.Token, &mcpshim.PairingCode{RelayURL: row.RelayURL, PairingID: row.PairingID, Key: key})
		slog.Info("mcp remote: restored hosted connector", "account_id", row.AccountID)
	}
}

// enable turns the hosted connector on for accountID against the pairing in pc,
// returning the freshly minted token. Re-enabling replaces the row, rotates the
// token, and drops the previous pairing key.
//
// pc.RelayURL IS DIALED BY THIS SERVER, so every caller must first bind it to
// the request's own host. It arrives inside a pairing code the account holder
// submitted, and an unchecked one turns this into an SSRF: an authenticated user
// aims the dial at any host or port the server can reach and triggers it by
// hitting their own connector URL. The sibling does this with relayURLIsSelf in
// its handler, because only the handler has the request; the same is true here,
// so the handler bead owns that check and this comment is the standing reminder
// that it is not optional.
func (r *mcpRemoteRegistry) enable(ctx context.Context, accountID string, pc *mcpshim.PairingCode) (string, error) {
	// A wrong-length key would seal and store fine and then fail only at the
	// AEAD, which reaches the user as "no device online" — §11's least
	// attributable failure. Callers parse the code with mcpshim.ParsePairingCode,
	// which already rejects this; the guard is here so a caller that did not
	// cannot persist a connector that can never answer.
	if len(pc.Key) != mcpshim.PairingKeyBytes {
		return "", fmt.Errorf("server: mcp remote: pairing key is %d bytes, want %d", len(pc.Key), mcpshim.PairingKeyBytes)
	}
	token, err := generateMCPRemoteToken()
	if err != nil {
		return "", err
	}
	// Seal before anything is written, so no plaintext pairing key can reach the
	// disk even transiently. Pure crypto with no side effects, so failing here
	// leaves nothing to unwind.
	ct, nonce, err := sealPairingKey(r.sessionSecret, pc.Key)
	if err != nil {
		return "", fmt.Errorf("server: mcp remote: seal pairing key: %w", err)
	}

	r.lifecycleMu.Lock()
	defer r.lifecycleMu.Unlock()
	// The durable write comes first and is fatal: installing the live entry over
	// a failed write would hand out a working token that the next restart
	// silently revokes.
	if err := r.db.UpsertMCPRemote(ctx, store.MCPRemote{
		AccountID:       accountID,
		Token:           token,
		RelayURL:        pc.RelayURL,
		PairingID:       pc.PairingID,
		PairingKeyCT:    ct,
		PairingKeyNonce: nonce,
	}, time.Now().UTC()); err != nil {
		return "", err
	}
	r.install(accountID, token, pc)
	return token, nil
}

// disable turns the connector off for accountID: the row goes, so the sealed key
// goes with it, and the live entry is torn down so the old token stops
// authenticating immediately rather than at the next restart.
//
// The delete is unconditional rather than skipped when the registry has no live
// entry, which the sibling optimises. That branch would strand exactly the rows
// this project can actually produce: a session-secret rotation leaves rows whose
// keys restore cannot open, so they have no live entry, and "disconnect" has to
// be able to delete them.
//
// It runs BEFORE the teardown and is fatal for the sibling's reason: tearing
// down the client while the row survives leaves a persisted connector and its
// live token for the next restore to resurrect, with the user believing it is
// gone.
func (r *mcpRemoteRegistry) disable(ctx context.Context, accountID string) error {
	r.lifecycleMu.Lock()
	defer r.lifecycleMu.Unlock()
	if err := r.db.DeleteMCPRemote(ctx, accountID); err != nil {
		slog.Error("mcp remote: delete connector", "account_id", accountID, "error", err)
		return err
	}
	r.stop(accountID)
	return nil
}

// lookup resolves a candidate token from a connector URL to its live entry, or
// nil. This is the endpoint's whole authentication step, so both properties
// matter: every comparison is constant-time, and a miss is indistinguishable
// from a hit that failed — the caller returns one uniform rejection either way.
//
// It scans rather than indexing a map by token. A map probe on a secret is a
// hash plus a short-circuiting memequal, which is the one thing this must not
// be, and keying the map by a HASH of the token to dodge that would add a second
// index to keep in step with the first for no gain at this size.
//
// ponytail: O(number of accounts with the connector enabled) per request, which
// on a self-hosted binary is a handful. If that ever stops being true, key the
// map by SHA-256(token) and keep the constant-time compare as the confirmation
// step; do not drop the compare.
func (r *mcpRemoteRegistry) lookup(candidate string) *mcpRemoteEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	// No early exit on a match: breaking out would make the loop's duration
	// depend on where in the map the matching token sits. Position is not a
	// secret, but a loop that always costs the same is easier to keep correct
	// than one that argues about which leaks are harmless.
	var match *mcpRemoteEntry
	for _, entry := range r.byAcc {
		if constantTimeTokenEqual(candidate, entry.token) {
			match = entry
		}
	}
	return match
}

// tokenFor returns accountID's live connector token, for the Settings surface
// that shows the URL. Returning it rather than withholding it is the sibling's
// call and its reasoning holds here: the caller already holds a session for this
// account, the same authority that could mint a fresh one, so withholding only
// forces a user who lost their URL to rotate the connector to get one back.
// Never log the result; render it with textContent.
func (r *mcpRemoteRegistry) tokenFor(accountID string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry, ok := r.byAcc[accountID]
	if !ok {
		return "", false
	}
	return entry.token, true
}

// install adds or replaces accountID's live entry, closing out any predecessor's
// client so a re-enable does not leak the previous connection.
func (r *mcpRemoteRegistry) install(accountID, token string, pc *mcpshim.PairingCode) {
	entry := &mcpRemoteEntry{token: token, client: mcpshim.NewClientFromPairing(pc, nil)}
	r.mu.Lock()
	old := r.byAcc[accountID]
	r.byAcc[accountID] = entry
	r.mu.Unlock()
	closeEntry(old)
}

// stop removes and tears down accountID's live entry, if any.
func (r *mcpRemoteRegistry) stop(accountID string) {
	r.mu.Lock()
	entry := r.byAcc[accountID]
	delete(r.byAcc, accountID)
	r.mu.Unlock()
	closeEntry(entry)
}

// closeEntry revokes an entry and drops its connection, in that order: marking
// it first means a request holding this pointer cannot slip a call in between.
// Closing runs outside the registry lock, because Close talks to the socket and a
// mutex held across that would stall every other account's lookups. A client
// that never dialed has nothing to close.
func closeEntry(entry *mcpRemoteEntry) {
	if entry == nil {
		return
	}
	entry.revoked.Store(true)
	if err := entry.client.Close(); err != nil {
		// No token and no account id: this is a socket teardown, and the only
		// interesting failure is the transport's own.
		slog.Debug("mcp remote: close connector client", "error", err)
	}
}
