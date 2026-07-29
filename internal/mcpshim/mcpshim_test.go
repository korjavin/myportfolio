package mcpshim

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// vectors is the file BOTH implementations decrypt. Its JS counterpart is
// web/static/js/core/tests/mcp-frame.test.mjs, which reads this same path and
// makes the same assertions from the other side. Neither suite alone
// discharges the format; the pair does.
type vectors struct {
	PairingID      string `json:"pairing_id"`
	OtherPairingID string `json:"other_pairing_id"`
	PairingKeyB64  string `json:"pairing_key_b64"`
	AADHex         string `json:"aad_hex"`
	OtherAADHex    string `json:"other_aad_hex"`
	GoPayload      string `json:"go_payload"`
	GoFrameB64     string `json:"frame_sealed_by_go_b64"`
	JSPayload      string `json:"js_payload"`
	JSFrameB64     string `json:"frame_sealed_by_js_b64"`
	RelayURL       string `json:"relay_url"`
	PairingCode    string `json:"pairing_code"`
}

func loadVectors(t *testing.T) (vectors, []byte) {
	t.Helper()
	raw, err := os.ReadFile("testdata/mcp_frame_vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	key, err := base64.StdEncoding.DecodeString(v.PairingKeyB64)
	if err != nil {
		t.Fatalf("decode pairing key: %v", err)
	}
	return v, key
}

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	return b
}

