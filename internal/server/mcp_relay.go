package server

// The blind MCP relay (ARCHITECTURE.md §11 — normative; do not re-derive the
// close codes or the leg paths from this file). It pipes opaque encrypted
// frames between a paired shim process (Claude Desktop/Code, off-device, see
// internal/mcpshim) and the account's unlocked browser tab, which is the thing
// that can actually answer.
//
// The relay holds no key and opens no frame. It sees ciphertext sizes, timing
// and pairing ids and nothing else — that metadata delta is stated honestly in
// §11 and in the user-facing security note. Nothing in this file may grow a
// call that decodes a frame body: the whole connector exists because the server
// cannot.
//
// Ported from medicationtrackerbot's internal/cloudserver/mcp_relay.go, minus
// its Tier 2 hosted-remote machinery (persisted pairings, permanent pairings,
// the lifecycle-lock mutation hook) — we have no hosted mode, and the pairing
// table is deliberately in-memory: a restart drops every pairing and the 4404
// path exists precisely to tell the browser so.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// relayEndpoint is the path a pairing code's relay_url ends in — the relay
// ENDPOINT, not an origin (§11 "relay_url is the endpoint, not the origin").
// Each leg appends only its own segment, and the Tier-2 SSRF check
// (relayURLIsSelf) accepts nothing else.
const relayEndpoint = "/api/mcp/relay"

const (
	// pairingTTL ages out a pairing the user minted and never used. Re-pairing
	// is a paste of a fresh code, so the cost of expiry is low and the cost of
	// an immortal in-memory credential is not.
	//
	// It is an IDLE timeout, not a lifetime: every relayed frame pushes the
	// expiry a full pairingTTL out (pairingTable.touch), so a pairing someone
	// actually uses never expires under them. Minted-and-never-used, and
	// used-then-abandoned, both still age out — the entry is a live route
	// someone could dial, so unbounded extension is not on the table.
	pairingTTL          = 24 * time.Hour
	pairingCleanupEvery = time.Hour
	pairingIDBytes      = 16

	// maxRelayFrameBytes caps ONE relayed message. coder/websocket's
	// SetReadLimit measures the whole message, and a frame is
	// nonce ‖ ciphertext ‖ tag, so the largest payload that fits is
	// maxRelayFrameBytes - mcpshim.FrameOverheadBytes = 65508 — not 65536.
	// That arithmetic lives in mcpshim (FrameOverheadBytes) and is pinned here
	// by TestRelayFrameCapMatchesTheShimContract rather than restated, because
	// C2/C3/C4 each deriving it independently is how one of them ends up 28
	// bytes off and silently drops exactly the largest answers.
	//
	// ponytail: kept in lockstep with internal/mcpshim's maxFrameBytes by hand
	// and by that test — the shim must stay buildable as a standalone client,
	// so it cannot import this package and this package must not depend on the
	// shim outside tests.
	maxRelayFrameBytes = 64 << 10

	// relayWriteTimeout bounds a single pipe write. Without it a peer that
	// keeps its socket open but stops reading wedges the other leg's goroutine
	// in Write forever: the request context has no deadline and only cancels
	// when the writer's own handler returns — which it cannot, because it is
	// stuck in Write.
	relayWriteTimeout = 30 * time.Second

	// relayFrameMax/-Window bound how many frames one PAIRING may push through
	// per window. Generous for interactive tool calls (a call is two frames)
	// while capping a runaway shim or tab.
	//
	// Keyed on the pairing id, not on clientIP: both legs of a pairing are the
	// same user, and the abuse this stops is one pairing spinning, not one
	// address. It is a second INSTANCE of rate_limit.go's limiter, never a
	// second implementation — the same rule recoveryLimiter follows.
	relayFrameMax    = 120
	relayFrameWindow = 10 * time.Second
)

