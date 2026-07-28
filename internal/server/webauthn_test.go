package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/descope/virtualwebauthn"

	"github.com/korjavin/myportfolio/internal/store"
)

const (
	testSessionSecret = "test-session-secret-at-least-32-bytes-long"
	// A *.localhost host, so schemeForHost picks http and the virtual
	// authenticator's origin matches what the server expects.
	testHost = "vault.localhost"
)

// vault is a server plus its database, with helpers that drive whole ceremonies
// the way a browser would.
type vault struct {
	t  *testing.T
	h  http.Handler
	db *store.DB
}

func newVault(t *testing.T) *vault {
	t.Helper()
	db, err := store.Open(context.Background(), t.TempDir()+"/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return &vault{t: t, h: New(testFS(), db, testSessionSecret, defaultTrustedProxies), db: db}
}

func (v *vault) do(method, path string, body any, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	v.t.Helper()
	var reader *bytes.Reader
	switch b := body.(type) {
	case nil:
		reader = bytes.NewReader(nil)
	case string:
		reader = bytes.NewReader([]byte(b))
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			v.t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Host = testHost
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		if c != nil {
			req.AddCookie(c)
		}
	}
	rec := httptest.NewRecorder()
	v.h.ServeHTTP(rec, req)
	return rec
}

func cookieNamed(rec *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == name && c.Value != "" {
			return c
		}
	}
	return nil
}

func testRP() virtualwebauthn.RelyingParty {
	return virtualwebauthn.RelyingParty{Name: "myportfolio", ID: testHost, Origin: "http://" + testHost}
}

// device is one virtual authenticator holding one credential, i.e. one user's
// phone. Its UserHandle is what makes the discoverable (empty
// allowCredentials) cold-unlock assertion resolvable.
type device struct {
	auth virtualwebauthn.Authenticator
	cred virtualwebauthn.Credential
}

// signup drives the whole A3 ceremony: register/begin, attestation, then
// register/finish carrying the first envelope. Returns the account id, the
// session cookie, and the virtual device.
func (v *vault) signup() (string, *http.Cookie, *device) {
	v.t.Helper()

	beginRec := v.do(http.MethodPost, "/api/webauthn/register/begin", nil)
	if beginRec.Code != http.StatusOK {
		v.t.Fatalf("register/begin = %d, body %q", beginRec.Code, beginRec.Body.String())
	}
	opts, err := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	if err != nil {
		v.t.Fatalf("ParseAttestationOptions: %v", err)
	}
	challenge := cookieNamed(beginRec, registerChallengeCookie)
	if challenge == nil {
		v.t.Fatal("register/begin set no challenge cookie")
	}

	// The user handle IS the account id the server minted at begin — the client
	// reads it from user.id to derive its KEK before finish.
	d := &device{
		auth: virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{
			UserHandle: []byte(opts.UserID),
		}),
		cred: virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2),
	}
	response := virtualwebauthn.CreateAttestationResponse(testRP(), d.auth, d.cred, *opts)

	finishRec := v.do(http.MethodPost, "/api/webauthn/register/finish", registerFinishRequest{
		Credential: json.RawMessage(response),
		Envelope:   envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("wrapped-dek-ciphertext"), MAC: []byte("audit-mac")},
	}, challenge)
	if finishRec.Code != http.StatusOK {
		v.t.Fatalf("register/finish = %d, body %q", finishRec.Code, finishRec.Body.String())
	}
	var out map[string]string
	if err := json.Unmarshal(finishRec.Body.Bytes(), &out); err != nil {
		v.t.Fatalf("decode finish body: %v", err)
	}
	session := cookieNamed(finishRec, SessionCookieName)
	if session == nil {
		v.t.Fatal("register/finish minted no session cookie")
	}
	return out["account_id"], session, d
}

func TestSignup_FullCeremony(t *testing.T) {
	v := newVault(t)
	accountID, session, d := v.signup()

	if accountID == "" {
		t.Fatal("register/finish returned no account_id")
	}
	// The session cookie must actually verify under the server's secret and
	// name both the account and the credential that just registered.
	gotAccount, gotCred, ok := verifySessionToken(session.Value, testSessionSecret)
	if !ok || gotAccount != accountID || !bytes.Equal(gotCred, d.cred.ID) {
		t.Fatalf("session token: ok=%v account=%q cred=%x (want %q / %x)", ok, gotAccount, gotCred, accountID, d.cred.ID)
	}

	// Credential AND envelope landed — the atomic write that stops a passkey
	// existing with no DEK to unwrap.
	creds, err := v.db.CredentialsByAccount(t.Context(), accountID)
	if err != nil || len(creds) != 1 {
		t.Fatalf("CredentialsByAccount = %d creds, err %v; want 1", len(creds), err)
	}
	if _, err := v.db.GetEnvelope(t.Context(), accountID, base64.RawURLEncoding.EncodeToString(d.cred.ID)); err != nil {
		t.Fatalf("GetEnvelope after signup: %v", err)
	}
}

