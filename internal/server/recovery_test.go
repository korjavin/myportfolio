package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/descope/virtualwebauthn"

	"github.com/korjavin/myportfolio/internal/store"
)

// The verifier is opaque to the server — it hashes and compares it — so these
// tests use stand-in bytes where a browser would send
// HKDF(code, salt=account_id, info="mp/v1/rec-auth"). The derivation itself is
// pinned by web/static/js/core/tests/crypto.test.mjs.
var (
	kitVerifier      = []byte("verifier-derived-from-the-printed-code")
	rotatedVerifier  = []byte("verifier-derived-from-the-replacement")
	recoveryEnvelope = envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("rec-wrapped-dek"), MAC: []byte("rec-mac")}
	newKitEnvelope   = envelopeWire{V: 1, Nonce: []byte("nonce-rotated"), CT: []byte("rotated-wrapped-dek"), MAC: []byte("rotated-mac")}
)

func (v *vault) setRecoveryMaterial(session *http.Cookie, env envelopeWire, verifier []byte) {
	v.t.Helper()
	rec := v.do(http.MethodPut, "/api/recovery-material", recoveryMaterialRequest{Envelope: env, Verifier: verifier}, session)
	if rec.Code != http.StatusNoContent {
		v.t.Fatalf("PUT /api/recovery-material = %d, body %q", rec.Code, rec.Body.String())
	}
}

func (v *vault) redeem(accountID string, verifier []byte) *httptest.ResponseRecorder {
	v.t.Helper()
	return v.do(http.MethodPost, "/api/recover", recoverRequest{AccountID: accountID, Verifier: verifier})
}

// signupWithKit is the state of the world A16 assumes: an account with one
// passkey, a state blob, and an Emergency Kit the user has printed.
func (v *vault) signupWithKit() (string, *http.Cookie, *device) {
	v.t.Helper()
	accountID, session, d := v.signup()
	v.setRecoveryMaterial(session, recoveryEnvelope, kitVerifier)
	return accountID, session, d
}

// enrollAfterRedeem drives the second half of Path C: begin the registration
// with the grant, attest with a brand-new authenticator, and finish carrying
// BOTH the new passkey's envelope and the replacement Emergency Kit.
func (v *vault) enrollAfterRedeem(grant string, rotation *recoveryMaterialRequest) (*httptest.ResponseRecorder, *device) {
	v.t.Helper()

	beginRec := v.do(http.MethodPost, "/api/recovery/enroll/begin", recoveryEnrollBeginRequest{Grant: grant})
	if beginRec.Code != http.StatusOK {
		v.t.Fatalf("recovery/enroll/begin = %d, body %q", beginRec.Code, beginRec.Body.String())
	}
	opts, err := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	if err != nil {
		v.t.Fatalf("ParseAttestationOptions: %v", err)
	}
	challenge := cookieNamed(beginRec, recoveryChallengeCookie)
	if challenge == nil {
		v.t.Fatal("recovery/enroll/begin set no challenge cookie")
	}

	// A NEW authenticator — the whole premise is that the old one is gone.
	d := &device{
		auth: virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{
			UserHandle: []byte(opts.UserID),
		}),
		cred: virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2),
	}
	response := virtualwebauthn.CreateAttestationResponse(testRP(), d.auth, d.cred, *opts)

	body := recoveryEnrollFinishRequest{
		Credential: json.RawMessage(response),
		Envelope:   envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("recovered-device-dek"), MAC: []byte("mac")},
	}
	if rotation != nil {
		body.Recovery = *rotation
	}
	return v.do(http.MethodPost, "/api/recovery/enroll/finish", body, challenge), d
}

func (v *vault) grantFrom(rec *httptest.ResponseRecorder) (recoverResponse, string) {
	v.t.Helper()
	var out recoverResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		v.t.Fatalf("decode /api/recover: %v", err)
	}
	if out.Grant == "" {
		v.t.Fatal("/api/recover returned no grant")
	}
	return out, out.Grant
}

