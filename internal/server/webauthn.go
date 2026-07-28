package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/korjavin/myportfolio/internal/store"
)

const (
	registerChallengeCookie = "myportfolio_register_challenge"
	loginChallengeCookie    = "myportfolio_login_challenge"
	challengeTTL            = 5 * time.Minute

	// The finish bodies carry an attestation/assertion response (a few KiB)
	// plus, for registration, the first envelope.
	maxCeremonyBodyBytes = 64 << 10

	// Sanity caps on envelope fields. Suite v1 wraps a 256-bit DEK, so real
	// payloads are tiny; these exist to stop abuse, not to encode the format.
	maxNonceLen    = 64
	maxEnvelopeCT  = 4096
	maxMACLen      = 64
	maxVerifierLen = 256
)

// crockfordBase32 spells account ids without the characters people confuse when
// copying one off a printed Emergency Kit (I, L, O, U are absent).
var crockfordBase32 = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// newAccountID mints an 80-bit account id. It is not a secret — it is an HKDF
// salt and an AAD field, both of which only need to be unique — but it is shown
// to the user on the Emergency Kit and typed back during recovery, so it is
// short and transcribable rather than a UUID.
func newAccountID() (string, error) {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return crockfordBase32.EncodeToString(raw), nil
}

func randomToken(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// ceremony is the in-flight WebAuthn state held between begin and finish.
// accountID is set for registration (the server mints it at begin so the client
// can derive its KEK and wrap the DEK before finish) and empty for login, which
// is discoverable and does not know the account until the assertion names it.
type ceremony struct {
	session   webauthn.SessionData
	accountID string
}

// challengeStore holds in-flight ceremonies keyed by a random id carried in a
// short-lived, path-scoped cookie.
//
// ponytail: in-memory and single-process — a restart mid-ceremony just means
// the user taps again. Move it to SQLite only if this ever runs more than one
// replica.
type challengeStore struct {
	mu      sync.Mutex
	entries map[string]challengeEntry
}

type challengeEntry struct {
	value   ceremony
	expires time.Time
}

func newChallengeStore() *challengeStore {
	return &challengeStore{entries: make(map[string]challengeEntry)}
}

func (s *challengeStore) put(v ceremony) (string, error) {
	id, err := randomToken(16)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	// Sweep on write: without it an abandoned ceremony (the overwhelmingly
	// common case — users close the tab) is retained forever.
	for k, e := range s.entries {
		if now.After(e.expires) {
			delete(s.entries, k)
		}
	}
	s.entries[id] = challengeEntry{value: v, expires: now.Add(challengeTTL)}
	return id, nil
}

// take returns and deletes the ceremony for id — single use, whether or not it
// turns out to have expired. This is what makes a replayed finish fail: the
// challenge is gone the first time it is redeemed.
func (s *challengeStore) take(id string) (ceremony, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	delete(s.entries, id)
	if !ok || time.Now().After(e.expires) {
		return ceremony{}, false
	}
	return e.value, true
}

// vaultUser adapts an account to webauthn.User.
type vaultUser struct {
	accountID string
	creds     []webauthn.Credential
}

func (u *vaultUser) WebAuthnID() []byte                         { return []byte(u.accountID) }
func (u *vaultUser) WebAuthnName() string                       { return u.accountID }
func (u *vaultUser) WebAuthnDisplayName() string                { return "myportfolio vault" }
func (u *vaultUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func toWebAuthnCredentials(stored []store.Credential) []webauthn.Credential {
	creds := make([]webauthn.Credential, len(stored))
	for i, c := range stored {
		creds[i] = webauthn.Credential{
			ID:        c.ID,
			PublicKey: c.PublicKey,
			// Flags must round-trip from registration: go-webauthn rejects an
			// assertion whose backup-eligible bit differs from the stored
			// credential, and synced passkeys always assert BE=1.
			Flags:         webauthn.CredentialFlags{BackupEligible: c.BackupEligible, BackupState: c.BackupState},
			Authenticator: webauthn.Authenticator{SignCount: c.SignCount},
		}
	}
	return creds
}

// rpForRequest builds the relying party from the request's own host.
//
// Single origin (ARCHITECTURE.md 8.2): there is exactly one host, so this is
// simply "the origin the browser is talking to" rather than the sibling's
// per-account subdomain scheme. Deriving it from the Host header is safe
// despite that header being attacker-controllable — a forged Host only yields
// credentials scoped to a domain the attacker already controls, which no
// browser will ever hand to the real origin.
func rpForRequest(r *http.Request) (*webauthn.WebAuthn, error) {
	rpID := stripPort(r.Host)
	return webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "myportfolio",
		RPOrigins:     []string{schemeForHost(rpID) + "://" + r.Host},
	})
}

