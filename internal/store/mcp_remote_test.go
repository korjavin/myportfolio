package store

import (
	"bytes"
	"testing"
	"time"
)

func mcpRemoteRow(accountID, token string) MCPRemote {
	return MCPRemote{
		AccountID:       accountID,
		Token:           token,
		RelayURL:        "wss://portfolio.example/api/mcp/relay",
		PairingID:       "pairing-" + accountID,
		PairingKeyCT:    []byte("sealed-" + token),
		PairingKeyNonce: []byte("nonce-" + token),
	}
}

// storedRemote reads accountID's row back, or reports that there is none.
func storedRemote(t *testing.T, db *DB, accountID string) (MCPRemote, bool) {
	t.Helper()
	rows, err := db.ListMCPRemote(t.Context())
	if err != nil {
		t.Fatalf("ListMCPRemote: %v", err)
	}
	for _, r := range rows {
		if r.AccountID == accountID {
			return r, true
		}
	}
	return MCPRemote{}, false
}

func TestUpsertMCPRemote_RoundTrips(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	want := mcpRemoteRow("ACCOUNT1", "tok-1")
	if err := db.UpsertMCPRemote(t.Context(), want, time.Now().UTC()); err != nil {
		t.Fatalf("UpsertMCPRemote: %v", err)
	}
	got, ok := storedRemote(t, db, "ACCOUNT1")
	if !ok {
		t.Fatal("no row after UpsertMCPRemote")
	}
	if got.Token != want.Token || got.RelayURL != want.RelayURL || got.PairingID != want.PairingID {
		t.Errorf("row = %+v, want %+v", got, want)
	}
	if !bytes.Equal(got.PairingKeyCT, want.PairingKeyCT) || !bytes.Equal(got.PairingKeyNonce, want.PairingKeyNonce) {
		t.Errorf("sealed key did not round-trip: ct %q nonce %q", got.PairingKeyCT, got.PairingKeyNonce)
	}
}

// Re-minting must leave NO trace of the previous pairing key: one row per
// account, every secret column overwritten. An insert that kept the old row, or
// an update that spared the key columns, would leave a decryptable key on disk
// for a connector the user believes they rotated.
func TestUpsertMCPRemote_ReplacesTheWholeRow(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	first := mcpRemoteRow("ACCOUNT1", "tok-first")
	if err := db.UpsertMCPRemote(t.Context(), first, time.Now().UTC()); err != nil {
		t.Fatalf("UpsertMCPRemote first: %v", err)
	}
	second := mcpRemoteRow("ACCOUNT1", "tok-second")
	second.PairingID = "pairing-rotated"
	if err := db.UpsertMCPRemote(t.Context(), second, time.Now().UTC()); err != nil {
		t.Fatalf("UpsertMCPRemote second: %v", err)
	}

	rows, err := db.ListMCPRemote(t.Context())
	if err != nil {
		t.Fatalf("ListMCPRemote: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("ListMCPRemote returned %d rows, want 1 — re-minting must replace, not accumulate", len(rows))
	}
	if rows[0].Token != "tok-second" || rows[0].PairingID != "pairing-rotated" {
		t.Errorf("row = %+v, want the second enablement", rows[0])
	}
	if bytes.Equal(rows[0].PairingKeyCT, first.PairingKeyCT) {
		t.Error("the previous pairing key ciphertext survived a re-mint")
	}
}

func TestDeleteMCPRemote_LeavesNoRow(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")
	if err := db.UpsertMCPRemote(t.Context(), mcpRemoteRow("ACCOUNT1", "tok-1"), time.Now().UTC()); err != nil {
		t.Fatalf("UpsertMCPRemote: %v", err)
	}

	if err := db.DeleteMCPRemote(t.Context(), "ACCOUNT1"); err != nil {
		t.Fatalf("DeleteMCPRemote: %v", err)
	}
	if _, ok := storedRemote(t, db, "ACCOUNT1"); ok {
		t.Error("the row survived DeleteMCPRemote — the sealed pairing key is still on disk")
	}
	// Idempotent: the caller's goal is "no key on disk", which already holds.
	if err := db.DeleteMCPRemote(t.Context(), "ACCOUNT1"); err != nil {
		t.Errorf("second DeleteMCPRemote: %v", err)
	}
}

// Deleting an account has to take its pairing key with it. There is no
// server-side account-delete path yet, so this pins the constraint that will
// make the first one correct without having to know this table exists.
func TestDeletingAnAccountCascadesToItsPairingKey(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")
	seedAccount(t, db, "ACCOUNT2")
	for _, id := range []string{"ACCOUNT1", "ACCOUNT2"} {
		if err := db.UpsertMCPRemote(t.Context(), mcpRemoteRow(id, "tok-"+id), time.Now().UTC()); err != nil {
			t.Fatalf("UpsertMCPRemote %s: %v", id, err)
		}
	}

	if _, err := db.ExecContext(t.Context(), `DELETE FROM accounts WHERE id = ?`, "ACCOUNT1"); err != nil {
		t.Fatalf("delete account: %v", err)
	}

	if _, ok := storedRemote(t, db, "ACCOUNT1"); ok {
		t.Error("deleting the account left its sealed pairing key behind")
	}
	if _, ok := storedRemote(t, db, "ACCOUNT2"); !ok {
		t.Error("deleting one account took another account's connector with it")
	}
}

// A connector cannot exist without the account it belongs to: an orphan row is a
// key nothing can ever revoke, because every revocation path is keyed by account.
func TestUpsertMCPRemote_RejectsAnUnknownAccount(t *testing.T) {
	db := newVaultStore(t)
	if err := db.UpsertMCPRemote(t.Context(), mcpRemoteRow("NOSUCHACCOUNT", "tok-1"), time.Now().UTC()); err == nil {
		t.Error("UpsertMCPRemote accepted a row for an account that does not exist")
	}
}