func (v *vault) verifierHash(accountID string) []byte {
	v.t.Helper()
	var stored []byte
	if err := v.db.QueryRowContext(v.t.Context(),
		`SELECT recovery_verifier_hash FROM accounts WHERE id = ?`, accountID).Scan(&stored); err != nil {
		v.t.Fatalf("read verifier hash: %v", err)
	}
	return stored
}

func (v *vault) countRows(table string) int {
	v.t.Helper()
	var n int
	//nolint:gosec // table is a literal from this file, never user input
	if err := v.db.QueryRowContext(v.t.Context(), `SELECT count(*) FROM `+table).Scan(&n); err != nil {
		v.t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// The acceptance criterion, end to end: a user who has lost every credential
// types their kit, enrolls a fresh passkey, and reads their existing portfolio
// back — with the same DEK, so the state blob written before the loss is still
// the one they get.
func TestRecovery_RedeemsAndReadsTheExistingVaultBack(t *testing.T) {
	v := newVault(t)
	accountID, session, old := v.signupWithKit()

	// The portfolio that must survive.
	blob := stateWire{Version: 0, Nonce: []byte("state-nonce!"), CT: []byte("the-users-encrypted-portfolio")}
	if got := v.do(http.MethodPut, "/api/state", blob, session).Code; got != http.StatusNoContent {
		t.Fatalf("seed PUT /api/state = %d", got)
	}

	// The passkey is gone: deleted from the authenticator and revoked here.
	if _, err := v.db.ExecContext(t.Context(), `DELETE FROM credentials WHERE id = ?`, old.cred.ID); err != nil {
		t.Fatalf("delete the lost credential: %v", err)
	}

	rec := v.redeem(accountID, kitVerifier)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/recover with the right code = %d, body %q", rec.Code, rec.Body.String())
	}
	out, grant := v.grantFrom(rec)
	// The envelope handed back must be the kit's, byte for byte — it is what
	// KEK_rec (derived from the same code) unwraps into the DEK.
	if !bytes.Equal(out.Envelope.CT, recoveryEnvelope.CT) || !bytes.Equal(out.Envelope.Nonce, recoveryEnvelope.Nonce) {
		t.Fatalf("/api/recover returned envelope %+v, want the stored recovery envelope", out.Envelope)
	}

	finishRec, fresh := v.enrollAfterRedeem(grant, &recoveryMaterialRequest{Envelope: newKitEnvelope, Verifier: rotatedVerifier})
	if finishRec.Code != http.StatusOK {
		t.Fatalf("recovery/enroll/finish = %d, body %q", finishRec.Code, finishRec.Body.String())
	}
	newSession := cookieNamed(finishRec, SessionCookieName)
	if newSession == nil {
		t.Fatal("recovery/enroll/finish minted no session cookie")
	}

	// The recovered session reads the SAME blob back. Nothing was reset.
	stateRec := v.do(http.MethodGet, "/api/state", nil, newSession)
	if stateRec.Code != http.StatusOK {
		t.Fatalf("GET /api/state after recovery = %d, body %q", stateRec.Code, stateRec.Body.String())
	}
	var got stateWire
	if err := json.Unmarshal(stateRec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if string(got.CT) != string(blob.CT) {
		t.Fatalf("state after recovery = %q, want the portfolio written before it", got.CT)
	}

	// And the new passkey can cold-unlock on its own: the envelope it enrolled
	// with is the one login/finish hands back.
	beginRec := v.do(http.MethodPost, "/api/webauthn/login/begin", nil)
	opts, err := virtualwebauthn.ParseAssertionOptions(beginRec.Body.String())
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}
	loginRec := v.do(http.MethodPost, "/api/webauthn/login/finish",
		json.RawMessage(virtualwebauthn.CreateAssertionResponse(testRP(), fresh.auth, fresh.cred, *opts)),
		cookieNamed(beginRec, loginChallengeCookie))
	if loginRec.Code != http.StatusOK {
		t.Fatalf("cold unlock with the recovered passkey = %d, body %q", loginRec.Code, loginRec.Body.String())
	}
	var login loginFinishResponse
	if err := json.Unmarshal(loginRec.Body.Bytes(), &login); err != nil {
		t.Fatalf("decode login/finish: %v", err)
	}
	if login.AccountID != accountID || string(login.Envelope.CT) != "recovered-device-dek" {
		t.Fatalf("recovered passkey unlocked account %q envelope %q; want %q / the envelope it enrolled with",
			login.AccountID, login.Envelope.CT, accountID)
	}
}

// Rotation is the point of the whole ceremony: a code typed into a machine once
// must not remain the key to the vault.
func TestRecovery_BurnsTheRedeemedCodeAndIssuesANewOne(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()

	before := v.verifierHash(accountID)
	_, grant := v.grantFrom(v.redeem(accountID, kitVerifier))
	if finishRec, _ := v.enrollAfterRedeem(grant, &recoveryMaterialRequest{Envelope: newKitEnvelope, Verifier: rotatedVerifier}); finishRec.Code != http.StatusOK {
		t.Fatalf("recovery/enroll/finish = %d, body %q", finishRec.Code, finishRec.Body.String())
	}

	// The old verifier is gone from the row it lived in — replaced, not kept
	// alongside.
	after := v.verifierHash(accountID)
	if bytes.Equal(before, after) {
		t.Fatal("the recovery verifier was not rotated; the redeemed code still opens the vault")
	}
	wantHash := sha256.Sum256(rotatedVerifier)
	if !bytes.Equal(after, wantHash[:]) {
		t.Fatalf("stored verifier hash %x is not SHA-256 of the replacement verifier", after)
	}
	// The recovery envelope rotated with it — a new code paired with the old
	// envelope would authenticate and then fail to decrypt anything.
	env, err := v.db.GetEnvelope(t.Context(), accountID, store.RecoveryRef)
	if err != nil || string(env.CT) != string(newKitEnvelope.CT) {
		t.Fatalf("recovery envelope after rotation = %+v, err %v; want the replacement", env, err)
	}

	// The redeemed code is dead on arrival now.
	if got := v.redeem(accountID, kitVerifier).Code; got != http.StatusForbidden {
		t.Fatalf("redeeming the burned code = %d, want 403", got)
	}
	// And the replacement works.
	if got := v.redeem(accountID, rotatedVerifier).Code; got != http.StatusOK {
		t.Fatalf("redeeming the replacement code = %d, want 200", got)
	}
}

// Rotation must not be skippable. A finish without fresh recovery material is
// refused outright, which is what makes "the client will rotate afterwards"
// impossible to implement by accident.
func TestRecovery_EnrollFinishRequiresRotatedMaterial(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()
	credentialsBefore := v.countRows("credentials")

	_, grant := v.grantFrom(v.redeem(accountID, kitVerifier))
	finishRec, _ := v.enrollAfterRedeem(grant, nil)
	if finishRec.Code != http.StatusBadRequest {
		t.Fatalf("recovery/enroll/finish with no rotation = %d, want 400", finishRec.Code)
	}
	if got := v.countRows("credentials"); got != credentialsBefore {
		t.Fatalf("a rejected finish enrolled a credential anyway (%d, was %d)", got, credentialsBefore)
	}
	// A partial write here would be the worst outcome of all: a working new
	// passkey with the old code still live.
	if !bytes.Equal(v.verifierHash(accountID), func() []byte { h := sha256.Sum256(kitVerifier); return h[:] }()) {
		t.Fatal("a rejected finish rotated the verifier")
	}
}

// A wrong code must not reveal whether the account exists: same status, same
// body, for a real account with the wrong verifier and for an id that was never
// real.
func TestRecovery_WrongCodeRevealsNothingAboutAccountExistence(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()

	real := v.redeem(accountID, []byte("not-the-right-verifier"))
	fake := v.redeem("ZZZZZZZZZZZZZZZZ", []byte("not-the-right-verifier"))
	// A third shape: an account that exists but never uploaded a kit at all.
	noKit := newVault(t)
	bare, _, _ := noKit.signup()
	unequipped := noKit.redeem(bare, []byte("not-the-right-verifier"))

	for _, tc := range []struct {
		name string
		rec  *httptest.ResponseRecorder
	}{
		{"existing account, wrong code", real},
		{"account id that does not exist", fake},
		{"account with no recovery material", unequipped},
	} {
		if tc.rec.Code != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", tc.name, tc.rec.Code)
		}
		if tc.rec.Body.String() != real.Body.String() {
			t.Errorf("%s: body %q differs from the existing-account rejection %q",
				tc.name, tc.rec.Body.String(), real.Body.String())
		}
	}
	// Nothing in the rejection may hint at what went wrong either.
	body := strings.ToLower(real.Body.String())
	for _, leak := range []string{"unknown", "exists", "not found", "no such"} {
		if strings.Contains(body, leak) {
			t.Errorf("rejection body %q leaks %q", real.Body.String(), leak)
		}
	}
}

