package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/korjavin/myportfolio/internal/mcpshim"
)

// What the shim does with 4404 and 4409 can only be checked against a relay
// that actually sends them, so these drive the real handler in this package
// rather than a fake that would only re-state this file's reading of the
// protocol (bd myportfolio-ybp.8).
//
// The assertion is the DIAL COUNT. "Reports a nice error" is not enough: the
// bug being fixed was three redials into a pairing that cannot come back,
// ending in a transport error, and only counting attempts can tell the fix from
// a nicer-sounding version of the same loop.

// dialCounter counts every WebSocket handshake the shim client attempts.
type dialCounter struct {
	base http.RoundTripper
	n    atomic.Int64
}

func (d *dialCounter) RoundTrip(r *http.Request) (*http.Response, error) {
	d.n.Add(1)
	return d.base.RoundTrip(r)
}

// shimClient is the client Settings' pairing code produces, pointed at this
// fixture's relay, with its dials counted.
func shimClient(t *testing.T, f *relayFixture, pairingID string) (*mcpshim.Client, *dialCounter) {
	t.Helper()
	dials := &dialCounter{base: http.DefaultTransport}
	client := mcpshim.NewClientFromPairing(
		&mcpshim.PairingCode{RelayURL: f.relayURL(), PairingID: pairingID, Key: f.key},
		&websocket.DialOptions{HTTPClient: &http.Client{Transport: dials}},
	)
	t.Cleanup(func() { _ = client.Close() })
	return client, dials
}

// call runs one round trip with a bounded context so a hung transport fails the
// test instead of the package timeout.
func call(t *testing.T, client *mcpshim.Client) (err error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	_, err = client.Call(ctx, "mcp_help", mcpshim.HelpInput{Topic: "performance"})
	return err
}

// liveShim mints a pairing, puts a responder on the device leg, and returns a
// shim client that has proven it can reach it — so a later failure is caused by
// what the test does next and not by a connection that never worked.
//
// deviceClosed fires when the relay ends the device leg. Both legs are closed
// by the same closeLegs call, so it is the test's edge for "the shim leg has
// been closed" rather than "is about to be". Which CODE each leg gets is
// already pinned by TestRevokeClosesTheLegsWith4404 and
// TestReMintClosesTheOldLegsWith4409.
func liveShim(t *testing.T, f *relayFixture) (pairingID string, device *websocket.Conn, deviceClosed <-chan struct{}, client *mcpshim.Client, dials *dialCounter) {
	t.Helper()
	pairingID = f.mint(t)
	device = f.dialDevice(t, pairingID)
	closed := make(chan struct{})
	go func() {
		respondOnDevice(t, device, f.key, pairingID)
		close(closed)
	}()
	client, dials = shimClient(t, f, pairingID)
	if err := call(t, client); err != nil {
		t.Fatalf("first call through the relay: %v", err)
	}
	if n := dials.n.Load(); n != 1 {
		t.Fatalf("one working call took %d dials, want 1", n)
	}
	return pairingID, device, closed, client, dials
}

func waitDeviceClosed(t *testing.T, closed <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-closed:
	// testWait, not a tight 5s: same liveness-not-latency reasoning as testWait
	// itself, and time.After is the shape the earlier sweep for
	// context.WithTimeout deadlines did not see.
	case <-time.After(testWait):
		t.Fatalf("%s: the relay never closed the device leg", what)
	}
}

// waitClose drains a leg until it ends and reports the close status. Unlike
// expectClose it tolerates frames still in flight — a shim call already
// delivered but never answered leaves one queued ahead of the close.
func waitClose(t *testing.T, conn *websocket.Conn, want websocket.StatusCode, what string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	defer cancel()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			if got := websocket.CloseStatus(err); got != want {
				t.Fatalf("%s: close status %d, want %d (err: %v)", what, got, want, err)
			}
			return
		}
	}
}

