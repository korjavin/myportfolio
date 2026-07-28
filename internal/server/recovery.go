package server

import (
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/korjavin/myportfolio/internal/store"
)

const maxRecoveryBodyBytes = 8 << 10

type recoveryMaterialRequest struct {
	Envelope envelopeWire `json:"envelope"`
	// Verifier is the PLAINTEXT verifier, HKDF'd client-side from the recovery
	// code. The server hashes it and keeps only the hash, so the stored value
	// cannot be replayed as a recovery attempt by whoever reads the database.
	// The recovery code itself never leaves the client at all — a different
	// derivation from the same code produces KEK_rec, which is what actually
	// unwraps the envelope below.
	Verifier []byte `json:"verifier"`
}

// putRecoveryMaterial stores the Emergency Kit's envelope and SHA-256(verifier)
// atomically. Signup calls it before showing the kit, so a failure leaves no
// half-written recovery pair and the user is never shown a code that would not
// work.
func (a *API) putRecoveryMaterial(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req recoveryMaterialRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRecoveryBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if !req.Envelope.valid() {
		http.Error(w, "envelope field too large or missing", http.StatusBadRequest)
		return
	}
	if len(req.Verifier) == 0 || len(req.Verifier) > maxVerifierLen {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	hash := sha256.Sum256(req.Verifier)
	if err := a.db.SetRecoveryMaterial(r.Context(), session.AccountID, store.Envelope{
		V:     req.Envelope.V,
		Nonce: req.Envelope.Nonce,
		CT:    req.Envelope.CT,
		MAC:   req.Envelope.MAC,
	}, hash[:]); err != nil {
		slog.Error("recovery material: write", "account_id", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
