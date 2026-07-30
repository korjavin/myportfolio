package server

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"testing"
)

func testPairingKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate pairing key: %v", err)
	}
	return key
}

func TestSealPairingKey_RoundTrips(t *testing.T) {
	key := testPairingKey(t)

	ct, nonce, err := sealPairingKey(testSessionSecret, key)
	if err != nil {
		t.Fatalf("sealPairingKey: %v", err)
	}
	if bytes.Contains(ct, key) {
		t.Fatal("the ciphertext contains the plaintext pairing key")
	}
	got, err := openPairingKey(testSessionSecret, ct, nonce)
	if err != nil {
		t.Fatalf("openPairingKey: %v", err)
	}
	if !bytes.Equal(got, key) {
		t.Errorf("opened key = %x, want %x", got, key)
	}
}

// The nonce must be fresh per seal: AES-GCM under a reused (key, nonce) pair
// leaks the XOR of the two plaintexts and forges tags. The derived key is
// process-stable, so the nonce is the only thing keeping two seals apart.
func TestSealPairingKey_UsesAFreshNonce(t *testing.T) {
	key := testPairingKey(t)

	firstCT, firstNonce, err := sealPairingKey(testSessionSecret, key)
	if err != nil {
		t.Fatalf("sealPairingKey: %v", err)
	}
	secondCT, secondNonce, err := sealPairingKey(testSessionSecret, key)
	if err != nil {
		t.Fatalf("sealPairingKey: %v", err)
	}
	if bytes.Equal(firstNonce, secondNonce) {
		t.Error("two seals of the same key reused the nonce")
	}
	if bytes.Equal(firstCT, secondCT) {
		t.Error("two seals of the same key produced identical ciphertext")
	}
}

// The one failure mode that must not be silent. A wrong session secret has to
// fail loudly here rather than return plausible bytes: a subtly wrong pairing key
// produces frames the browser's AEAD rejects, which reaches the user as "no
// device online" — the same message a legitimately offline device gets, and
// §11 records that as the hardest failure in this feature to attribute.
func TestOpenPairingKey_WrongSessionSecretFailsRatherThanReturningGarbage(t *testing.T) {
	key := testPairingKey(t)
	ct, nonce, err := sealPairingKey(testSessionSecret, key)
	if err != nil {
		t.Fatalf("sealPairingKey: %v", err)
	}

	got, err := openPairingKey(testSessionSecret+"-rotated", ct, nonce)
	if err == nil {
		t.Fatalf("openPairingKey under a rotated secret succeeded, returning %x", got)
	}
	if got != nil {
		t.Errorf("openPairingKey returned %x alongside its error; it must return no bytes at all", got)
	}
}

// Tampering with either half must fail for the same reason: the stored row is
// authenticated, not merely encrypted, so an operator cannot swap a ciphertext or
// a nonce and have the server dial with a key of their choosing.
func TestOpenPairingKey_RejectsTamperedCiphertextAndNonce(t *testing.T) {
	key := testPairingKey(t)
	ct, nonce, err := sealPairingKey(testSessionSecret, key)
	if err != nil {
		t.Fatalf("sealPairingKey: %v", err)
	}

	for name, mutate := range map[string]func() ([]byte, []byte){
		"ciphertext": func() ([]byte, []byte) {
			bad := bytes.Clone(ct)
			bad[0] ^= 0xff
			return bad, nonce
		},
		"nonce": func() ([]byte, []byte) {
			bad := bytes.Clone(nonce)
			bad[0] ^= 0xff
			return ct, bad
		},
		"truncated ciphertext": func() ([]byte, []byte) { return ct[:len(ct)-1], nonce },
		// cipher.AEAD.Open PANICS on a wrong-length nonce rather than returning an
		// error, and this nonce comes off disk. restore runs at boot, so a
		// truncated nonce column has to cost one account a re-pair, not the whole
		// server's startup.
		"truncated nonce": func() ([]byte, []byte) { return ct, nonce[:len(nonce)-1] },
		"empty nonce":     func() ([]byte, []byte) { return ct, nil },
		"overlong nonce":  func() ([]byte, []byte) { return ct, append(bytes.Clone(nonce), 0) },
	} {
		t.Run(name, func(t *testing.T) {
			badCT, badNonce := mutate()
			if got, err := openPairingKey(testSessionSecret, badCT, badNonce); err == nil {
				t.Errorf("openPairingKey accepted a tampered %s, returning %x", name, got)
			}
		})
	}
}

// The HKDF label is pinned because changing it is a KEY ROTATION: every stored
// pairing key becomes unopenable and every paired remote must re-pair. That is a
// decision, so it has to fail a test rather than ride along inside a rename.
//
// The vector also pins that the sealing key is DERIVED and not the session secret
// itself, and — since the session cookie HMACs the raw secret (session.go) — that
// the two uses of one stored secret cannot produce the same key material.
func TestMCPSealKeyIsPinned(t *testing.T) {
	if mcpPairingKeyInfo != "mp/mcp-pairing-key/v1" {
		t.Errorf("mcpPairingKeyInfo = %q; changing it orphans every stored pairing key. If that rotation is intended, update this test deliberately.", mcpPairingKeyInfo)
	}
	const wantHex = "e4a3b25cb6c466f669ea9ce96c54340897c0c020c491a475f11884825d438130"
	key, err := mcpSealKey(testSessionSecret)
	if err != nil {
		t.Fatalf("mcpSealKey: %v", err)
	}
	if got := hex.EncodeToString(key); got != wantHex {
		t.Errorf("mcpSealKey(testSessionSecret) = %s, want %s", got, wantHex)
	}
	if bytes.Equal(key, []byte(testSessionSecret)[:len(key)]) {
		t.Error("the sealing key is the session secret itself, not a derived key")
	}
}