// Per-account throttling, which the per-IP ceremony limiter cannot provide: it
// is the same limiter type keyed on the account instead of clientIP, so an
// attacker spraying one account from many addresses still runs out.
func TestRecovery_RedemptionIsRateLimitedPerAccount(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()

	for i := range recoveryAttemptMax {
		if got := v.redeem(accountID, []byte("wrong")).Code; got != http.StatusForbidden {
			t.Fatalf("attempt %d = %d, want 403 (still inside the budget)", i+1, got)
		}
	}
	if got := v.redeem(accountID, []byte("wrong")).Code; got != http.StatusTooManyRequests {
		t.Fatalf("attempt %d = %d, want 429", recoveryAttemptMax+1, got)
	}
	// The budget is per account, and it is spent — so even the RIGHT code is
	// refused rather than the throttle being a hint about which guess was close.
	if got := v.redeem(accountID, kitVerifier).Code; got != http.StatusTooManyRequests {
		t.Fatalf("the correct code past the budget = %d, want 429", got)
	}
	// Another account's budget is untouched.
	other := newVault(t)
	otherID, _, _ := other.signupWithKit()
	if got := other.redeem(otherID, kitVerifier).Code; got != http.StatusOK {
		t.Fatalf("a second account was throttled by the first's attempts: %d", got)
	}
}