func stripPort(host string) string {
	if i := strings.LastIndex(host, ":"); i != -1 && !strings.Contains(host[i:], "]") {
		return host[:i]
	}
	return host
}

// schemeForHost reports the scheme browsers use to reach host. localhost is a
// secure context over plain HTTP (the local dev loop); everything else is
// served over HTTPS.
func schemeForHost(host string) string {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "http"
	}
	return "https"
}

// logCeremonyFailure surfaces go-webauthn validation failures in the log. The
// HTTP responses are deliberately generic, so without this a real authenticator
// being rejected (flags, origin, signature) is undiagnosable.
func logCeremonyFailure(ceremonyName string, err error) {
	var pErr *protocol.Error
	if errors.As(err, &pErr) {
		slog.Warn("webauthn ceremony failed", "ceremony", ceremonyName, "error", err, "devInfo", pErr.DevInfo)
		return
	}
	slog.Warn("webauthn ceremony failed", "ceremony", ceremonyName, "error", err)
}

// envelopeWire is an envelope on the wire; nonce/ct/mac are base64 via
// encoding/json's []byte handling.
type envelopeWire struct {
	V     int    `json:"v"`
	Nonce []byte `json:"nonce"`
	CT    []byte `json:"ct"`
	MAC   []byte `json:"mac"`
}

func (e envelopeWire) valid() bool {
	return len(e.Nonce) > 0 && len(e.Nonce) <= maxNonceLen &&
		len(e.CT) > 0 && len(e.CT) <= maxEnvelopeCT &&
		len(e.MAC) <= maxMACLen
}

// registerBegin starts a signup ceremony. It mints (but does not persist) an
// account id and returns it as the WebAuthn user handle, so the client can
// derive KEK and wrap the DEK before calling finish — which is what lets finish
// store account + credential + envelope in one transaction.
//
// Nothing is written to the database here, deliberately. An abandoned
// ceremony — including one abandoned because the authenticator turned out not
// to support PRF — must leave no account behind, and unauthenticated requests
// must not be able to create rows.
func (a *API) registerBegin(w http.ResponseWriter, r *http.Request) {
	accountID, err := newAccountID()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	creation, session, err := wa.BeginRegistration(&vaultUser{accountID: accountID},
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			// residentKey required: cold unlock has no account id to look a
			// credential up by, so the credential must be discoverable.
			// userVerification required: the PRF output is the key material,
			// so an unverified assertion must never produce one.
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

	challengeID, err := a.registerChallenges.put(ceremony{session: *session, accountID: accountID})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	setChallengeCookie(w, registerChallengeCookie, "/api/webauthn/register", challengeID)
	writeJSON(w, http.StatusOK, creation)
}

type registerFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
	Envelope   envelopeWire    `json:"envelope"`
}