// The ceremony options are the security contract with the authenticator:
// residentKey=required is what makes cold unlock possible at all, and the prf
// extension is what makes the whole key hierarchy possible.
func TestRegisterBegin_DemandsResidentKeyUserVerificationAndPRF(t *testing.T) {
	v := newVault(t)
	rec := v.do(http.MethodPost, "/api/webauthn/register/begin", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`"residentKey":"required"`, `"userVerification":"required"`, `"prf"`} {
		if !strings.Contains(body, want) {
			t.Errorf("register/begin options missing %s: %s", want, body)
		}
	}
}

// The challenge cookie is the single-use token of this ceremony: replaying a
// finish must fail even with a byte-identical, validly-signed attestation.
func TestRegisterFinish_ChallengeIsSingleUse(t *testing.T) {
	v := newVault(t)

	beginRec := v.do(http.MethodPost, "/api/webauthn/register/begin", nil)
	opts, err := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	challenge := cookieNamed(beginRec, registerChallengeCookie)
	auth := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{UserHandle: []byte(opts.UserID)})
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	response := virtualwebauthn.CreateAttestationResponse(testRP(), auth, cred, *opts)

	finish := func() int {
		return v.do(http.MethodPost, "/api/webauthn/register/finish", registerFinishRequest{
			Credential: json.RawMessage(response),
			Envelope:   envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("ct"), MAC: []byte("mac")},
		}, challenge).Code
	}
	if got := finish(); got != http.StatusOK {
		t.Fatalf("first register/finish = %d", got)
	}
	if got := finish(); got != http.StatusBadRequest {
		t.Fatalf("replayed register/finish = %d, want 400", got)
	}
}

func TestRegisterFinish_RejectsForeignOrigin(t *testing.T) {
	v := newVault(t)

	beginRec := v.do(http.MethodPost, "/api/webauthn/register/begin", nil)
	opts, _ := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	challenge := cookieNamed(beginRec, registerChallengeCookie)

	evil := virtualwebauthn.RelyingParty{Name: "myportfolio", ID: testHost, Origin: "https://evil.example.com"}
	auth := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{UserHandle: []byte(opts.UserID)})
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	response := virtualwebauthn.CreateAttestationResponse(evil, auth, cred, *opts)

	rec := v.do(http.MethodPost, "/api/webauthn/register/finish", registerFinishRequest{
		Credential: json.RawMessage(response),
		Envelope:   envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("ct"), MAC: []byte("mac")},
	}, challenge)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("register/finish from a foreign origin = %d, want 400", rec.Code)
	}
}

// The PRF capability gate: a client that discovers its brand-new credential has
// no PRF output abandons the ceremony BEFORE calling finish. Nothing may be
// left behind — no account, no credential, no envelope — because a half-created
// account with a non-PRF credential can never be unlocked.
func TestRegisterBegin_AbandonedCeremonyWritesNothing(t *testing.T) {
	v := newVault(t)

	rec := v.do(http.MethodPost, "/api/webauthn/register/begin", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin = %d", rec.Code)
	}
	opts, _ := virtualwebauthn.ParseAttestationOptions(rec.Body.String())

	// ...client calls create(), gets no prf.results.first, deletes the
	// credential and stops here. No finish call is ever made.

	var accounts, credentials, envelopes int
	if err := v.db.QueryRowContext(t.Context(), `SELECT count(*) FROM accounts`).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := v.db.QueryRowContext(t.Context(), `SELECT count(*) FROM credentials`).Scan(&credentials); err != nil {
		t.Fatal(err)
	}
	if err := v.db.QueryRowContext(t.Context(), `SELECT count(*) FROM envelopes`).Scan(&envelopes); err != nil {
		t.Fatal(err)
	}
	if accounts != 0 || credentials != 0 || envelopes != 0 {
		t.Fatalf("abandoned ceremony left %d accounts, %d credentials, %d envelopes; want 0/0/0",
			accounts, credentials, envelopes)
	}
	// The id the server offered was never persisted, so it is not resolvable.
	if _, err := v.db.AccountByCredentialID(t.Context(), []byte(opts.UserID)); err == nil {
		t.Fatal("an abandoned ceremony's account id resolved to a stored credential")
	}
}