// StatusNoPairing tells the browser responder that this account has no live
// pairing at all, so it must stop reconnecting AND purge its vault record: that
// record is a tombstone pointing at nothing.
//
// It has to be a close code rather than an HTTP status. A browser WebSocket
// cannot observe the handshake response, so rejecting the upgrade with a 404 is
// indistinguishable from a network drop and the tab retries forever — and with
// an in-memory pairing table every restart strands one. Close codes ARE visible,
// in onclose's `code`. 4404/4409 are in RFC 6455 §7.4.2's application range.
const StatusNoPairing websocket.StatusCode = 4404

// StatusPairingReplaced tells the browser responder that the account DOES have a
// live pairing but this leg is not serving it, so it must stop — and must NOT
// purge. The vault record already names the replacement pairing (or will, once
// this device syncs); the record is CRDT-synced, so purging here deletes the
// pairing every other device just adopted, account-wide.
//
// A leg presenting NO pairing id takes this path, not 4404: it cannot prove
// which pairing it holds, so it is not evidence that no pairing exists.
//
// Sent from two places, and both are needed:
//
//   - deviceSocket, rejecting a leg whose pairing id is stale or absent.
//   - pairingRecord.join, closing the device leg a newer one just evicted.
//
// The second is the non-obvious one. Two legitimate devices (phone and laptop,
// both unlocked) each pass the id check and take turns evicting each other. An
// abrupt close reaches the browser as 1006, which reads as a transient drop and
// gets retried — re-evicting the replacement, forever. 4409 tells the loser to
// step aside.
const StatusPairingReplaced websocket.StatusCode = 4409

type createPairingResponse struct {
	PairingID string `json:"pairing_id"`
}

// createPairing mints a pairing id for the caller's account, replacing any
// pairing it already had (one pairing per account; §11's standing limitation).
//
// The pairing KEY never reaches this endpoint: it is 32 bytes generated in the
// browser and folded into the one-time code the user pastes into the shim. The
// response carries the id and nothing else, and that is the property
// TestRelayNeverSeesTheKey pins.
func (a *API) createPairing(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, createPairingResponse{PairingID: a.pairings.mint(session.AccountID)})
}

// deletePairing revokes the caller's pairing, if any, and drops both legs.
func (a *API) deletePairing(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	a.pairings.revoke(session.AccountID)
	w.WriteHeader(http.StatusNoContent)
}

// deviceSocket is the browser-tab leg: the unlocked PWA connects here to answer
// relayed tool calls. The session cookie authenticates it; the pairing id in the
// query says only WHICH pairing this tab believes it holds, so a tab still
// holding a pre-re-pair id cannot squat the current pairing's device slot (join
// is last-writer-wins and would evict the tab that actually holds the key).
func (a *API) deviceSocket(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Accept the upgrade BEFORE any check: the caller is a browser and cannot
	// read a handshake status, so every rejection below has to be an
	// application close code.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	record, ok := a.pairings.byAccountID(session.AccountID)
	if !ok {
		conn.Close(StatusNoPairing, "no active pairing for this account")
		return
	}
	if r.URL.Query().Get("pairing") != record.id {
		conn.Close(StatusPairingReplaced, "pairing replaced")
		return
	}
	a.serveLeg(r.Context(), conn, record, true)
}

