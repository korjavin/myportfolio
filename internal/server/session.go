package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SessionCookieName carries an account's HMAC session token. Minted by the
// WebAuthn register/login finish handlers; verified by RequireSession for every
// account-scoped /api route.
const SessionCookieName = "myportfolio_session"

const sessionTTL = 30 * 24 * time.Hour

// sessionMaxFutureSkew bounds how far in the future a token's mint timestamp
// may be and still verify. Without it, time.Since(ts) is negative for a
// future-dated timestamp and always passes the TTL check, so a clock rollback
// or a forward-dated token would extend a session indefinitely. Five minutes
// absorbs ordinary drift.
const sessionMaxFutureSkew = 5 * time.Minute

// newSessionToken mints a stateless token for accountID + credentialID:
// base64url(payload) + "." + hex(hmac). Carrying the credential id is what lets
// RequireSession inherit device revocation for free.
func newSessionToken(accountID string, credentialID []byte, secret string) string {
	payload := fmt.Sprintf("%s|%s|%d", accountID, hex.EncodeToString(credentialID), time.Now().Unix())
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(h.Sum(nil))
}

// verifySessionToken validates token against secret and returns the identity it
// carries, if the signature is valid and the token has not expired.
func verifySessionToken(token, secret string) (accountID string, credentialID []byte, ok bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", nil, false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", nil, false
	}
	h := hmac.New(sha256.New, []byte(secret))
	h.Write(payloadBytes)
	sig, err := hex.DecodeString(parts[1])
	if err != nil || !hmac.Equal(h.Sum(nil), sig) {
		return "", nil, false
	}
	payloadParts := strings.Split(string(payloadBytes), "|")
	if len(payloadParts) != 3 {
		return "", nil, false
	}
	ts, err := strconv.ParseInt(payloadParts[2], 10, 64)
	if err != nil {
		return "", nil, false
	}
	age := time.Since(time.Unix(ts, 0))
	if age > sessionTTL || age < -sessionMaxFutureSkew {
		return "", nil, false
	}
	credID, err := hex.DecodeString(payloadParts[1])
	if err != nil {
		return "", nil, false
	}
	return payloadParts[0], credID, true
}

// sessionCookie builds the HttpOnly/Secure/SameSite=Lax cookie carrying token.
//
// Secure is unconditional even though local development runs over plain HTTP:
// http://localhost is a secure context, so browsers accept a Secure cookie
// there. Making the flag conditional on the scheme is how a proxy
// misconfiguration ends up shipping session cookies in the clear.
func sessionCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	}
}

// Session is the verified identity RequireSession attaches to a request.
type Session struct {
	AccountID    string
	CredentialID []byte
}

type sessionCtxKey struct{}

// requireSession wraps next with session-cookie authentication for the
// account-scoped /api routes: missing, invalid, or expired cookies get 401.
//
// It also re-checks that the session's credential still exists. Session tokens
// live 30 days and carry a credential id, so verifying it here means revoking a
// device takes effect on the next request for every route at once, rather than
// each handler having to remember to check.
//
// Unlike the sibling project there is no host-derived account to cross-check
// against: single origin (ARCHITECTURE.md 8.2) means the token IS the only
// claim of identity, which is exactly why it is HMAC'd with a
// persisted-not-configured secret.
func (a *API) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		accountID, credentialID, ok := verifySessionToken(cookie.Value, a.sessionSecret)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		exists, err := a.db.CredentialExists(r.Context(), accountID, credentialID)
		if err != nil || !exists {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), sessionCtxKey{}, Session{AccountID: accountID, CredentialID: credentialID})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func sessionFromContext(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(sessionCtxKey{}).(Session)
	return s, ok
}