func TestFrameRoundTrip(t *testing.T) {
	v, key := loadVectors(t)
	payload := []byte(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}`)

	frame, err := SealFrame(key, v.PairingID, payload)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(frame) != nonceSize+len(payload)+16 {
		t.Fatalf("frame is %d bytes, want nonce(12) + payload(%d) + tag(16)", len(frame), len(payload))
	}
	got, err := OpenFrame(key, v.PairingID, frame)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("round-trip = %q, want %q", got, payload)
	}

	// Two seals of the same payload must differ: a fresh random nonce each
	// time is what keeps AES-GCM safe under key reuse across a long session.
	again, err := SealFrame(key, v.PairingID, payload)
	if err != nil {
		t.Fatalf("seal again: %v", err)
	}
	if bytes.Equal(frame, again) {
		t.Fatal("two seals of the same payload are byte-identical — nonce is not fresh")
	}
}

// TestCrossLanguageVectors is the deliverable of bd myportfolio-ybp.1: Go
// opens the frame JS sealed, and the frame Go sealed is pinned so JS can open
// it too. If either side's label, AAD framing or packing drifts, this goes red
// here rather than surfacing as a dead connector months later.
func TestCrossLanguageVectors(t *testing.T) {
	v, key := loadVectors(t)

	t.Run("go opens the pinned go-sealed frame", func(t *testing.T) {
		got, err := OpenFrame(key, v.PairingID, mustB64(t, v.GoFrameB64))
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		if string(got) != v.GoPayload {
			t.Fatalf("payload = %q, want %q", got, v.GoPayload)
		}
	})

	t.Run("go opens the frame JS sealed", func(t *testing.T) {
		got, err := OpenFrame(key, v.PairingID, mustB64(t, v.JSFrameB64))
		if err != nil {
			t.Fatalf("open JS-sealed frame: %v", err)
		}
		if string(got) != v.JSPayload {
			t.Fatalf("payload = %q, want %q", got, v.JSPayload)
		}
	})

	t.Run("AAD framing matches the pin", func(t *testing.T) {
		aad, err := FrameAAD(v.PairingID)
		if err != nil {
			t.Fatalf("aad: %v", err)
		}
		if hex.EncodeToString(aad) != v.AADHex {
			t.Fatalf("aad = %s, want %s", hex.EncodeToString(aad), v.AADHex)
		}
		// Independent re-derivation of the uint16-BE framing, so the pin is
		// cross-checked rather than merely self-consistent with encodeFields.
		var want []byte
		for _, f := range []string{"mp/v1/mcp", v.PairingID} {
			want = append(want, byte(len(f)>>8), byte(len(f)))
			want = append(want, f...)
		}
		if !bytes.Equal(aad, want) {
			t.Fatalf("aad = %x, hand-framed = %x", aad, want)
		}
	})

	t.Run("the label is mp/v1/mcp, not medtracker's mt/v1/mcp", func(t *testing.T) {
		// A frame from the sibling app must not open here. Reproduce its AAD
		// directly rather than trusting the constant.
		mt, err := encodeFields("mt/v1/mcp", v.PairingID)
		if err != nil {
			t.Fatalf("encodeFields: %v", err)
		}
		gcm, err := gcmFor(key)
		if err != nil {
			t.Fatalf("gcm: %v", err)
		}
		frame := mustB64(t, v.GoFrameB64)
		if _, err := gcm.Open(nil, frame[:nonceSize], frame[nonceSize:], mt); err == nil {
			t.Fatal("the pinned frame opened under a medtracker label")
		}
	})
}

// TestCrossPairingReplayFails is the security property the AAD exists for, not
// an edge case: a frame sealed for pairing A must not open under pairing B.
func TestCrossPairingReplayFails(t *testing.T) {
	v, key := loadVectors(t)

	for name, frame := range map[string][]byte{
		"go-sealed": mustB64(t, v.GoFrameB64),
		"js-sealed": mustB64(t, v.JSFrameB64),
	} {
		if _, err := OpenFrame(key, v.OtherPairingID, frame); err == nil {
			t.Fatalf("%s frame opened under a different pairing id", name)
		}
	}

	// And the two AADs really are different bytes — a same-length pairing id
	// would still be caught, but pin the distinct framing explicitly.
	other, err := FrameAAD(v.OtherPairingID)
	if err != nil {
		t.Fatalf("aad: %v", err)
	}
	if hex.EncodeToString(other) != v.OtherAADHex {
		t.Fatalf("other aad = %s, want %s", hex.EncodeToString(other), v.OtherAADHex)
	}
}

func TestOpenFrameRejectsTampering(t *testing.T) {
	v, key := loadVectors(t)
	frame := mustB64(t, v.GoFrameB64)

	tampered := map[string]func([]byte){
		"nonce":      func(b []byte) { b[0] ^= 0xff },
		"ciphertext": func(b []byte) { b[nonceSize] ^= 0xff },
		"auth tag":   func(b []byte) { b[len(b)-1] ^= 0x01 },
		"truncated":  nil, // handled below
	}
	for name, mutate := range tampered {
		if mutate == nil {
			continue
		}
		bad := bytes.Clone(frame)
		mutate(bad)
		if _, err := OpenFrame(key, v.PairingID, bad); err == nil {
			t.Fatalf("a tampered %s opened", name)
		}
	}

	// A frame shorter than the nonce must error, not panic on the slice.
	if _, err := OpenFrame(key, v.PairingID, frame[:nonceSize-1]); err == nil {
		t.Fatal("a frame shorter than the nonce opened")
	}
	// Wrong key.
	wrong := bytes.Clone(key)
	wrong[0] ^= 0xff
	if _, err := OpenFrame(wrong, v.PairingID, frame); err == nil {
		t.Fatal("the frame opened under the wrong pairing key")
	}
}

// The uint16 length prefix is the one place the two implementations could
// silently disagree: JS throws above 65535 and the obvious Go port truncates
// mod 65536. Both must refuse. See frame.go for how this meets the relay's
// 64 KiB frame cap (spoiler: it doesn't — the payload is not an AAD field).
func TestEncodeFieldsRejectsOversizedField(t *testing.T) {
	if _, err := encodeFields("mp/v1/mcp", strings.Repeat("x", 0x10000)); err == nil {
		t.Fatal("a 65536-byte field was accepted; it would truncate to 0 and mis-frame the AAD")
	}
	if _, err := encodeFields("mp/v1/mcp", strings.Repeat("x", 0xffff)); err != nil {
		t.Fatalf("a 65535-byte field must still be accepted: %v", err)
	}
	// A frame at the relay's 64 KiB cap is unaffected: the payload is not a
	// field, so it never meets this limit. Note the payload is the cap MINUS
	// FrameOverheadBytes — the cap is on the frame, so a full 64 KiB payload
	// would seal to 65564 bytes and the relay would reject it.
	const relayCap = 64 << 10
	v, key := loadVectors(t)
	big := bytes.Repeat([]byte("p"), relayCap-FrameOverheadBytes)
	frame, err := SealFrame(key, v.PairingID, big)
	if err != nil {
		t.Fatalf("seal the largest payload that fits the cap: %v", err)
	}
	if len(frame) != relayCap {
		t.Fatalf("frame is %d bytes, want exactly the %d-byte cap", len(frame), relayCap)
	}
	got, err := OpenFrame(key, v.PairingID, frame)
	if err != nil || !bytes.Equal(got, big) {
		t.Fatalf("payload at the cap did not round-trip: %v", err)
	}
}

func TestPairingCodeRoundTrip(t *testing.T) {
	v, key := loadVectors(t)

	// The pinned code was produced by BOTH encoders — Go's FormatPairingCode
	// and the browser's formatPairingCode — from the same inputs. If either
	// changes its JSON key order or base64 alphabet, one of these two
	// assertions goes red.
	pc, err := ParsePairingCode(v.PairingCode)
	if err != nil {
		t.Fatalf("parse the pinned code: %v", err)
	}
	if pc.RelayURL != v.RelayURL || pc.PairingID != v.PairingID || !bytes.Equal(pc.Key, key) {
		t.Fatalf("parsed %+v, want relay=%q pairing=%q key=%x", pc, v.RelayURL, v.PairingID, key)
	}
	got, err := FormatPairingCode(pc)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if got != v.PairingCode {
		t.Fatalf("re-formatted code = %q, want the pinned %q", got, v.PairingCode)
	}
	// Surrounding whitespace from a paste must not break parsing.
	if _, err := ParsePairingCode("  " + v.PairingCode + "\n"); err != nil {
		t.Fatalf("a pasted code with whitespace was rejected: %v", err)
	}
}

// codeFor mints a well-formed, correctly-checksummed code around arbitrary
// JSON, so the malformed-JSON cases below are rejected for the reason they
// name and not incidentally by the checksum.
func codeFor(raw string) string {
	return PairingCodePrefix + base64.RawURLEncoding.EncodeToString([]byte(raw)) + "." + pairingCodeChecksum([]byte(raw))
}

// A corrupted code must be REJECTED, not silently mis-parsed: a shim that
// connects with a subtly wrong key reports nothing worse than "no device
// online", which is indistinguishable from the design's own limitation.
func TestParsePairingCodeRejectsCorruption(t *testing.T) {
	v, _ := loadVectors(t)
	rest := strings.TrimPrefix(v.PairingCode, PairingCodePrefix)
	body, checksum, _ := strings.Cut(rest, ".")
	key32 := base64.StdEncoding.EncodeToString(make([]byte, 32))

	for name, code := range map[string]string{
		"empty":              "",
		"no prefix":          rest,
		"sibling prefix":     "mtmcp1." + rest,
		"wrong version":      "mpmcp2." + rest,
		"not base64url":      PairingCodePrefix + "!!!!." + checksum,
		"padded base64":      PairingCodePrefix + base64.StdEncoding.EncodeToString([]byte(`{"relay_url":"x"}`)) + "." + checksum,
		"truncated body":     PairingCodePrefix + body[:len(body)-8] + "." + checksum,
		"no checksum group":  PairingCodePrefix + body,
		"empty checksum":     PairingCodePrefix + body + ".",
		"wrong checksum":     PairingCodePrefix + body + ".AAAAAA",
		"not json":           codeFor("not json at all"),
		"missing relay_url":  codeFor(`{"pairing_id":"y","key":"` + key32 + `"}`),
		"missing pairing_id": codeFor(`{"relay_url":"x","key":"` + key32 + `"}`),
		"short key":          codeFor(`{"relay_url":"x","pairing_id":"y","key":"` + base64.StdEncoding.EncodeToString(make([]byte, 16)) + `"}`),
	} {
		if _, err := ParsePairingCode(code); err == nil {
			t.Errorf("a corrupted pairing code (%s) parsed cleanly", name)
		}
	}

	// Sanity: an all-zero key is a VALID 32-byte key, so the rejections above
	// are about corruption and not about key content.
	if _, err := ParsePairingCode(codeFor(`{"relay_url":"x","pairing_id":"y","key":"` + key32 + `"}`)); err != nil {
		t.Fatalf("a valid 32-byte all-zero key was rejected: %v", err)
	}
	// FormatPairingCode refuses a wrong-length key rather than minting a code
	// the shim will reject later, far from the mistake.
	if _, err := FormatPairingCode(&PairingCode{RelayURL: "x", PairingID: "y", Key: make([]byte, 31)}); err == nil {
		t.Fatal("FormatPairingCode minted a code with a 31-byte key")
	}
}

// TestParsePairingCodeRejectsEverySingleCharacterEdit is the test that made
// the checksum group exist, and it is a sweep rather than one hand-picked
// mutant on purpose — the hand-picked one passed by luck while the format
// accepted 46% of its siblings.
//
// Without a checksum, of the 11970 single-character substitutions in this
// code's body, 5557 parsed cleanly and 1371 of those yielded a WRONG KEY: a
// shim that connects, pipes frames the responder can never open, and reports
// "no device online". With it, the whole sweep must be rejected.
func TestParsePairingCodeRejectsEverySingleCharacterEdit(t *testing.T) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	v, _ := loadVectors(t)
	rest := strings.TrimPrefix(v.PairingCode, PairingCodePrefix)

	subs, dels := 0, 0
	for i := range len(rest) {
		if rest[i] == '.' {
			continue // the group separator; its removal is covered above
		}
		for _, c := range alphabet {
			if byte(c) == rest[i] {
				continue
			}
			subs++
			mutant := []byte(rest)
			mutant[i] = byte(c)
			if _, err := ParsePairingCode(PairingCodePrefix + string(mutant)); err == nil {
				t.Fatalf("a one-character substitution at %d (%q -> %q) parsed cleanly", i, rest[i], c)
			}
		}
		dels++
		if _, err := ParsePairingCode(PairingCodePrefix + rest[:i] + rest[i+1:]); err == nil {
			t.Fatalf("a one-character deletion at %d parsed cleanly", i)
		}
	}
	// Guard the guard: if the sweep ever stops generating mutants it would
	// pass vacuously, which is the failure mode this whole test exists to
	// catch in the first place.
	if subs < 10000 || dels < 150 {
		t.Fatalf("the sweep only tried %d substitutions and %d deletions — it is not covering the code", subs, dels)
	}
}