// shimSocket is the local mcpshim leg, authenticated by possession of the
// pairing id alone — the shim is a separate process with no cookie jar, and the
// pairing KEY (which the relay never sees) is the actual secret.
//
// This one rejects at the handshake, unlike deviceSocket: the caller is a Go
// client that reads the response, so a 401 is both visible and actionable.
func (a *API) shimSocket(w http.ResponseWriter, r *http.Request) {
	record, ok := a.pairings.byPairingID(r.URL.Query().Get("pairing"))
	if !ok {
		http.Error(w, "unknown or expired pairing", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	a.serveLeg(r.Context(), conn, record, false)
}

// serveLeg pipes conn's incoming frames to its peer, opaque and unbuffered,
// until either side errors or drops — then closes both ends. Each leg runs its
// own serveLeg in its own request goroutine, so full duplex falls out of the two
// directions running concurrently, with no buffering beyond the one in-flight
// frame each Read/Write pair carries.
//
// There is deliberately no "wait for a peer, then time out" phase, which is
// where the port had one. The steady state here is a tab open all day with no
// shim attached — Claude Desktop connects only when the user asks something —
// so evicting a peerless leg after 60s would make the normal case a permanent
// reconnect loop. A peerless leg simply drops frames: the shim's own
// CallTimeout turns that into §11's ErrDeviceOffline, which is the documented
// behaviour anyway. Idle legs stay bounded by the pairing's 24h TTL, which
// closes them on expiry.
func (a *API) serveLeg(ctx context.Context, conn *websocket.Conn, record *pairingRecord, isDevice bool) {
	defer conn.CloseNow()
	conn.SetReadLimit(maxRelayFrameBytes)

	record.join(isDevice, conn)
	defer record.clear(isDevice, conn)

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			record.retirePeer(isDevice, conn)
			return
		}
		// A frame arrived, so this pairing is in use: push its idle expiry out.
		// Without this the TTL runs from the mint and a pairing dies mid-session
		// a day after pairing, which the shim then reports as gone.
		a.pairings.touch(record)
		if !a.relayLimiter.Allow(record.id) {
			conn.Close(websocket.StatusPolicyViolation, "rate limit exceeded")
			if peer := record.peerConn(isDevice); peer != nil {
				peer.Close(websocket.StatusPolicyViolation, "peer rate limited")
			}
			return
		}
		// Re-read the peer each frame rather than caching it: when the peer
		// reconnects, join swaps a fresh conn into its slot and a cached pointer
		// would keep writing the evicted, dead one — breaking the bridge one-way
		// until a full teardown.
		peer := record.peerConn(isDevice)
		if peer == nil {
			// Nobody home. Drop the frame and keep serving so a reconnecting
			// peer re-bridges without tearing this leg down; a genuinely-gone
			// peer's own read-error path closes us.
			continue
		}
		wctx, cancel := context.WithTimeout(ctx, relayWriteTimeout)
		err = peer.Write(wctx, typ, data)
		cancel()
		if err != nil {
			// The conn we wrote to is dead, but it may be an evicted one
			// mid-replacement. Drop the frame; the next one re-reads the current
			// peer.
			continue
		}
	}
}

// pairingRecord is one account's pairing: an id, the account that minted it, an
// expiry, and at most one live device leg plus one live shim leg. One device leg
// per pairing is §11's standing limitation and is not fixed here.
type pairingRecord struct {
	id        string
	accountID string

	mu sync.Mutex
	// expiresAt is under mu because a relayed frame extends it (touch) from a
	// leg's goroutine while the sweep and both lookups read it.
	expiresAt time.Time
	device    *websocket.Conn
	shim      *websocket.Conn
}

func (p *pairingRecord) isExpired(now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return now.After(p.expiresAt)
}

// join registers conn as this pairing's device or shim leg, closing out whatever
// already occupied that slot.
//
// The evicted leg's serveLeg observes the read error and returns; its
// record.current check keeps it from closing the peer, which the replacement now
// bridges to.
func (p *pairingRecord) join(isDevice bool, conn *websocket.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if isDevice {
		closeLeg(p.device, StatusPairingReplaced, "replaced by a newer device leg")
		p.device = conn
		return
	}
	closeLeg(p.shim, StatusPairingReplaced, "replaced by a newer shim leg")
	p.shim = conn
}

// closeLeg closes an evicted or revoked leg with a code the responder can act
// on, always in a goroutine: a graceful close blocks on the WebSocket close
// handshake (seconds, against an unresponsive peer) and every caller holds a
// mutex — closing inline would stall the pairing under reconnect churn, and
// closeLegs would stall every account's pairing endpoints.
func closeLeg(conn *websocket.Conn, code websocket.StatusCode, reason string) {
	if conn != nil {
		go conn.Close(code, reason)
	}
}