// The per-account bucket must not be escapable by varying the id's spelling in
// a way the server does not distinguish — and it must not be escapable by
// rotating the forwarded-for header either, which is the per-IP bypass that has
// already shipped here once.
func TestRecovery_RedemptionIsAlsoRateLimitedPerIP(t *testing.T) {
	v := newVault(t)

	// Spray DIFFERENT account ids from one address so the per-account bucket
	// never trips; only the per-IP ceremony limiter can stop this.
	allowed := 0
	for i := range ceremonyRateLimitMax * 2 {
		body, err := json.Marshal(recoverRequest{AccountID: fmt.Sprintf("ACCOUNT%08d", i), Verifier: []byte("guess")})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/recover", bytes.NewReader(body))
		req.Host = testHost
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "203.0.113.7:40000"
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i%250))
		rec := httptest.NewRecorder()
		v.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusTooManyRequests {
			allowed++
		}
	}
	if allowed > ceremonyRateLimitMax {
		t.Fatalf("one caller sprayed %d accounts through a per-IP limit of %d", allowed, ceremonyRateLimitMax)
	}
}

// The PRF capability gate on the recovery path. A client whose brand-new
// credential returns no PRF output abandons before finish, and finish is the
// only step that writes — so the account must not end up holding one PRF
// credential and one without, which could never be unlocked by the second.
func TestRecovery_PRFlessAuthenticatorLeavesNoCredentialBehind(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()
	credentialsBefore := v.countRows("credentials")
	envelopesBefore := v.countRows("envelopes")

	_, grant := v.grantFrom(v.redeem(accountID, kitVerifier))
	beginRec := v.do(http.MethodPost, "/api/recovery/enroll/begin", recoveryEnrollBeginRequest{Grant: grant})
	if beginRec.Code != http.StatusOK {
		t.Fatalf("recovery/enroll/begin = %d", beginRec.Code)
	}

	// ...the client calls create(), the immediate get() returns no
	// prf.results.first, so it deletes the credential and stops. finish is
	// never called.

	if got := v.countRows("credentials"); got != credentialsBefore {
		t.Fatalf("abandoned recovery enrollment left %d credentials, was %d", got, credentialsBefore)
	}
	if got := v.countRows("envelopes"); got != envelopesBefore {
		t.Fatalf("abandoned recovery enrollment left %d envelopes, was %d", got, envelopesBefore)
	}
	// The kit still works, because nothing was rotated.
	if got := v.verifierHash(accountID); !bytes.Equal(got, func() []byte { h := sha256.Sum256(kitVerifier); return h[:] }()) {
		t.Fatal("an abandoned enrollment rotated the verifier; the user's printed code is now dead for nothing")
	}
}

