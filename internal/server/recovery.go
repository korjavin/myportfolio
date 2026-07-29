package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/korjavin/myportfolio/internal/store"
)

const maxRecoveryBodyBytes = 8 << 10

const (
	// Redemption is throttled per ACCOUNT on top of the per-IP ceremony limiter
	// the routes already sit behind. The two catch opposite attacks and neither
	// substitutes for the other: the IP bucket caps one address spraying many
	// accounts, the account bucket caps many addresses spraying one account —
	// which the IP limiter cannot see at all.
	//
	// Five an hour is generous for someone copying a code off a printed kit and
	// ruinous for a search over 160 bits.
	recoveryAttemptMax    = 5
	recoveryAttemptWindow = time.Hour

	// recoveryGrantTTL bounds the window between redeeming a code and finishing
	// the passkey enrollment it authorises. Long enough to fumble a fingerprint
	// reader, short enough that a grant left in a closed tab is worthless.
	recoveryGrantTTL = 10 * time.Minute

	recoveryChallengeCookie = "myportfolio_recovery_challenge"

	// The account id is Crockford base32 of 80 bits (16 chars). The cap exists
	// because this value is attacker-supplied and becomes a rate-limiter map
	// key — an unbounded one is a memory-growth handle.
	maxAccountIDLen = 64
)

// recoveryRejected is the ONLY negative answer /api/recover ever gives, for a
// wrong code, an account that has no recovery material, and an account id that
// does not exist. Distinguishing them would turn the endpoint into an
// account-existence oracle for anyone who can type an id.
const recoveryRejected = "invalid account id or recovery code"

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

// --- Path C: redeeming the Emergency Kit -----------------------------------
//
// Signup prints a 160-bit recovery code and makes the user tick "I saved it".
// This is the half that makes that promise true. Three steps, and the split is
// forced by WebAuthn's two-phase ceremony, not by taste:
//
//	1. POST /api/recover              — verifier in, envelope_rec + grant out.
//	2. POST /api/recovery/enroll/begin  — grant in, attestation options out.
//	3. POST /api/recovery/enroll/finish — attestation + BOTH envelopes in.
//
// Step 3 writes the new passkey, its envelope, the ROTATED recovery envelope
// and the new verifier hash in one transaction. That is what makes rotation
// non-optional: there is no request ordering in which the user ends up holding
// a working new passkey while the code they just typed into a machine still
// opens the vault.
//
// Deliberately NOT ported from the sibling: transfer slots, the QR hand-off,
// the device list. Those are bead 18h.7. The grant below replaces the sibling's
// slot-backed enrollment token with a stateless HMAC, which is the whole reason
// this path needs no new table and no new migration.

type recoverRequest struct {
	// AccountID is typed off the Emergency Kit. Unlike the sibling project
	// there is no per-account subdomain to resolve it from (ARCHITECTURE.md
	// 8.2), so it travels in the body. It is not a secret — it is an HKDF salt
	// and an AAD field — and a wrong one simply fails the comparison below.
	AccountID string `json:"account_id"`
	// Verifier is HKDF(code, salt=account_id, info="mp/v1/rec-auth"), derived
	// client-side. The recovery code itself never leaves the browser: a
	// different derivation from the same code yields KEK_rec, which is what
	// actually opens the envelope this endpoint returns.
	Verifier []byte `json:"verifier"`
}

type recoverResponse struct {
	Envelope envelopeWire `json:"envelope"`
	Grant    string       `json:"grant"`
}

