package server

import (
	"bytes"
	"encoding/base64"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/korjavin/myportfolio/internal/mcpshim"
	"github.com/korjavin/myportfolio/internal/store"
)

// remoteFixture is a signed-up account plus a registry over its database, and
// the pairing key the browser would have generated. No websockets: nothing in
// this bead dials, so nothing here waits on one.
type remoteFixture struct {
	*vault
	account  string
	registry *mcpRemoteRegistry
	key      []byte
	pc       *mcpshim.PairingCode
}

func newRemoteFixture(t *testing.T) *remoteFixture {
	t.Helper()
	v := newVault(t)
	account, _, _ := v.signup()
	key := testPairingKey(t)
	return &remoteFixture{
		vault:    v,
		account:  account,
		registry: newMCPRemoteRegistry(v.db, testSessionSecret),
		key:      key,
		pc:       &mcpshim.PairingCode{RelayURL: "wss://vault.localhost/api/mcp/relay", PairingID: "pairing-1", Key: key},
	}
}

// restart builds a fresh registry over the same database and restores it — what
// a redeploy does, and the only way to observe whether the sealed key on disk is
// still openable.
func (f *remoteFixture) restart(t *testing.T, sessionSecret string) *mcpRemoteRegistry {
	t.Helper()
	next := newMCPRemoteRegistry(f.vault.db, sessionSecret)
	next.restore(t.Context())
	return next
}

func (f *remoteFixture) row(t *testing.T) (store.MCPRemote, bool) {
	t.Helper()
	rows, err := f.vault.db.ListMCPRemote(t.Context())
	if err != nil {
		t.Fatalf("ListMCPRemote: %v", err)
	}
	for _, r := range rows {
		if r.AccountID == f.account {
			return r, true
		}
	}
	return store.MCPRemote{}, false
}

// captureLog points slog's default handler at a buffer for the duration of one
// test, at Debug so nothing this package logs escapes the assertion.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// The bead's core acceptance: minted, resolved, revoked.
func TestMCPRemoteEnableLookupDisable(t *testing.T) {
	f := newRemoteFixture(t)

	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if f.registry.lookup(token) == nil {
		t.Fatal("the freshly minted token does not resolve")
	}
	if got, ok := f.registry.tokenFor(f.account); !ok || got != token {
		t.Errorf("tokenFor = %q, %v; want the minted token", got, ok)
	}
	row, ok := f.row(t)
	if !ok {
		t.Fatal("enable persisted no row")
	}
	if bytes.Contains(row.PairingKeyCT, f.key) {
		t.Error("the persisted pairing key is not sealed — the plaintext is in the ciphertext column")
	}

	if err := f.registry.disable(t.Context(), f.account); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if f.registry.lookup(token) != nil {
		t.Error("the token still resolves after disable")
	}
	if _, ok := f.registry.tokenFor(f.account); ok {
		t.Error("tokenFor still reports a connector after disable")
	}
	if _, ok := f.row(t); ok {
		t.Error("disable left the sealed pairing key on disk — a revoked connector with a decryptable key is not revoked")
	}
}

// Revocation has to reach the entry itself, not only the map. A request that
// resolved its token a moment before the user hit disconnect still holds the
// pointer, and mcpshim.Client.Close leaves the client able to redial — so an
// entry that is merely deleted from the registry would keep answering.
func TestMCPRemoteRevokedEntryRefusesToDial(t *testing.T) {
	f := newRemoteFixture(t)
	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	// Exactly the race: the entry is in hand before the connector goes away.
	inFlight := f.registry.lookup(token)
	if inFlight == nil {
		t.Fatal("the freshly minted token does not resolve")
	}

	if err := f.registry.disable(t.Context(), f.account); err != nil {
		t.Fatalf("disable: %v", err)
	}
	// No dial is attempted, so this returns immediately rather than waiting out
	// the shim's reconnect budget against a relay URL nothing is listening on.
	if _, err := inFlight.call(t.Context(), "mcp_help", nil); !errors.Is(err, errConnectorRevoked) {
		t.Errorf("call through a revoked entry = %v, want errConnectorRevoked", err)
	}

	// Re-minting revokes the replaced entry for the same reason.
	if _, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest()); err != nil {
		t.Fatalf("re-enable: %v", err)
	}
	replaced := f.registry.lookup(f.mustToken(t))
	if _, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest()); err != nil {
		t.Fatalf("re-enable again: %v", err)
	}
	if _, err := replaced.call(t.Context(), "mcp_help", nil); !errors.Is(err, errConnectorRevoked) {
		t.Errorf("call through a re-minted-away entry = %v, want errConnectorRevoked", err)
	}
}

func (f *remoteFixture) mustToken(t *testing.T) string {
	t.Helper()
	token, ok := f.registry.tokenFor(f.account)
	if !ok {
		t.Fatal("no connector enabled")
	}
	return token
}