// registerFinish verifies the attestation against the challenge from
// registerBegin, then creates the account, the credential, and its DEK envelope
// in one transaction, and issues a session.
func (a *API) registerFinish(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(registerChallengeCookie)
	if err != nil {
		http.Error(w, "missing challenge", http.StatusBadRequest)
		return
	}
	clearChallengeCookie(w, registerChallengeCookie, "/api/webauthn/register")

	ceremonyState, ok := a.registerChallenges.take(cookie.Value)
	if !ok {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return
	}

	var req registerFinishRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxCeremonyBodyBytes)).Decode(&req); err != nil || len(req.Credential) == 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if !req.Envelope.valid() {
		http.Error(w, "envelope field too large or missing", http.StatusBadRequest)
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
		logCeremonyFailure("register", err)
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	err = a.db.CreateAccountWithCredential(r.Context(), store.Credential{
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
	}, now)
	if err != nil {
		if errors.Is(err, store.ErrAccountExists) {
			http.Error(w, "already registered", http.StatusConflict)
			return
		}
		slog.Error("register finish: create account", "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, sessionCookie(newSessionToken(ceremonyState.accountID, cred.ID, a.sessionSecret)))
	writeJSON(w, http.StatusOK, map[string]string{"account_id": ceremonyState.accountID})
}

// loginBegin starts a DISCOVERABLE assertion: empty allowCredentials, because
// single origin means the client has no account id to scope the list with
// (ARCHITECTURE.md 8.2). The client adds prf.eval = salt_kek itself at the top
// level; the server never sees a PRF output.
func (a *API) loginBegin(w http.ResponseWriter, r *http.Request) {
	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	assertion, session, err := wa.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	challengeID, err := a.loginChallenges.put(ceremony{session: *session})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	setChallengeCookie(w, loginChallengeCookie, "/api/webauthn/login", challengeID)
	writeJSON(w, http.StatusOK, assertion)
}

type loginFinishResponse struct {
	AccountID string       `json:"account_id"`
	Envelope  envelopeWire `json:"envelope"`
}

// loginFinish verifies the discoverable assertion, then returns the account id
// AND that credential's envelope in the same response.
//
// Returning both is what keeps cold unlock at exactly one assertion
// (ARCHITECTURE.md 8.2): the client cannot ask for its envelope first because
// it does not know which account it belongs to, and asking afterwards would be
// a second round trip. The envelope is ciphertext the server cannot open, so
// handing it to a caller who has just proven possession of the credential it is
// wrapped for costs nothing.
func (a *API) loginFinish(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(loginChallengeCookie)
	if err != nil {
		http.Error(w, "missing challenge", http.StatusBadRequest)
		return
	}
	clearChallengeCookie(w, loginChallengeCookie, "/api/webauthn/login")

	ceremonyState, ok := a.loginChallenges.take(cookie.Value)
	if !ok {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	// go-webauthn parses r.Body with no cap of its own; bound the
	// unauthenticated assertion before it is decoded into memory.
	r.Body = http.MaxBytesReader(w, r.Body, maxCeremonyBodyBytes)

	var accountID string
	cred, err := wa.FinishDiscoverableLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
		id, err := a.db.AccountByCredentialID(r.Context(), rawID)
		if err != nil {
			return nil, err
		}
		creds, err := a.db.CredentialsByAccount(r.Context(), id)
		if err != nil {
			return nil, err
		}
		accountID = id
		return &vaultUser{accountID: id, creds: toWebAuthnCredentials(creds)}, nil
	}, ceremonyState.session, r)
	if err != nil {
		logCeremonyFailure("login", err)
		http.Error(w, "login failed", http.StatusBadRequest)
		return
	}

	// Recorded, not enforced — platform authenticators report 0 forever, so a
	// counter regression is not evidence of a clone (bead A4).
	if err := a.db.TouchCredential(r.Context(), cred.ID, cred.Authenticator.SignCount, time.Now().UTC()); err != nil {
		slog.Error("login finish: touch credential", "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	env, err := a.db.GetEnvelope(r.Context(), accountID, base64.RawURLEncoding.EncodeToString(cred.ID))
	if err != nil {
		// Unreachable by construction: registration writes credential and
		// envelope in one transaction. If it ever happens, the account cannot
		// be unlocked by this credential and the operator needs to know.
		slog.Error("login finish: envelope missing for registered credential",
			"account_id", accountID, "error", err, "no_rows", errors.Is(err, sql.ErrNoRows))
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, sessionCookie(newSessionToken(accountID, cred.ID, a.sessionSecret)))
	writeJSON(w, http.StatusOK, loginFinishResponse{
		AccountID: accountID,
		Envelope:  envelopeWire{V: env.V, Nonce: env.Nonce, CT: env.CT, MAC: env.MAC},
	})
}

func setChallengeCookie(w http.ResponseWriter, name, path, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(challengeTTL.Seconds()),
	})
}

func clearChallengeCookie(w http.ResponseWriter, name, path string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func transportsCSV(t []protocol.AuthenticatorTransport) string {
	if len(t) == 0 {
		return ""
	}
	strs := make([]string, len(t))
	for i, x := range t {
		strs[i] = string(x)
	}
	return strings.Join(strs, ",")
}