// TestShimStopsDialingWhenTheRelaySaysThePairingIsGone: revoking leaves the
// account with no pairing at all, so the relay closes the shim leg with 4404.
// Every redial from here re-runs a dial that can only 401 — the shim must stop
// and say to re-pair.
func TestShimStopsDialingWhenTheRelaySaysThePairingIsGone(t *testing.T) {
	f := newRelayFixture(t)
	_, _, deviceClosed, client, dials := liveShim(t, f)

	if rec := f.do(http.MethodDelete, "/api/mcp/pairings", nil, f.session); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/mcp/pairings = %d, body %q", rec.Code, rec.Body.String())
	}
	waitDeviceClosed(t, deviceClosed, "after revoke")

	err := call(t, client)
	if !errors.Is(err, mcpshim.ErrPairingGone) {
		t.Fatalf("call after revoke = %v, want ErrPairingGone", err)
	}
	if n := dials.n.Load(); n != 1 {
		t.Fatalf("the shim dialed %d times after a 4404, want 1 (no redial)", n)
	}
	// And it stays terminal: a second call must not restart the dialing either.
	if err := call(t, client); !errors.Is(err, mcpshim.ErrPairingGone) {
		t.Fatalf("second call after revoke = %v, want ErrPairingGone", err)
	}
	if n := dials.n.Load(); n != 1 {
		t.Fatalf("the shim dialed %d times over two calls after a 4404, want 1", n)
	}
}

// TestShimStopsDialingWhenAnotherLegTakesThePairing: re-minting leaves the
// account WITH a pairing that this leg is not serving, so the relay closes it
// with 4409. Redialing only re-runs the same lost race, and the answer is not
// "re-pair, your pairing is gone" — it is a different sentence about a
// different situation.
func TestShimStopsDialingWhenAnotherLegTakesThePairing(t *testing.T) {
	f := newRelayFixture(t)
	oldID, _, deviceClosed, client, dials := liveShim(t, f)

	if newID := f.mint(t); newID == oldID {
		t.Fatal("re-minting returned the same pairing id")
	}
	waitDeviceClosed(t, deviceClosed, "after a re-mint")

	err := call(t, client)
	if !errors.Is(err, mcpshim.ErrPairingReplaced) {
		t.Fatalf("call after a re-mint = %v, want ErrPairingReplaced", err)
	}
	if errors.Is(err, mcpshim.ErrPairingGone) {
		t.Fatal("4409 was reported as 4404: those must never be conflated")
	}
	if n := dials.n.Load(); n != 1 {
		t.Fatalf("the shim dialed %d times after a 4409, want 1 (no redial)", n)
	}
}

// TestShimStillReconnectsWhenTheDeviceLegDrops is the regression guard on the
// fix: an ordinary drop — here the relay closing the shim leg because its peer
// went away — is exactly what reconnect exists for and must keep redialing.
// Breaking this would be worse than the bug above.
func TestShimStillReconnectsWhenTheDeviceLegDrops(t *testing.T) {
	f := newRelayFixture(t)
	pairingID, device, deviceClosed, client, dials := liveShim(t, f)
	rec := f.liveRecord(t, pairingID)

	device.CloseNow()
	waitDeviceClosed(t, deviceClosed, "after the device leg dropped")

	// deviceClosed is not an edge here, unlike in the two tests above: THIS test
	// closed the device leg itself, so the channel fires on its own CloseNow and
	// says nothing about what the relay has done yet. What has to happen before a
	// redial can be asserted is the relay retiring the shim leg its device went
	// away from — so wait for that rather than for a side effect of our own call.
	//
	// Without this the test raced its own subject twice, and BOTH outcomes were
	// measured under load: the call went through on the still-live old shim leg
	// and "the shim dialed 1 times" failed at 0.03s, or the old shim leg's
	// teardown landed after the fresh device leg had registered and took it down
	// with it — which cost the full 30s CallTimeout and reported ErrDeviceOffline.
	// retirePeer fixes the second one for real users; this wait is what makes the
	// dial-count assertion mean what it says.
	waitUntil(t, "the relay to retire the shim leg whose device went away", func() bool {
		return rec.peerConn(true) == nil // the shim slot, seen from the device side
	})

	// A fresh tab comes back on the device leg, which is what the user does.
	reconnected := f.dialDevice(t, pairingID)
	go respondOnDevice(t, reconnected, f.key, pairingID)

	if err := call(t, client); err != nil {
		t.Fatalf("call after an ordinary drop = %v, want a successful reconnect", err)
	}
	if n := dials.n.Load(); n < 2 {
		t.Fatalf("the shim dialed %d times, want a redial after a non-terminal close", n)
	}
}

