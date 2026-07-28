package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/myportfolio/internal/store"
)

// Size limits on the state blob (ARCHITECTURE.md 6).
//
// The relationship between these two numbers is the whole point. `ct` arrives
// as base64 inside JSON, so the request BODY holds roughly 4/3 of the decoded
// ciphertext plus scaffolding. If the body cap were the smaller of the two, the
// real ceiling would silently be ~3/4 of the advertised one and an oversized
// upload would be rejected as a malformed body rather than as a too-large blob
// — which is exactly the bug the sibling project shipped. 24 MiB comfortably
// covers base64 of a full 16 MiB ciphertext (~21.4 MiB), so the CT cap is what
// actually binds.
//
// A portfolio blob is gzip-compressed JSON for a few thousand records: single
// -digit megabytes at the very worst, orders of magnitude under this.
const (
	maxStateBodyBytes = 24 << 20 // 24 MiB request body
	maxStateCTBytes   = 16 << 20 // 16 MiB decoded ciphertext — the per-account quota
)

// stateWire is the blob on the wire. nonce/ct are base64 via encoding/json's
// []byte handling.
//
// `version` means different things by direction, and the difference is pinned:
// on a GET response it is the version the blob IS stored as; on a PUT request
// it is the version the client LAST READ, which the server compares and swaps
// against. The client binds last-read+1 into the ciphertext's AAD, because that
// is the version the blob will end up stored as.
type stateWire struct {
	Version int64  `json:"version"`
	Nonce   []byte `json:"nonce"`
	CT      []byte `json:"ct"`
}

// getState returns the caller's current blob, or 204 when the account has never
// uploaded one — which is how a fresh client learns its last-read version is 0.
func (a *API) getState(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	blob, err := a.db.GetState(r.Context(), session.AccountID)
	if err != nil {
		slog.Error("state: read", "account_id", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if blob == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, stateWire{Version: blob.Version, Nonce: blob.Nonce, CT: blob.CT})
}

// putState is the compare-and-swap upload. The body's `version` is the version
// the caller last read; on a match the blob is stored as version+1 and the
// answer is 204.
//
// On a mismatch the answer is 409 carrying the CURRENT blob. The server does
// not, and cannot, merge — it holds ciphertext. The client decrypts both sides,
// unions by recordId resolving collisions by clientTs, and retries
// (ARCHITECTURE.md 6, bead A6).
func (a *API) putState(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxStateBodyBytes)
	var req stateWire
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Version < 0 || len(req.Nonce) == 0 || len(req.Nonce) > maxNonceLen || len(req.CT) == 0 {
		http.Error(w, "state field missing or malformed", http.StatusBadRequest)
		return
	}
	if len(req.CT) > maxStateCTBytes {
		// The only trace a quota rejection leaves. Without it, "my data stopped
		// syncing" is untraceable: the 413 is answered and forgotten.
		slog.Warn("state: per-account quota exceeded",
			"account_id", session.AccountID, "ct_bytes", len(req.CT), "quota_bytes", maxStateCTBytes)
		http.Error(w, "account storage quota exceeded", http.StatusRequestEntityTooLarge)
		return
	}

	// The stored blob is discarded on success: the caller already holds the
	// plaintext it just encrypted, and 204 tells it the version it computed
	// (last-read + 1) is the one now on the server.
	if current, err := a.db.PutState(r.Context(), session.AccountID, req.Version, req.Nonce, req.CT, time.Now().UTC()); err != nil {
		if errors.Is(err, store.ErrVersionConflict) {
			// `current` is the winner's blob, read inside the same transaction
			// that rejected this write, so the loser is handed exactly the
			// state it has to merge against. It is nil only when the caller
			// claimed a version for a blob that does not exist at all.
			conflict := stateWire{}
			if current != nil {
				conflict = stateWire{Version: current.Version, Nonce: current.Nonce, CT: current.CT}
			}
			writeJSON(w, http.StatusConflict, conflict)
			return
		}
		slog.Error("state: write", "account_id", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