// Enrollment is gated on a grant that only a successful redemption produces.
// Without this the endpoint would be "add a passkey to any account you can
// name", which is worse than having no recovery at all.
func TestRecovery_EnrollBeginRefusesWithoutAValidGrant(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()

	for name, grant := range map[string]string{
		"empty":         "",
		"not a token":   "garbage",
		"forged HMAC":   base64.RawURLEncoding.EncodeToString([]byte(accountID+"|nonce|9999999999")) + ".00",
		"session token": newSessionToken(accountID, []byte{1, 2, 3}, testSessionSecret),
	} {
		rec := v.do(http.MethodPost, "/api/recovery/enroll/begin", recoveryEnrollBeginRequest{Grant: grant})
		if rec.Code != http.StatusForbidden {
			t.Errorf("enroll/begin with a %s grant = %d, want 403", name, rec.Code)
		}
	}
	if got := v.countRows("credentials"); got != 1 {
		t.Fatalf("rejected enroll/begin calls changed the credential count to %d", got)
	}
}

func TestRecoveryGrant_RoundTripsAndExpiresOnASeparateKey(t *testing.T) {
	grant, err := newRecoveryGrant("ACCOUNT123", testSessionSecret)
	if err != nil {
		t.Fatalf("newRecoveryGrant: %v", err)
	}
	got, ok := verifyRecoveryGrant(grant, testSessionSecret)
	if !ok || got != "ACCOUNT123" {
		t.Fatalf("verifyRecoveryGrant = %q, %v; want ACCOUNT123, true", got, ok)
	}
	if _, ok := verifyRecoveryGrant(grant, "a-different-secret"); ok {
		t.Error("a grant verified under the wrong secret")
	}
	// The key prefix is what stops the two token types being interchangeable in
	// either direction.
	if _, _, ok := verifySessionToken(grant, testSessionSecret); ok {
		t.Error("a recovery grant verified as a session token")
	}
	// Two grants for the same account differ: the nonce makes them
	// non-guessable even inside the same second.
	second, err := newRecoveryGrant("ACCOUNT123", testSessionSecret)
	if err != nil {
		t.Fatalf("newRecoveryGrant: %v", err)
	}
	if second == grant {
		t.Error("two grants for the same account are byte-identical")
	}
}

// The recovery challenge is single use, like every other ceremony here: a
// replayed finish must fail even with a byte-identical, validly-signed
// attestation.
func TestRecovery_EnrollChallengeIsSingleUse(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()
	_, grant := v.grantFrom(v.redeem(accountID, kitVerifier))

	beginRec := v.do(http.MethodPost, "/api/recovery/enroll/begin", recoveryEnrollBeginRequest{Grant: grant})
	opts, err := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	challenge := cookieNamed(beginRec, recoveryChallengeCookie)
	auth := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{UserHandle: []byte(opts.UserID)})
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	response := virtualwebauthn.CreateAttestationResponse(testRP(), auth, cred, *opts)

	finish := func() int {
		return v.do(http.MethodPost, "/api/recovery/enroll/finish", recoveryEnrollFinishRequest{
			Credential: json.RawMessage(response),
			Envelope:   envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("ct"), MAC: []byte("mac")},
			Recovery:   recoveryMaterialRequest{Envelope: newKitEnvelope, Verifier: rotatedVerifier},
		}, challenge).Code
	}
	if got := finish(); got != http.StatusOK {
		t.Fatalf("first recovery/enroll/finish = %d", got)
	}
	if got := finish(); got != http.StatusBadRequest {
		t.Fatalf("replayed recovery/enroll/finish = %d, want 400", got)
	}
}