// TestTheThreeShimFailureMessagesAreDistinguishable. Conflating them IS the
// bug: all three are shown verbatim to the model, and "no tab is open" (wait
// and retry), "the pairing is gone" (re-pair) and "another connection took
// over" (stop the other one) call for three different actions. Each is observed
// through the real relay rather than read off the package vars.
func TestTheThreeShimFailureMessagesAreDistinguishable(t *testing.T) {
	old := mcpshim.CallTimeout
	mcpshim.CallTimeout = 250 * time.Millisecond
	t.Cleanup(func() { mcpshim.CallTimeout = old })

	// Offline: the pairing is fine, the relay is up, no responder is listening.
	offlineF := newRelayFixture(t)
	offlineID := offlineF.mint(t)
	offlineF.dialDevice(t, offlineID)
	offlineClient, _ := shimClient(t, offlineF, offlineID)
	offline := call(t, offlineClient)

	goneF := newRelayFixture(t)
	goneID := goneF.mint(t)
	goneDevice := goneF.dialDevice(t, goneID)
	goneClient, _ := shimClient(t, goneF, goneID)
	if err := call(t, goneClient); !errors.Is(err, mcpshim.ErrDeviceOffline) {
		t.Fatalf("priming call = %v, want ErrDeviceOffline", err)
	}
	goneF.do(http.MethodDelete, "/api/mcp/pairings", nil, goneF.session)
	waitClose(t, goneDevice, StatusNoPairing, "device leg after revoke")
	gone := call(t, goneClient)

	replacedF := newRelayFixture(t)
	replacedID := replacedF.mint(t)
	replacedDevice := replacedF.dialDevice(t, replacedID)
	replacedClient, _ := shimClient(t, replacedF, replacedID)
	if err := call(t, replacedClient); !errors.Is(err, mcpshim.ErrDeviceOffline) {
		t.Fatalf("priming call = %v, want ErrDeviceOffline", err)
	}
	replacedF.mint(t)
	waitClose(t, replacedDevice, StatusPairingReplaced, "device leg after a re-mint")
	replaced := call(t, replacedClient)

	for _, tc := range []struct {
		name string
		got  error
		want error
	}{
		{"offline", offline, mcpshim.ErrDeviceOffline},
		{"gone", gone, mcpshim.ErrPairingGone},
		{"replaced", replaced, mcpshim.ErrPairingReplaced},
	} {
		if !errors.Is(tc.got, tc.want) {
			t.Fatalf("%s case = %v, want %v", tc.name, tc.got, tc.want)
		}
		for _, other := range []error{mcpshim.ErrDeviceOffline, mcpshim.ErrPairingGone, mcpshim.ErrPairingReplaced} {
			if other != tc.want && errors.Is(tc.got, other) {
				t.Fatalf("%s case also matches %v: these must be mutually exclusive", tc.name, other)
			}
		}
	}

	// Text, not just identity: the model reads the sentence, so no two of them
	// may be confusable with each other.
	msgs := []string{offline.Error(), gone.Error(), replaced.Error()}
	for i, a := range msgs {
		for j, b := range msgs {
			if i != j && (a == b || strings.Contains(a, b) || strings.Contains(b, a)) {
				t.Fatalf("message %d and %d are not distinguishable:\n%s\n%s", i, j, a, b)
			}
		}
	}
	// Each has to name its own remedy, or the user learns nothing from it.
	if !strings.Contains(gone.Error(), "re-pair from Settings") {
		t.Fatalf("the 4404 message does not tell the user to re-pair: %s", gone.Error())
	}
	if !strings.Contains(replaced.Error(), "took over this pairing") {
		t.Fatalf("the 4409 message does not say another connection took over: %s", replaced.Error())
	}
}