// retirePeer tears down the bridge conn was half of: it closes the opposite leg
// and DEREGISTERS it, all under one lock.
//
// It does nothing unless conn is still the pairing's registered leg. If a newer
// connection evicted us, the replacement owns the bridge now and closing the peer
// would kill the live bridge, not just our dead half.
//
// Deregistering the peer is the load-bearing half, and it is what makes that
// guard cover the CASCADE as well as eviction. Without it a teardown bounces
// through a third leg: the device drops, so the relay closes the shim leg; the
// browser tab reconnects and its fresh device leg registers; then the shim leg's
// own read finally fails, it is still registered (nothing evicted it), and it
// closes whatever is in the device slot — which is now the FRESH tab, not the
// dead one it was bridged to. The shim's next call then finds an empty device
// slot, its frame is dropped by the "Nobody home" branch below, and it burns the
// full 30s CallTimeout to report "no unlocked device is online" while a perfectly
// good tab sits there — the same unattributable symptom §11 keeps having to stamp
// out. Clearing the peer as we close it means its own serveLeg finds itself no
// longer registered and stops the bounce there: a leg the relay has already
// retired owns nothing left to tear down.
//
// Pinned by TestATeardownDoesNotBounceIntoAReconnectedLeg, which sequences the
// interleaving load used to produce by chance.
func (p *pairingRecord) retirePeer(isDevice bool, conn *websocket.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if isDevice {
		if p.device != conn {
			return
		}
		closeLeg(p.shim, websocket.StatusNormalClosure, "peer disconnected")
		p.shim = nil
		return
	}
	if p.shim != conn {
		return
	}
	closeLeg(p.device, websocket.StatusNormalClosure, "peer disconnected")
	p.device = nil
}

// peerConn returns the opposite leg's live conn, or nil. Called per frame so a
// peer reconnect is picked up transparently instead of writing a cached, evicted
// conn.
func (p *pairingRecord) peerConn(isDevice bool) *websocket.Conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	if isDevice {
		return p.shim
	}
	return p.device
}

// clear drops conn from whichever leg it occupies, unless a newer connection has
// already replaced it there.
func (p *pairingRecord) clear(isDevice bool, conn *websocket.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if isDevice && p.device == conn {
		p.device = nil
	}
	if !isDevice && p.shim == conn {
		p.shim = nil
	}
}

// closeLegs drops both live connections because the pairing itself is gone
// (revoked, replaced or expired). code carries WHY, and the two reasons are not
// interchangeable — see StatusNoPairing and StatusPairingReplaced. Getting this
// wrong makes a browser purge a CRDT-synced pairing record that other devices
// are using.
func (p *pairingRecord) closeLegs(code websocket.StatusCode, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	closeLeg(p.device, code, reason)
	// The shim is a Go client, not a browser: 4404/4409 mean nothing to it
	// today (its Client redials on any close — bd myportfolio-ybp.8 tracks
	// teaching it otherwise), but sending the same code costs nothing and
	// leaves the wire honest for when it does.
	closeLeg(p.shim, code, reason)
	p.device, p.shim = nil, nil
}

// pairingTable is the process-lifetime pairing store: one active pairing per
// account.
//
// ponytail: in-memory on purpose. A restart drops every pairing and the user
// re-pairs; persisting them buys little, and StatusNoPairing exists precisely so
// the browser learns its record is a tombstone instead of retrying forever.
type pairingTable struct {
	ttl time.Duration
	// now is the table's clock, time.Now everywhere but in tests. Expiry is the
	// one behaviour here that cannot be observed without waiting for it, and a
	// test that really sleeps past a TTL is either slow or flaky.
	now func() time.Time

	mu    sync.Mutex
	byID  map[string]*pairingRecord
	byAcc map[string]*pairingRecord
}

