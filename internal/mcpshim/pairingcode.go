package mcpshim

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// PairingCodePrefix versions the one-time code so a future format bump fails
// loudly instead of silently misparsing.
//
// "mpmcp1.", not medtracker's "mtmcp1.": the two apps' shims speak different
// relays and different AAD labels, so a code pasted into the wrong one must be
// rejected at the prefix rather than parse cleanly into a pairing that can
// never answer a single call.
const PairingCodePrefix = "mpmcp1."

// PairingKeyBytes is the pairing key length (ARCHITECTURE.md §11: "generates
// 32 random bytes client-side").
const PairingKeyBytes = 32

// pairingCodeChecksumBytes is a truncated SHA-256 over the JSON body, appended
// as a third dot-separated group.
//
// This is a deliberate divergence from the ported format, added because the
// port was measured and found wanting: of the 11970 single-character
// substitutions in a real code's body, 5557 (46%) parsed cleanly and 1371 of
// those returned a WRONG KEY. A wrong key does not fail loudly — the shim
// connects, the relay pipes the frames, and the responder's AEAD rejects every
// one of them, which reaches the user as "no device online", i.e. exactly the
// design's own documented limitation. That is the single hardest failure in
// this whole feature to attribute, so the format gets to be the thing that
// catches it. (Single-char DELETIONS were already all caught, by base64 length
// or JSON parsing; substitutions were not.)
//
// 4 bytes, not a full digest: this is a typo detector, not a MAC. Anyone who
// can rewrite the code can recompute the checksum, and there is nothing to
// authenticate — the key is right there in the string. 32 bits takes the
// accept rate for a corrupted code from ~46% to ~1 in 4 billion, which is the
// entire job. Same reasoning as the recovery code's checksum group
// (crypto.js), which is also detection and not authentication.
const pairingCodeChecksumBytes = 4

func pairingCodeChecksum(raw []byte) string {
	sum := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(sum[:pairingCodeChecksumBytes])
}

// PairingCode is the parsed form of the one-time code Settings generates
// CLIENT-SIDE and the user pastes into the shim.
//
// The code never touches the server — only PairingID does, when the browser
// mints the pairing — so Key is the one secret the relay never sees. Nothing
// in this package may add a field or a call that would carry it server-side;
// that property is the entire reason the connector can exist at all (§11).
type PairingCode struct {
	RelayURL  string
	PairingID string
	Key       []byte
}

// pairingCodeWire is the JSON payload embedded in the code, base64url-encoded
// without padding. Key round-trips through encoding/json's built-in
// []byte<->base64 (standard alphabet, padded), which is exactly what
// web/static/js/core/crypto.js's toBase64 emits — so the JS-minted code and a
// Go-minted one are byte-identical for the same inputs. Field order here is
// the JSON key order, and it must stay relay_url, pairing_id, key to match
// what JSON.stringify emits from formatPairingCode's object literal.
type pairingCodeWire struct {
	RelayURL  string `json:"relay_url"`
	PairingID string `json:"pairing_id"`
	Key       []byte `json:"key"`
}

// ParsePairingCode parses a "mpmcp1.<base64url(json)>.<checksum>" code. Every
// rejection path is explicit: a corrupted code must fail loudly here, because
// the alternative is a shim that connects with a subtly wrong key and reports
// nothing worse than "no device online".
func ParsePairingCode(code string) (*PairingCode, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(code), PairingCodePrefix)
	if !ok {
		return nil, fmt.Errorf("mcpshim: pairing code missing %q prefix", PairingCodePrefix)
	}
	// base64url's alphabet has no ".", so the separator is unambiguous.
	body, checksum, ok := strings.Cut(rest, ".")
	if !ok {
		return nil, fmt.Errorf("mcpshim: pairing code missing its checksum group")
	}
	// Strict(): reject non-zero padding bits in the final base64 character.
	// Without it the decoder is lenient, so the last character of a code has
	// several encodings that all decode to the same bytes — a corruption the
	// checksum cannot see, because it is computed over the decoded bytes. The
	// practical effect is only a non-canonical code, but "one pairing, one
	// code" is worth more than the leniency, and Strict costs nothing.
	raw, err := base64.RawURLEncoding.Strict().DecodeString(body)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: decode pairing code: %w", err)
	}
	if checksum != pairingCodeChecksum(raw) {
		return nil, fmt.Errorf("mcpshim: pairing code checksum mismatch — the code was mistyped or truncated")
	}
	var wire pairingCodeWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, fmt.Errorf("mcpshim: unmarshal pairing code: %w", err)
	}
	if wire.RelayURL == "" || wire.PairingID == "" {
		return nil, fmt.Errorf("mcpshim: pairing code missing relay_url or pairing_id")
	}
	if len(wire.Key) != PairingKeyBytes {
		return nil, fmt.Errorf("mcpshim: pairing key is %d bytes, want %d", len(wire.Key), PairingKeyBytes)
	}
	return &PairingCode{RelayURL: wire.RelayURL, PairingID: wire.PairingID, Key: wire.Key}, nil
}

// FormatPairingCode is ParsePairingCode's inverse. Production codes are minted
// in the browser (crypto.js formatPairingCode); this exists so Go tests can
// produce a real code instead of duplicating the wire format in fixtures, and
// so the pinned vector can assert the two encoders agree byte for byte.
func FormatPairingCode(pc *PairingCode) (string, error) {
	if len(pc.Key) != PairingKeyBytes {
		return "", fmt.Errorf("mcpshim: pairing key is %d bytes, want %d", len(pc.Key), PairingKeyBytes)
	}
	raw, err := json.Marshal(pairingCodeWire{RelayURL: pc.RelayURL, PairingID: pc.PairingID, Key: pc.Key})
	if err != nil {
		return "", fmt.Errorf("mcpshim: marshal pairing code: %w", err)
	}
	return PairingCodePrefix + base64.RawURLEncoding.EncodeToString(raw) + "." + pairingCodeChecksum(raw), nil
}
