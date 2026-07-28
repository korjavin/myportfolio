package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestGetState_FreshAccountHasNoBlob(t *testing.T) {
	v := newVault(t)
	_, session, _ := v.signup()

	rec := v.do(http.MethodGet, "/api/state", nil, session)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("GET /api/state on a fresh account = %d, want 204", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("204 carried a body: %q", rec.Body.String())
	}
}

// The version the client sends is the one it LAST READ; the server stores
// last-read + 1. A fresh account therefore PUTs version 0 and gets version 1.
func TestPutState_VersionsFromZeroAndRoundTrips(t *testing.T) {
	v := newVault(t)
	_, session, _ := v.signup()

	rec := v.do(http.MethodPut, "/api/state", stateWire{Version: 0, Nonce: []byte("twelve-bytes"), CT: []byte("first-blob")}, session)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("first PUT = %d, body %q", rec.Code, rec.Body.String())
	}

	got := getStateBlob(t, v, session)
	if got.Version != 1 {
		t.Errorf("version after first PUT = %d, want 1", got.Version)
	}
	if string(got.CT) != "first-blob" {
		t.Errorf("ct = %q, want %q", got.CT, "first-blob")
	}

	// A second write at last-read 1 becomes version 2.
	if rec := v.do(http.MethodPut, "/api/state", stateWire{Version: 1, Nonce: []byte("twelve-bytes"), CT: []byte("second-blob")}, session); rec.Code != http.StatusNoContent {
		t.Fatalf("second PUT = %d, body %q", rec.Code, rec.Body.String())
	}
	got = getStateBlob(t, v, session)
	if got.Version != 2 || string(got.CT) != "second-blob" {
		t.Errorf("after second PUT: version %d ct %q, want 2 / second-blob", got.Version, got.CT)
	}
}

// The compare half of the compare-and-swap: a stale writer is refused and told
// what it lost to, so it can merge (the server never does).
func TestPutState_StaleVersionGets409WithTheCurrentBlob(t *testing.T) {
	v := newVault(t)
	_, session, _ := v.signup()

	v.do(http.MethodPut, "/api/state", stateWire{Version: 0, Nonce: []byte("twelve-bytes"), CT: []byte("winner")}, session)

	rec := v.do(http.MethodPut, "/api/state", stateWire{Version: 0, Nonce: []byte("twelve-bytes"), CT: []byte("loser")}, session)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale PUT = %d, want 409", rec.Code)
	}
	var conflict stateWire
	if err := json.Unmarshal(rec.Body.Bytes(), &conflict); err != nil {
		t.Fatalf("decode 409 body: %v", err)
	}
	if conflict.Version != 1 || string(conflict.CT) != "winner" {
		t.Fatalf("409 body = version %d ct %q, want the winner's version 1 / %q", conflict.Version, conflict.CT, "winner")
	}

	// And the losing write really was not applied.
	if got := getStateBlob(t, v, session); string(got.CT) != "winner" {
		t.Fatalf("stored ct = %q; the stale write overwrote the winner", got.CT)
	}
}

// Two devices racing at the same version: exactly one 204, exactly one 409, and
// the 409 carries the winner's blob. This is the property the whole design
// rests on — without it the two devices silently clobber each other.
func TestPutState_ConcurrentWritersProduceExactlyOneWinner(t *testing.T) {
	v := newVault(t)
	_, session, _ := v.signup()

	const writers = 8
	codes := make([]int, writers)
	bodies := make([][]byte, writers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec := v.do(http.MethodPut, "/api/state", stateWire{
				Version: 0,
				Nonce:   []byte("twelve-bytes"),
				CT:      []byte{byte('a' + i)},
			}, session)
			codes[i] = rec.Code
			bodies[i] = rec.Body.Bytes()
		}()
	}
	close(start)
	wg.Wait()

	var won, lost int
	for i, code := range codes {
		switch code {
		case http.StatusNoContent:
			won++
		case http.StatusConflict:
			lost++
			var conflict stateWire
			if err := json.Unmarshal(bodies[i], &conflict); err != nil {
				t.Fatalf("writer %d: decode 409 body: %v", i, err)
			}
			if conflict.Version != 1 || len(conflict.CT) == 0 {
				t.Errorf("writer %d: 409 body = version %d ct %q, want the winner's version 1 and its blob",
					i, conflict.Version, conflict.CT)
			}
		default:
			t.Fatalf("writer %d: unexpected status %d (%s)", i, code, bodies[i])
		}
	}
	if won != 1 || lost != writers-1 {
		t.Fatalf("concurrent PUTs at version 0: %d won, %d conflicted; want 1 and %d", won, lost, writers-1)
	}
	if got := getStateBlob(t, v, session); got.Version != 1 {
		t.Fatalf("version after the race = %d, want 1", got.Version)
	}
}

// The trap this cap exists to avoid: `ct` arrives base64-encoded, so a body
// limit below base64(CT limit) would reject an oversized blob as a malformed
// body and make an accidental sub-limit the real ceiling. The rejection must
// name the quota (413), not the parser.
func TestPutState_OversizedCiphertextTripsTheQuotaNotTheBodyParser(t *testing.T) {
	if maxStateBodyBytes <= maxStateCTBytes*4/3 {
		t.Fatalf("body cap %d must exceed base64 of the CT cap (%d); an oversized ct would trip the parser first",
			maxStateBodyBytes, maxStateCTBytes*4/3)
	}

	v := newVault(t)
	_, session, _ := v.signup()

	rec := v.do(http.MethodPut, "/api/state", stateWire{
		Version: 0,
		Nonce:   []byte("twelve-bytes"),
		CT:      make([]byte, maxStateCTBytes+1),
	}, session)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PUT with an over-quota ct = %d, want 413 (body %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "quota") {
		t.Errorf("413 body = %q, want it to name the quota", rec.Body.String())
	}
}

func TestPutState_RejectsMalformedBlobs(t *testing.T) {
	v := newVault(t)
	_, session, _ := v.signup()

	for name, body := range map[string]any{
		"no nonce":         stateWire{Version: 0, CT: []byte("x")},
		"no ct":            stateWire{Version: 0, Nonce: []byte("twelve-bytes")},
		"negative version": stateWire{Version: -1, Nonce: []byte("twelve-bytes"), CT: []byte("x")},
		"oversized nonce":  stateWire{Version: 0, Nonce: make([]byte, maxNonceLen+1), CT: []byte("x")},
		"not json":         "{",
	} {
		if got := v.do(http.MethodPut, "/api/state", body, session).Code; got != http.StatusBadRequest {
			t.Errorf("PUT with %s = %d, want 400", name, got)
		}
	}
}

// One account's blob must never be visible to another's session.
func TestState_IsScopedToTheSessionAccount(t *testing.T) {
	v := newVault(t)
	_, alice, _ := v.signup()
	_, bob, _ := v.signup()

	v.do(http.MethodPut, "/api/state", stateWire{Version: 0, Nonce: []byte("twelve-bytes"), CT: []byte("alice-blob")}, alice)

	if got := v.do(http.MethodGet, "/api/state", nil, bob).Code; got != http.StatusNoContent {
		t.Fatalf("bob's GET /api/state = %d, want 204 — he has no blob of his own", got)
	}
}

func getStateBlob(t *testing.T, v *vault, session *http.Cookie) stateWire {
	t.Helper()
	rec := v.do(http.MethodGet, "/api/state", nil, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/state = %d, body %q", rec.Code, rec.Body.String())
	}
	var got stateWire
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	return got
}
