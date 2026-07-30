package server

// Sealing the hosted connector's pairing key at rest (ARCHITECTURE.md §11 Tier
// 2). Ported from medicationtrackerbot's internal/cloudserver/mcp_seal.go, with
// its HKDF taken from the standard library rather than x/crypto.
//
// What this defends and what it does not, stated the way §11 asks:
//
//   - It defends a leak scoped to the mcp_remote table — a query dump, a stray
//     log of a row, a partial exfiltration. The ciphertext there is useless
//     without the derived key.
//   - It does NOT make Tier 2 zero knowledge, and nothing may describe it that
//     way. The running server opens this key to seal frames on the browser's
//     behalf, so it sees MCP requests and responses in plaintext in transit.
//     Tier 1 (cmd/mcpshim) is the tier that keeps the key off the server.
//   - It is weaker here than in the sibling, which reads SESSION_SECRET from the
//     environment. Ours is a row in the SAME SQLite file (store.SessionSecret),
//     so an attacker who walks off with the whole database file — or a
//     Litestream replica of it — has the sealing key too. Sealing buys
//     table-scoped protection, not whole-file protection.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
)

// mcpPairingKeyInfo is the HKDF domain-separation label for the pairing-key
// sealing key. It is distinct from anything the session cookie derives (which
// HMACs the session secret directly, session.go), so the same stored secret
// yields unrelated keys for unrelated jobs and neither can be used to attack
// the other.
//
// Bumping it (v2, …) is deliberately a KEY ROTATION: every stored pairing key
// becomes unopenable and every paired remote must re-pair. TestMCPSealKeyIsPinned
// fails on any change to this constant, so the rotation cannot happen by
// accident during a rename.
const mcpPairingKeyInfo = "mp/mcp-pairing-key/v1"

// mcpSealKeyBytes is AES-256.
const mcpSealKeyBytes = 32

// mcpSealKey derives the key that seals pairing keys at rest from the process
// session secret via HKDF-SHA256.
//
// Rotating the session secret orphans every stored pairing key — already-paired
// remotes must re-pair. That is accepted (it is far milder than losing the
// volume, which destroys vaults outright) but it has to be said where an
// operator will read it, not discovered.
func mcpSealKey(sessionSecret string) ([]byte, error) {
	return hkdf.Key(sha256.New, []byte(sessionSecret), nil, mcpPairingKeyInfo, mcpSealKeyBytes)
}

// sealPairingKey encrypts pairingKey under the derived key with AES-256-GCM,
// returning (ciphertext, nonce) for storage.
func sealPairingKey(sessionSecret string, pairingKey []byte) (ct, nonce []byte, err error) {
	gcm, err := mcpSealGCM(sessionSecret)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return gcm.Seal(nil, nonce, pairingKey, nil), nonce, nil
}

// openPairingKey reverses sealPairingKey.
//
// A wrong session secret fails here with GCM's authentication error and returns
// no bytes at all — it cannot hand back plausible-looking garbage that would go
// on to produce frames the browser silently rejects, which §11 records as the
// single hardest failure in this feature to attribute.
func openPairingKey(sessionSecret string, ct, nonce []byte) ([]byte, error) {
	gcm, err := mcpSealGCM(sessionSecret)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ct, nil)
}

func mcpSealGCM(sessionSecret string) (cipher.AEAD, error) {
	key, err := mcpSealKey(sessionSecret)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