func newPairingTable(ttl time.Duration) *pairingTable {
	t := &pairingTable{
		ttl:   ttl,
		now:   time.Now,
		byID:  make(map[string]*pairingRecord),
		byAcc: make(map[string]*pairingRecord),
	}
	t.startCleanup()
	return t
}

// touch resets rec's idle expiry to a full TTL from now, so a pairing carrying
// traffic never ages out mid-use. Called per relayed frame from either leg (see
// serveLeg) — cheap, and the only thing standing between a working pairing and
// the 4404 it used to get a day after minting.
//
// Deliberately NOT called when a leg merely connects: the PWA tab reconnects on
// its own and would keep an abandoned pairing alive forever. Frames mean a
// person is asking something.
// It extends a LIVE pairing only. Expiry has to be monotone: the sweep runs
// hourly while every lookup rejects an expired record on sight, so without this
// guard a leg that stayed connected across the expiry instant could renew inside
// that grace window — once a day, forever — resurrecting a pairing no fresh dial
// could reach. An already-expired record is left exactly as the sweep will find
// it. (Inlined rather than calling isExpired: sync.Mutex does not re-enter.)
func (t *pairingTable) touch(rec *pairingRecord) {
	now := t.now()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if now.After(rec.expiresAt) {
		return
	}
	rec.expiresAt = now.Add(t.ttl)
}

// startCleanup sweeps expired pairings, mirroring rateLimiter.startCleanup —
// without it a long-lived process keeps one dead entry per pairing ever minted.
func (t *pairingTable) startCleanup() {
	ticker := time.NewTicker(pairingCleanupEvery)
	go func() {
		for range ticker.C {
			t.cleanup()
		}
	}()
}

func (t *pairingTable) cleanup() {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, rec := range t.byID {
		if rec.isExpired(now) {
			delete(t.byID, id)
			delete(t.byAcc, rec.accountID)
			// An expired pairing leaves the account with no pairing at all, so
			// the record really is a tombstone: purge.
			rec.closeLegs(StatusNoPairing, "pairing expired")
		}
	}
}

// mint creates a fresh pairing for accountID, replacing any the account held.
func (t *pairingTable) mint(accountID string) string {
	id := generatePairingID()
	rec := &pairingRecord{id: id, accountID: accountID, expiresAt: t.now().Add(t.ttl)}

	t.mu.Lock()
	defer t.mu.Unlock()
	if old, ok := t.byAcc[accountID]; ok {
		delete(t.byID, old.id)
		// 4409, not 4404: the account still HAS a pairing — this one. A device
		// still on the old id must step aside without purging, or it deletes the
		// record every other device is about to adopt.
		old.closeLegs(StatusPairingReplaced, "pairing replaced by a newer one")
	}
	t.byID[id] = rec
	t.byAcc[accountID] = rec
	return id
}

// revoke drops accountID's pairing, if any, closing both legs.
func (t *pairingTable) revoke(accountID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byAcc[accountID]
	if !ok {
		return
	}
	delete(t.byAcc, accountID)
	delete(t.byID, rec.id)
	// 4404: the account now has no pairing at all, so the browser's vault record
	// points at nothing and should be purged.
	rec.closeLegs(StatusNoPairing, "pairing revoked")
}

// byPairingID looks up a pairing by id — the shim leg's only credential.
func (t *pairingTable) byPairingID(id string) (*pairingRecord, bool) {
	if id == "" {
		return nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byID[id]
	if !ok || rec.isExpired(t.now()) {
		return nil, false
	}
	return rec, true
}

// byAccountID looks up the caller's pairing — the device leg's entry point,
// reached via its session rather than via the id.
func (t *pairingTable) byAccountID(accountID string) (*pairingRecord, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byAcc[accountID]
	if !ok || rec.isExpired(t.now()) {
		return nil, false
	}
	return rec, true
}

func generatePairingID() string {
	b := make([]byte, pairingIDBytes)
	if _, err := rand.Read(b); err != nil {
		panic("server: mcp relay: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
