package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"
)

func hmacHex(payload string) string {
	h := hmac.New(sha256.New, []byte(testSessionSecret))
	h.Write([]byte(payload))
	return hex.EncodeToString(h.Sum(nil))
}

func TestSessionToken_RoundTrips(t *testing.T) {
	credID := []byte{0xde, 0xad, 0xbe, 0xef}
	token := newSessionToken("ACCOUNT1", credID, testSessionSecret)

	account, gotCred, ok := verifySessionToken(token, testSessionSecret)
	if !ok || account != "ACCOUNT1" || !bytes.Equal(gotCred, credID) {
		t.Fatalf("verify = %q / %x / %v, want ACCOUNT1 / %x / true", account, gotCred, ok, credID)
	}
}

func TestSessionToken_RejectsTamperingAndWrongSecret(t *testing.T) {
	token := newSessionToken("ACCOUNT1", []byte{1, 2, 3}, testSessionSecret)

	if _, _, ok := verifySessionToken(token, "a-different-secret-entirely-0000000000"); ok {
		t.Error("a token verified under the wrong secret")
	}

	// Re-sign a swapped account id with the ORIGINAL payload's signature: the
	// HMAC must be what rejects it, not a shape check.
	payload, sig, _ := strings.Cut(token, ".")
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	forged := base64.RawURLEncoding.EncodeToString(bytes.Replace(raw, []byte("ACCOUNT1"), []byte("ACCOUNT2"), 1)) + "." + sig
	if _, _, ok := verifySessionToken(forged, testSessionSecret); ok {
		t.Error("a token with a swapped account id verified")
	}

	for name, bad := range map[string]string{
		"no signature":       payload,
		"empty":              "",
		"garbage signature":  payload + ".zzzz",
		"truncated payload":  payload[:len(payload)-2] + "." + sig,
		"signature only":     "." + sig,
		"non-hex signature":  payload + ".nothexatall",
		"non-base64 payload": "!!!." + sig,
	} {
		if _, _, ok := verifySessionToken(bad, testSessionSecret); ok {
			t.Errorf("%s verified", name)
		}
	}
}

// Both ends of the validity window. A token minted in the future is the
// dangerous one: without the skew bound its age is negative, so a naive
// "age > TTL" check would call it valid forever.
func TestSessionToken_RejectsExpiredAndFutureDatedTokens(t *testing.T) {
	sign := func(accountID string, credID []byte, at time.Time) string {
		payload := fmt.Sprintf("%s|%s|%d", accountID, hex.EncodeToString(credID), at.Unix())
		return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hmacHex(payload)
	}

	if _, _, ok := verifySessionToken(sign("A", []byte{1}, time.Now().Add(-sessionTTL-time.Hour)), testSessionSecret); ok {
		t.Error("an expired token verified")
	}
	if _, _, ok := verifySessionToken(sign("A", []byte{1}, time.Now().Add(sessionMaxFutureSkew+time.Hour)), testSessionSecret); ok {
		t.Error("a future-dated token verified — the clock-rollback guard is not working")
	}
	// Ordinary drift inside the skew allowance still works.
	if _, _, ok := verifySessionToken(sign("A", []byte{1}, time.Now().Add(time.Minute)), testSessionSecret); !ok {
		t.Error("a token one minute ahead was rejected; that is ordinary clock drift")
	}
}

func TestSessionCookie_IsHttpOnlyAndSecure(t *testing.T) {
	c := sessionCookie("token")
	if !c.HttpOnly {
		t.Error("session cookie is readable from JavaScript")
	}
	if !c.Secure {
		t.Error("session cookie is not Secure")
	}
	if c.Path != "/" {
		t.Errorf("session cookie path = %q, want /", c.Path)
	}
}