// The enrollment options are the same security contract signup makes with the
// authenticator. Diverging here would enroll a credential the rest of the app
// cannot use — discoverable for cold unlock, user-verified because the PRF
// output is key material.
func TestRecovery_EnrollBeginDemandsResidentKeyUserVerificationAndPRF(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()
	_, grant := v.grantFrom(v.redeem(accountID, kitVerifier))

	rec := v.do(http.MethodPost, "/api/recovery/enroll/begin", recoveryEnrollBeginRequest{Grant: grant})
	body := rec.Body.String()
	for _, want := range []string{`"residentKey":"required"`, `"userVerification":"required"`, `"prf"`} {
		if !strings.Contains(body, want) {
			t.Errorf("recovery/enroll/begin options missing %s: %s", want, body)
		}
	}
	// It must enroll into the RECOVERED account, not mint a new one.
	if !strings.Contains(body, base64.RawURLEncoding.EncodeToString([]byte(accountID))) {
		t.Errorf("recovery/enroll/begin does not name the recovered account %q: %s", accountID, body)
	}
}

func TestRecovery_RedeemRejectsMalformedRequests(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()

	for name, body := range map[string]any{
		"not json":      "{",
		"no account id": recoverRequest{Verifier: kitVerifier},
		"no verifier":   recoverRequest{AccountID: accountID},
		"oversized id":  recoverRequest{AccountID: strings.Repeat("A", maxAccountIDLen+1), Verifier: kitVerifier},
		"huge verifier": recoverRequest{AccountID: accountID, Verifier: bytes.Repeat([]byte("x"), maxVerifierLen+1)},
	} {
		if got := v.do(http.MethodPost, "/api/recover", body).Code; got != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, got)
		}
	}
	// A malformed request must not have spent the account's attempt budget.
	if got := v.redeem(accountID, kitVerifier).Code; got != http.StatusOK {
		t.Fatalf("the right code after malformed requests = %d, want 200", got)
	}
}

func TestRecovery_EnrollFinishRejectsForeignOrigin(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()
	_, grant := v.grantFrom(v.redeem(accountID, kitVerifier))

	beginRec := v.do(http.MethodPost, "/api/recovery/enroll/begin", recoveryEnrollBeginRequest{Grant: grant})
	opts, _ := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	challenge := cookieNamed(beginRec, recoveryChallengeCookie)

	evil := virtualwebauthn.RelyingParty{Name: "myportfolio", ID: testHost, Origin: "https://evil.example.com"}
	auth := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{UserHandle: []byte(opts.UserID)})
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	rec := v.do(http.MethodPost, "/api/recovery/enroll/finish", recoveryEnrollFinishRequest{
		Credential: json.RawMessage(virtualwebauthn.CreateAttestationResponse(evil, auth, cred, *opts)),
		Envelope:   envelopeWire{V: 1, Nonce: []byte("twelve-bytes"), CT: []byte("ct"), MAC: []byte("mac")},
		Recovery:   recoveryMaterialRequest{Envelope: newKitEnvelope, Verifier: rotatedVerifier},
	}, challenge)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("recovery/enroll/finish from a foreign origin = %d, want 400", rec.Code)
	}
	if !bytes.Equal(v.verifierHash(accountID), func() []byte { h := sha256.Sum256(kitVerifier); return h[:] }()) {
		t.Fatal("a failed attestation rotated the verifier")
	}
}

// The redemption response must never carry anything the server was not meant to
// hold — and in particular the plaintext verifier must not be reflected back.
func TestRecovery_StoresAndReflectsNoPlaintextVerifier(t *testing.T) {
	v := newVault(t)
	accountID, _, _ := v.signupWithKit()

	rec := v.redeem(accountID, kitVerifier)
	if bytes.Contains(rec.Body.Bytes(), kitVerifier) {
		t.Fatalf("/api/recover reflected the plaintext verifier: %s", rec.Body.String())
	}
	stored := v.verifierHash(accountID)
	if bytes.Equal(stored, kitVerifier) || len(stored) != sha256.Size {
		t.Fatalf("stored verifier is %d bytes and %v the plaintext; want a 32-byte hash",
			len(stored), map[bool]string{true: "equals", false: "differs from"}[bytes.Equal(stored, kitVerifier)])
	}
}