// Cold unlock (A4): one discoverable assertion, and the server answers with the
// account id AND the envelope. No account picker, no second round trip.
func TestColdUnlock_DiscoverableAssertionReturnsAccountAndEnvelope(t *testing.T) {
	v := newVault(t)
	accountID, _, d := v.signup()

	beginRec := v.do(http.MethodPost, "/api/webauthn/login/begin", nil)
	if beginRec.Code != http.StatusOK {
		t.Fatalf("login/begin = %d, body %q", beginRec.Code, beginRec.Body.String())
	}
	// Empty allowCredentials is the single-origin requirement: the client has
	// no account id yet, so the authenticator must choose the credential.
	if strings.Contains(beginRec.Body.String(), "allowCredentials") {
		t.Fatalf("login/begin scoped the assertion to a credential list: %s", beginRec.Body.String())
	}
	if !strings.Contains(beginRec.Body.String(), `"userVerification":"required"`) {
		t.Fatalf("login/begin options missing userVerification=required: %s", beginRec.Body.String())
	}

	opts, err := virtualwebauthn.ParseAssertionOptions(beginRec.Body.String())
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}
	challenge := cookieNamed(beginRec, loginChallengeCookie)
	response := virtualwebauthn.CreateAssertionResponse(testRP(), d.auth, d.cred, *opts)

	finishRec := v.do(http.MethodPost, "/api/webauthn/login/finish", json.RawMessage(response), challenge)
	if finishRec.Code != http.StatusOK {
		t.Fatalf("login/finish = %d, body %q", finishRec.Code, finishRec.Body.String())
	}
	var got loginFinishResponse
	if err := json.Unmarshal(finishRec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode login/finish: %v", err)
	}
	if got.AccountID != accountID {
		t.Errorf("login/finish account_id = %q, want %q", got.AccountID, accountID)
	}
	if string(got.Envelope.CT) != "wrapped-dek-ciphertext" {
		t.Errorf("login/finish envelope ct = %q, want the one stored at signup", got.Envelope.CT)
	}
	if cookieNamed(finishRec, SessionCookieName) == nil {
		t.Error("login/finish minted no session cookie")
	}
}

// A PRF output must never reach the server, and no response may carry one back.
// The client strips it; this asserts the server does not reflect anything that
// smells like key material even if a buggy client sends it.
func TestColdUnlock_ResponseCarriesNoPRFMaterial(t *testing.T) {
	v := newVault(t)
	_, _, d := v.signup()

	beginRec := v.do(http.MethodPost, "/api/webauthn/login/begin", nil)
	opts, _ := virtualwebauthn.ParseAssertionOptions(beginRec.Body.String())
	challenge := cookieNamed(beginRec, loginChallengeCookie)
	response := virtualwebauthn.CreateAssertionResponse(testRP(), d.auth, d.cred, *opts)

	finishRec := v.do(http.MethodPost, "/api/webauthn/login/finish", json.RawMessage(response), challenge)
	if strings.Contains(strings.ToLower(finishRec.Body.String()), "prf") {
		t.Fatalf("login/finish response mentions prf: %s", finishRec.Body.String())
	}
}

func TestLoginFinish_ChallengeIsSingleUse(t *testing.T) {
	v := newVault(t)
	_, _, d := v.signup()

	beginRec := v.do(http.MethodPost, "/api/webauthn/login/begin", nil)
	opts, _ := virtualwebauthn.ParseAssertionOptions(beginRec.Body.String())
	challenge := cookieNamed(beginRec, loginChallengeCookie)
	response := virtualwebauthn.CreateAssertionResponse(testRP(), d.auth, d.cred, *opts)

	if got := v.do(http.MethodPost, "/api/webauthn/login/finish", json.RawMessage(response), challenge).Code; got != http.StatusOK {
		t.Fatalf("first login/finish = %d", got)
	}
	if got := v.do(http.MethodPost, "/api/webauthn/login/finish", json.RawMessage(response), challenge).Code; got != http.StatusBadRequest {
		t.Fatalf("replayed login/finish = %d, want 400", got)
	}
}

