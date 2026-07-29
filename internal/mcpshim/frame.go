// Package mcpshim holds the AI connector's wire format: the frame crypto and
// the one-time pairing code shared by the stdio shim (cmd/mcpshim, bd
// myportfolio-ybp.3) and, byte for byte, by the in-browser responder
// (web/static/js/core/crypto.js, bd myportfolio-ybp.4). Ported from
// medicationtrackerbot's internal/mcpshim, which shipped this design
// (docs/cloud-mode.md "MCP", Tier 1).
//
// Wire contract, both directions, piped opaquely by the relay
// (ARCHITECTURE.md §11 — normative, do not re-derive here):
//
//	frame   = nonce(12) ‖ AES-GCM(pairingKey, payload, aad)
//	aad     = encodeFields("mp/v1/mcp", pairingID)
//	payload = one JSON-RPC MCP message
//
// pairingKey is the 32-byte key from the pairing code (pairingcode.go). The
// relay never holds it and the server never sees it. Binding pairingID into
// the AAD is what stops a frame minted for one pairing from being replayed
// into another pairing's leg even if a key were somehow reused.
//
// testdata/mcp_frame_vectors.json pins the format and BOTH suites decrypt it
// (see mcpshim_test.go and web/static/js/core/tests/mcp-frame.test.mjs). The
// two implementations are written at different times by different people, and
// a disagreement surfaces as "the connector silently drops every frame" —
// close to unattributable from either side alone. The pinned vectors are the
// thing that makes it attributable.
package mcpshim

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"fmt"
)

const (
	// frameAADLabel is "mp/…", never medtracker's "mt/…": a frame from one app
	// must fail to open in the other rather than half-work (ARCHITECTURE.md §8.1).
	frameAADLabel = "mp/v1/mcp"
	nonceSize     = 12

	// FrameOverheadBytes is what a frame costs on top of its payload: the
	// 12-byte nonce plus AES-GCM's 16-byte tag.
	//
	// Exported because the relay's cap (bd myportfolio-ybp.2) is on the WHOLE
	// frame — coder/websocket's SetReadLimit measures the message — so the
	// largest payload that survives a 64 KiB cap is 65536-28 = 65508, not
	// 65536. Both suites pin that arithmetic. Re-deriving it in each of C2,
	// C3 and C4 is how one of the three ends up off by 28 bytes and drops
	// exactly the largest answers, which reads as "big queries hang".
	FrameOverheadBytes = nonceSize + 16
)

// encodeFields mirrors web/static/js/core/crypto.js's encodeFields: uint16-BE
// length ‖ bytes per field, concatenated in argument order.
//
// The >0xffff guard is not decoration and is not optional — it is the JS
// side's behaviour. There, a longer field throws; here, the obvious
// uint16(len(p)) conversion would silently truncate mod 65536 and emit an AAD
// that disagrees with the browser's, i.e. exactly the silent drift these two
// files exist to prevent. So it is an error on both sides.
//
// How this meets the relay's 64 KiB frame cap (bd myportfolio-ybp.2): it
// doesn't, and that is the point worth writing down. The payload is not an
// encodeFields field — only the 9-byte label and pairingID are — so a frame
// sitting right under the relay's cap never approaches the uint16 limit. The
// only way to trip this guard is an absurd pairing id, and then both
// implementations refuse rather than quietly framing it differently.
func encodeFields(parts ...string) ([]byte, error) {
	total := 0
	for _, p := range parts {
		if len(p) > 0xffff {
			return nil, fmt.Errorf("mcpshim: encodeFields: field of %d bytes exceeds uint16 length prefix", len(p))
		}
		total += 2 + len(p)
	}
	out := make([]byte, total)
	offset := 0
	for _, p := range parts {
		binary.BigEndian.PutUint16(out[offset:], uint16(len(p)))
		copy(out[offset+2:], p)
		offset += 2 + len(p)
	}
	return out, nil
}

// FrameAAD is the additional authenticated data a frame is bound to. Exported
// so the relay-side tests and the responder harness can assert the exact bytes
// rather than re-deriving them.
func FrameAAD(pairingID string) ([]byte, error) {
	return encodeFields(frameAADLabel, pairingID)
}

func gcmFor(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: new cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

// SealFrame encrypts payload under key, bound to pairingID via the AAD.
func SealFrame(key []byte, pairingID string, payload []byte) ([]byte, error) {
	aad, err := FrameAAD(pairingID)
	if err != nil {
		return nil, err
	}
	gcm, err := gcmFor(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("mcpshim: nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, payload, aad), nil
}

// OpenFrame decrypts a frame produced by SealFrame or by the browser
// responder's sealMCPFrame. It errors on any tampered nonce, ciphertext or
// AAD, on the wrong key, on a pairingID other than the one the frame was
// sealed for, and on a frame too short to contain a nonce.
func OpenFrame(key []byte, pairingID string, frame []byte) ([]byte, error) {
	if len(frame) < nonceSize {
		return nil, fmt.Errorf("mcpshim: frame too short (%d bytes)", len(frame))
	}
	aad, err := FrameAAD(pairingID)
	if err != nil {
		return nil, err
	}
	gcm, err := gcmFor(key)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, frame[:nonceSize], frame[nonceSize:], aad)
}