// A wrong token is rejected, and every rejection is uniform: nothing about the
// candidate distinguishes "no connector at all" from "wrong token".
func TestMCPRemoteLookupRejectsWrongTokens(t *testing.T) {
	f := newRemoteFixture(t)
	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}

	for name, candidate := range map[string]string{
		"empty":            "",
		"prefix":           token[:len(token)-1],
		"one byte flipped": flipLastChar(token),
		"case flipped":     strings.ToUpper(token),
		"longer":           token + "A",
		"other token":      strings.Repeat("A", len(token)),
	} {
		t.Run(name, func(t *testing.T) {
			if f.registry.lookup(candidate) != nil {
				t.Errorf("lookup(%s) resolved to a connector", name)
			}
		})
	}
}

func flipLastChar(token string) string {
	last := token[len(token)-1]
	if last == 'A' {
		return token[:len(token)-1] + "B"
	}
	return token[:len(token)-1] + "A"
}

// constantTimeTokenEqual is the comparison the endpoint's authentication rests
// on, so it is tested directly rather than only through lookup.
func TestConstantTimeTokenEqual(t *testing.T) {
	for name, tc := range map[string]struct {
		a, b string
		want bool
	}{
		"equal":              {"abcdef", "abcdef", true},
		"both empty":         {"", "", true},
		"shared prefix":      {"abcdef", "abcdeg", false},
		"shorter":            {"abcde", "abcdef", false},
		"longer":             {"abcdefg", "abcdef", false},
		"case differs":       {"abcdef", "ABCDEF", false},
		"one empty":          {"", "abcdef", false},
		"same length, wrong": {"aaaaaa", "bbbbbb", false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := constantTimeTokenEqual(tc.a, tc.b); got != tc.want {
				t.Errorf("constantTimeTokenEqual(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

// The §11 divergence, pinned: our token is high-entropy because the user copies
// a URL into a config and never retypes it. If someone ever shortens it to make
// it typeable, the brute-force argument comes back and this test is where they
// find out that a throttle would then have to become the security boundary.
func TestMCPRemoteTokenIsHighEntropy(t *testing.T) {
	f := newRemoteFixture(t)

	seen := make(map[string]bool)
	for range 8 {
		token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
		if err != nil {
			t.Fatalf("enable: %v", err)
		}
		raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
		if err != nil {
			t.Fatalf("token %q is not unpadded base64url, so it is not a clean URL path segment: %v", token, err)
		}
		if len(raw)*8 < 128 {
			t.Fatalf("token carries %d bits of entropy, want at least 128", len(raw)*8)
		}
		if seen[token] {
			t.Fatalf("token %q was minted twice", token)
		}
		seen[token] = true
	}
}

// Re-minting rotates the token AND drops the previous pairing key. The old token
// must stop authenticating the instant the new one exists, not at the next
// restart.
func TestMCPRemoteReEnableDropsThePreviousKeyAndToken(t *testing.T) {
	f := newRemoteFixture(t)

	first, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable first: %v", err)
	}
	firstRow, _ := f.row(t)

	second := &mcpshim.PairingCode{RelayURL: f.pc.RelayURL, PairingID: "pairing-2", Key: testPairingKey(t)}
	secondToken, err := f.registry.enable(t.Context(), f.account, second, selfRequest())
	if err != nil {
		t.Fatalf("enable second: %v", err)
	}
	if secondToken == first {
		t.Fatal("re-enabling did not rotate the token")
	}
	if f.registry.lookup(first) != nil {
		t.Error("the previous token still resolves after a re-mint")
	}
	if f.registry.lookup(secondToken) == nil {
		t.Error("the new token does not resolve")
	}

	row, ok := f.row(t)
	if !ok {
		t.Fatal("no row after re-enabling")
	}
	if bytes.Equal(row.PairingKeyCT, firstRow.PairingKeyCT) {
		t.Error("the previous sealed pairing key survived the re-mint")
	}
	opened, err := openPairingKey(testSessionSecret, row.PairingKeyCT, row.PairingKeyNonce)
	if err != nil || !bytes.Equal(opened, second.Key) {
		t.Errorf("stored key opens to %x (err %v), want the second pairing's key %x", opened, err, second.Key)
	}
}

// A connector configured in Claude must survive a redeploy: the token still
// resolves and the key on disk still opens to what the browser generated.
func TestMCPRemoteSurvivesARestart(t *testing.T) {
	f := newRemoteFixture(t)
	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}

	restored := f.restart(t, testSessionSecret)
	if restored.lookup(token) == nil {
		t.Error("the token does not resolve after a restart")
	}
	row, ok := f.row(t)
	if !ok {
		t.Fatal("the row vanished across a restart")
	}
	// What restore feeds the shim client, checked end to end through the disk.
	opened, err := openPairingKey(testSessionSecret, row.PairingKeyCT, row.PairingKeyNonce)
	if err != nil || !bytes.Equal(opened, f.key) {
		t.Errorf("stored key opens to %x (err %v), want %x", opened, err, f.key)
	}
}

// Rotating the session secret orphans every stored pairing key. The accepted
// outcome is "the connector stops working and the user re-pairs" — never "the
// server refuses to boot" and never "the connector authenticates with a key that
// silently cannot decrypt". The orphaned row must also stay deletable, which is
// why disable does not skip the database when the registry has no live entry.
func TestMCPRemoteRotatedSessionSecretOrphansTheConnector(t *testing.T) {
	f := newRemoteFixture(t)
	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}

	restored := f.restart(t, testSessionSecret+"-rotated")
	if restored.lookup(token) != nil {
		t.Error("a connector whose key cannot be opened was restored anyway; it would authenticate and then fail every call as 'no device online'")
	}
	if _, ok := f.row(t); !ok {
		t.Fatal("restore deleted the orphaned row; the user has no way to see or clear it")
	}
	if err := restored.disable(t.Context(), f.account); err != nil {
		t.Fatalf("disable an orphaned connector: %v", err)
	}
	if _, ok := f.row(t); ok {
		t.Error("disabling an orphaned connector left its key on disk")
	}
}

// One corrupt row must cost one account a re-pair, not the server's startup.
// restore is a boot path and New calls it, so a row it cannot handle has to be
// logged and skipped — and a wrong-length nonce is the case that does not merely
// fail to decrypt: cipher.AEAD.Open panics on it.
func TestMCPRemoteRestoreSurvivesACorruptRow(t *testing.T) {
	f := newRemoteFixture(t)
	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if _, err := f.vault.db.ExecContext(t.Context(),
		`UPDATE mcp_remote SET pairing_key_nonce = ? WHERE account_id = ?`, []byte{1, 2, 3}, f.account); err != nil {
		t.Fatalf("corrupt the nonce: %v", err)
	}

	// Panics here fail the test; that is the assertion.
	restored := f.restart(t, testSessionSecret)
	if restored.lookup(token) != nil {
		t.Error("a connector whose sealed key could not be read was restored anyway")
	}
	// And a fresh server boots rather than crashing on the same row.
	_ = New(testFS(), f.vault.db, testSessionSecret, defaultTrustedProxies)
}

// Deleting the account takes the key with it (the schema's ON DELETE CASCADE),
// so no restore can bring the connector back. There is no server-side
// account-delete path yet; when one lands it must ALSO call disable, because the
// cascade cannot reach the live in-memory entry of a running process.
func TestMCPRemoteAccountDeletionLeavesNoKey(t *testing.T) {
	f := newRemoteFixture(t)
	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}

	if _, err := f.vault.db.ExecContext(t.Context(), `DELETE FROM accounts WHERE id = ?`, f.account); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	if _, ok := f.row(t); ok {
		t.Fatal("deleting the account left its sealed pairing key on disk")
	}
	if f.restart(t, testSessionSecret).lookup(token) != nil {
		t.Error("the token still resolves after the account was deleted")
	}
}

// The token is a capability: it must never reach a log line, an error string, or
// anywhere else that gets shipped to a log aggregator. Every path that handles
// one runs here, including the failure paths, which are where a secret usually
// escapes.
func TestMCPRemoteTokenNeverReachesTheLog(t *testing.T) {
	f := newRemoteFixture(t)
	logged := captureLog(t)

	token, err := f.registry.enable(t.Context(), f.account, f.pc, selfRequest())
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	f.registry.lookup(token)
	f.registry.lookup("wrong-token-of-some-other-length")
	f.registry.tokenFor(f.account)
	rotated := f.restart(t, testSessionSecret+"-rotated") // logs the failed unseal
	rotated.restore(t.Context())
	f.restart(t, testSessionSecret) // logs a successful restore
	if err := f.registry.disable(t.Context(), f.account); err != nil {
		t.Fatalf("disable: %v", err)
	}
	// A failing enable, whose error string is the other place a token escapes.
	if _, err := f.registry.enable(t.Context(), "NO-SUCH-ACCOUNT", f.pc, selfRequest()); err == nil {
		t.Fatal("enable accepted an account that does not exist")
	} else if strings.Contains(err.Error(), token) {
		t.Error("a token appeared in an error string")
	}

	if strings.Contains(logged.String(), token) {
		t.Errorf("the connector token appeared in the log:\n%s", logged.String())
	}
	// A truncated token is still a large chunk of a capability, and it is how a
	// "safe prefix for correlation" habit would show up here.
	if strings.Contains(logged.String(), token[:12]) {
		t.Errorf("a prefix of the connector token appeared in the log:\n%s", logged.String())
	}
}

// A pairing key of the wrong length must be refused before anything is
// persisted: it would seal and store fine, then fail only at the browser's AEAD,
// which reaches the user as "no device online".
func TestMCPRemoteEnableRejectsAWrongLengthKey(t *testing.T) {
	f := newRemoteFixture(t)

	short := &mcpshim.PairingCode{RelayURL: f.pc.RelayURL, PairingID: "pairing-1", Key: f.key[:16]}
	if _, err := f.registry.enable(t.Context(), f.account, short, selfRequest()); err == nil {
		t.Fatal("enable accepted a 16-byte pairing key")
	}
	if _, ok := f.row(t); ok {
		t.Error("the rejected enable persisted a row anyway")
	}
}