// redeemRecoveryCode authenticates a recovery attempt and hands back the
// Emergency Kit's envelope plus a short-lived grant for the passkey enrollment
// that must follow.
//
// Handing the envelope to whoever produced a matching verifier is safe by
// construction: it is ciphertext under KEK_rec, and KEK_rec is derived from the
// same code the verifier proves possession of. The server can open neither.
func (a *API) redeemRecoveryCode(w http.ResponseWriter, r *http.Request) {
	var req recoverRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRecoveryBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.AccountID == "" || len(req.AccountID) > maxAccountIDLen ||
		len(req.Verifier) == 0 || len(req.Verifier) > maxVerifierLen {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	// Keyed on the SUBMITTED id, before any lookup — so the throttle behaves
	// identically for an account that exists and one that does not, and cannot
	// be probed by watching when it trips.
	if !a.recoveryLimiter.Allow(req.AccountID) {
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
		return
	}

	stored, err := a.db.RecoveryVerifierHash(r.Context(), req.AccountID)
	if err != nil {
		slog.Error("recover: read verifier hash", "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	hash := sha256.Sum256(req.Verifier)
	// An unknown account (or one that never uploaded recovery material) is
	// compared against a zero hash rather than short-circuited, so the same
	// comparison runs on the same length and the answer is the same 403 either
	// way. SHA-256 of anything is not the zero hash, so this never matches.
	if len(stored) != len(hash) {
		stored = make([]byte, len(hash))
	}
	if subtle.ConstantTimeCompare(stored, hash[:]) != 1 {
		http.Error(w, recoveryRejected, http.StatusForbidden)
		return
	}

	env, err := a.db.GetEnvelope(r.Context(), req.AccountID, store.RecoveryRef)
	if err != nil {
		// Unreachable: SetRecoveryMaterial writes the envelope and the verifier
		// hash in one transaction, so a matching hash implies an envelope. If it
		// ever fires, this account's kit is broken and the operator must know.
		slog.Error("recover: verifier matched but no recovery envelope",
			"account_id", req.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	grant, err := newRecoveryGrant(req.AccountID, a.sessionSecret)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, recoverResponse{
		Envelope: envelopeWire{V: env.V, Nonce: env.Nonce, CT: env.CT, MAC: env.MAC},
		Grant:    grant,
	})
}

type recoveryEnrollBeginRequest struct {
	Grant string `json:"grant"`
}

// recoveryEnrollBegin starts a registration ceremony for an EXISTING account,
// authorised by the grant from redeemRecoveryCode rather than by a session —
// the caller has, by definition, no working credential to hold one.
//
// The options are byte-for-byte signup's: residentKey required (the recovered
// device still needs cold unlock), userVerification required (the PRF output is
// key material), prf requested. Diverging here would enroll a credential the
// rest of the app cannot use.
func (a *API) recoveryEnrollBegin(w http.ResponseWriter, r *http.Request) {
	var req recoveryEnrollBeginRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRecoveryBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	accountID, ok := verifyRecoveryGrant(req.Grant, a.sessionSecret)
	if !ok {
		http.Error(w, "recovery grant invalid or expired", http.StatusForbidden)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	creation, session, err := wa.BeginRegistration(&vaultUser{accountID: accountID},
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithExtensions(protocol.AuthenticationExtensions{"prf": map[string]any{}}),
	)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	challengeID, err := a.recoveryChallenges.put(ceremony{session: *session, accountID: accountID})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	setChallengeCookie(w, recoveryChallengeCookie, "/api/recovery", challengeID)
	writeJSON(w, http.StatusOK, creation)
}

// recoveryEnrollFinishRequest carries everything the rotation needs at once.
//
// Recovery is NOT optional and NOT a follow-up prompt: a request without fresh
// recovery material is rejected, so a client cannot enroll a passkey and then
// "get around to" replacing the code it just burned.
type recoveryEnrollFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
	// Envelope wraps the DEK under the NEW passkey's KEK.
	Envelope envelopeWire `json:"envelope"`
	// Recovery is the replacement Emergency Kit: a fresh envelope_rec and the
	// verifier for a freshly generated code.
	Recovery recoveryMaterialRequest `json:"recovery"`
}

// recoveryEnrollFinish verifies the attestation and commits the whole
// redemption in one transaction: new credential, new envelope, rotated recovery
// envelope, new verifier hash. The old verifier is overwritten in that same
// transaction — that is the burn.
func (a *API) recoveryEnrollFinish(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(recoveryChallengeCookie)
	if err != nil {
		http.Error(w, "missing challenge", http.StatusBadRequest)
		return
	}
	clearChallengeCookie(w, recoveryChallengeCookie, "/api/recovery")

	ceremonyState, ok := a.recoveryChallenges.take(cookie.Value)
	if !ok {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return
	}

	var req recoveryEnrollFinishRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxCeremonyBodyBytes)).Decode(&req); err != nil || len(req.Credential) == 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if !req.Envelope.valid() || !req.Recovery.Envelope.valid() {
		http.Error(w, "envelope field too large or missing", http.StatusBadRequest)
		return
	}
	if len(req.Recovery.Verifier) == 0 || len(req.Recovery.Verifier) > maxVerifierLen {
		http.Error(w, "rotated recovery material is required", http.StatusBadRequest)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}
	cred, err := wa.CreateCredential(&vaultUser{accountID: ceremonyState.accountID}, ceremonyState.session, parsed)
	if err != nil {
		logCeremonyFailure("recovery-enroll", err)
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}

	verifierHash := sha256.Sum256(req.Recovery.Verifier)
	err = a.db.EnrollRecoveredCredential(r.Context(), store.Credential{
		ID:             cred.ID,
		AccountID:      ceremonyState.accountID,
		PublicKey:      cred.PublicKey,
		Transports:     transportsCSV(cred.Transport),
		SignCount:      cred.Authenticator.SignCount,
		BackupEligible: cred.Flags.BackupEligible,
		BackupState:    cred.Flags.BackupState,
	}, store.Envelope{
		AccountID:     ceremonyState.accountID,
		CredentialRef: base64.RawURLEncoding.EncodeToString(cred.ID),
		V:             req.Envelope.V,
		Nonce:         req.Envelope.Nonce,
		CT:            req.Envelope.CT,
		MAC:           req.Envelope.MAC,
	}, store.Envelope{
		V:     req.Recovery.Envelope.V,
		Nonce: req.Recovery.Envelope.Nonce,
		CT:    req.Recovery.Envelope.CT,
		MAC:   req.Recovery.Envelope.MAC,
	}, verifierHash[:], time.Now().UTC())
	if err != nil {
		if errors.Is(err, store.ErrAccountExists) {
			http.Error(w, "already registered", http.StatusConflict)
			return
		}
		slog.Error("recovery enroll: commit", "account_id", ceremonyState.accountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, sessionCookie(newSessionToken(ceremonyState.accountID, cred.ID, a.sessionSecret)))
	writeJSON(w, http.StatusOK, map[string]string{"account_id": ceremonyState.accountID})
}

// newRecoveryGrant mints the token that carries authority from "this caller
// proved they hold the recovery code" to "this caller may enroll a passkey into
// that account". Same shape as a session token — base64url(payload).hex(hmac) —
// but a distinct HMAC key prefix, so neither can ever be presented as the other.
//
// ponytail: stateless, so it is replayable until it expires rather than strictly
// single-use. Nothing is gained by a replay: it can only be obtained by holding
// the recovery code, and the first successful enrollment rotates that code away.
// Make it a stored nonce if the TTL ever needs to grow.
func newRecoveryGrant(accountID, secret string) (string, error) {
	nonce, err := randomToken(16)
	if err != nil {
		return "", err
	}
	payload := fmt.Sprintf("%s|%s|%d", accountID, nonce, time.Now().Unix())
	h := hmac.New(sha256.New, []byte(secret+"|mp/recovery-grant"))
	h.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(h.Sum(nil)), nil
}

func verifyRecoveryGrant(token, secret string) (accountID string, ok bool) {
	rawPayload, sig, found := strings.Cut(token, ".")
	if !found {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(rawPayload)
	if err != nil {
		return "", false
	}
	h := hmac.New(sha256.New, []byte(secret+"|mp/recovery-grant"))
	h.Write(payload)
	want, err := hex.DecodeString(sig)
	if err != nil || !hmac.Equal(h.Sum(nil), want) {
		return "", false
	}
	parts := strings.Split(string(payload), "|")
	if len(parts) != 3 {
		return "", false
	}
	ts, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return "", false
	}
	// Bounded on BOTH sides, for the reason session.go documents: without a
	// future-skew bound, time.Since is negative for a forward-dated token and
	// the TTL check passes forever.
	age := time.Since(time.Unix(ts, 0))
	if age > recoveryGrantTTL || age < -sessionMaxFutureSkew {
		return "", false
	}
	return parts[0], true
}