// An assertion from a credential this server never registered must not resolve
// to anybody's account.
func TestLoginFinish_RejectsUnknownCredential(t *testing.T) {
	v := newVault(t)
	v.signup() // so the account table is non-empty and a bug could plausibly pick it

	beginRec := v.do(http.MethodPost, "/api/webauthn/login/begin", nil)
	opts, _ := virtualwebauthn.ParseAssertionOptions(beginRec.Body.String())
	challenge := cookieNamed(beginRec, loginChallengeCookie)

	stranger := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{UserHandle: []byte("SOMEONEELSE")})
	strangerCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	response := virtualwebauthn.CreateAssertionResponse(testRP(), stranger, strangerCred, *opts)

	rec := v.do(http.MethodPost, "/api/webauthn/login/finish", json.RawMessage(response), challenge)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("login/finish with an unregistered credential = %d, want 400", rec.Code)
	}
}

func TestRecoveryMaterial_StoresHashedVerifierOnly(t *testing.T) {
	v := newVault(t)
	accountID, session, _ := v.signup()

	verifier := []byte("verifier-bytes-from-the-recovery-code")
	rec := v.do(http.MethodPut, "/api/recovery-material", recoveryMaterialRequest{
		Envelope: envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("rec-wrapped-dek"), MAC: []byte("rec-mac")},
		Verifier: verifier,
	}, session)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT /api/recovery-material = %d, body %q", rec.Code, rec.Body.String())
	}

	var stored []byte
	if err := v.db.QueryRowContext(t.Context(),
		`SELECT recovery_verifier_hash FROM accounts WHERE id = ?`, accountID).Scan(&stored); err != nil {
		t.Fatalf("read verifier hash: %v", err)
	}
	if bytes.Equal(stored, verifier) {
		t.Fatal("the raw verifier was stored; it must be hashed")
	}
	if len(stored) != 32 {
		t.Fatalf("verifier hash is %d bytes, want a 32-byte SHA-256", len(stored))
	}
	if _, err := v.db.GetEnvelope(t.Context(), accountID, store.RecoveryRef); err != nil {
		t.Fatalf("recovery envelope not stored: %v", err)
	}
}

// Getting the scheme wrong makes every ceremony fail origin validation with a
// generic error, which is a miserable thing to debug.
func TestSchemeForHost(t *testing.T) {
	for host, want := range map[string]string{
		"localhost":           "http",
		"vault.localhost":     "http",
		"127.0.0.1":           "http",
		"127.0.0.53":          "http",
		"::1":                 "http",
		"myportfolio.example": "https",
		"localhost.evil.test": "https", // suffix match must be on a dot boundary
		"notlocalhost":        "https",
		"192.168.1.10":        "https",
		"203.0.113.7":         "https",
	} {
		if got := schemeForHost(host); got != want {
			t.Errorf("schemeForHost(%q) = %q, want %q", host, got, want)
		}
	}
}

func TestStripPort(t *testing.T) {
	for host, want := range map[string]string{
		"localhost:8080":          "localhost",
		"localhost":               "localhost",
		"myportfolio.example":     "myportfolio.example",
		"myportfolio.example:443": "myportfolio.example",
		"[2001:db8::1]:8080":      "[2001:db8::1]",
		"[2001:db8::1]":           "[2001:db8::1]",
	} {
		if got := stripPort(host); got != want {
			t.Errorf("stripPort(%q) = %q, want %q", host, got, want)
		}
	}
}

func TestSessionRoutesRejectAnonymousCallers(t *testing.T) {
	v := newVault(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/state"},
		{http.MethodPut, "/api/state"},
		{http.MethodPut, "/api/recovery-material"},
	} {
		if got := v.do(tc.method, tc.path, nil).Code; got != http.StatusUnauthorized {
			t.Errorf("%s %s without a session = %d, want 401", tc.method, tc.path, got)
		}
	}
}

// Revoking a device must take effect on the next request, not whenever its
// 30-day cookie expires — which is why the session token carries a credential
// id that requireSession re-checks.
func TestSessionIsRejectedOnceItsCredentialIsGone(t *testing.T) {
	v := newVault(t)
	accountID, session, d := v.signup()

	if got := v.do(http.MethodGet, "/api/state", nil, session).Code; got != http.StatusNoContent {
		t.Fatalf("GET /api/state with a live session = %d, want 204", got)
	}
	if _, err := v.db.ExecContext(t.Context(), `DELETE FROM credentials WHERE id = ?`, d.cred.ID); err != nil {
		t.Fatalf("revoke credential: %v", err)
	}
	if got := v.do(http.MethodGet, "/api/state", nil, session).Code; got != http.StatusUnauthorized {
		t.Fatalf("GET /api/state after revoking the credential = %d, want 401 (account %s)", got, accountID)
	}
}
