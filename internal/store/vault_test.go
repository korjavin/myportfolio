package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func newVaultStore(t *testing.T) *DB {
	t.Helper()
	db, err := Open(context.Background(), t.TempDir()+"/vault.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func seedAccount(t *testing.T, db *DB, accountID string) {
	t.Helper()
	err := db.CreateAccountWithCredential(t.Context(),
		Credential{ID: []byte("cred-" + accountID), AccountID: accountID, PublicKey: []byte("pk")},
		Envelope{AccountID: accountID, CredentialRef: "cred-ref", V: 1,
			Nonce: []byte("nonce"), CT: []byte("ct"), MAC: []byte("mac")},
		time.Now().UTC())
	if err != nil {
		t.Fatalf("CreateAccountWithCredential: %v", err)
	}
}

// The whole point of the one-transaction signup: a passkey must never exist
// without the envelope that unwraps its DEK, because that account can then
// never be unlocked and no retry can repair it.
func TestCreateAccountWithCredential_IsAtomic(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	creds, err := db.CredentialsByAccount(t.Context(), "ACCOUNT1")
	if err != nil || len(creds) != 1 {
		t.Fatalf("CredentialsByAccount = %d, err %v; want 1", len(creds), err)
	}
	if _, err := db.GetEnvelope(t.Context(), "ACCOUNT1", "cred-ref"); err != nil {
		t.Fatalf("GetEnvelope: %v", err)
	}

	// A colliding account id must not partially apply.
	err = db.CreateAccountWithCredential(t.Context(),
		Credential{ID: []byte("other-cred"), AccountID: "ACCOUNT1", PublicKey: []byte("pk")},
		Envelope{AccountID: "ACCOUNT1", CredentialRef: "other-ref", V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")},
		time.Now().UTC())
	if !errors.Is(err, ErrAccountExists) {
		t.Fatalf("duplicate account id: err = %v, want ErrAccountExists", err)
	}
	if _, err := db.GetEnvelope(t.Context(), "ACCOUNT1", "other-ref"); err == nil {
		t.Fatal("the rolled-back transaction still wrote its envelope")
	}
}

func TestAccountByCredentialID(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	got, err := db.AccountByCredentialID(t.Context(), []byte("cred-ACCOUNT1"))
	if err != nil || got != "ACCOUNT1" {
		t.Fatalf("AccountByCredentialID = %q, %v; want ACCOUNT1", got, err)
	}
	if _, err := db.AccountByCredentialID(t.Context(), []byte("nobody")); err == nil {
		t.Fatal("an unknown credential resolved to an account")
	}
}

func TestPutState_CompareAndSwap(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	// Fresh account: nothing stored, so a GET is nil and the first write is at
	// last-read 0 and lands as version 1.
	blob, err := db.GetState(t.Context(), "ACCOUNT1")
	if err != nil || blob != nil {
		t.Fatalf("GetState on a fresh account = %+v, %v; want nil, nil", blob, err)
	}

	stored, err := db.PutState(t.Context(), "ACCOUNT1", 0, []byte("nonce1"), []byte("blob1"), time.Now().UTC())
	if err != nil || stored.Version != 1 {
		t.Fatalf("first PutState = %+v, %v; want version 1", stored, err)
	}

	// A repeat at the same last-read is stale and gets the current blob back.
	current, err := db.PutState(t.Context(), "ACCOUNT1", 0, []byte("nonce2"), []byte("blob2"), time.Now().UTC())
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale PutState err = %v, want ErrVersionConflict", err)
	}
	if current == nil || current.Version != 1 || string(current.CT) != "blob1" {
		t.Fatalf("conflict returned %+v, want the stored version 1 / blob1", current)
	}

	// And a write at the right last-read advances.
	stored, err = db.PutState(t.Context(), "ACCOUNT1", 1, []byte("nonce2"), []byte("blob2"), time.Now().UTC())
	if err != nil || stored.Version != 2 {
		t.Fatalf("second PutState = %+v, %v; want version 2", stored, err)
	}
}

// A caller claiming a version for a blob that does not exist at all: still a
// conflict, but there is no current blob to hand back.
func TestPutState_ConflictWithNoStoredBlob(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	current, err := db.PutState(t.Context(), "ACCOUNT1", 7, []byte("n"), []byte("c"), time.Now().UTC())
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("err = %v, want ErrVersionConflict", err)
	}
	if current != nil {
		t.Fatalf("conflict returned %+v, want nil — there is no blob", current)
	}
}

func TestSetRecoveryMaterial_WritesEnvelopeAndVerifierTogether(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")

	err := db.SetRecoveryMaterial(t.Context(), "ACCOUNT1",
		Envelope{V: 1, Nonce: []byte("n"), CT: []byte("rec-ct"), MAC: []byte("m")},
		[]byte("hashed-verifier"))
	if err != nil {
		t.Fatalf("SetRecoveryMaterial: %v", err)
	}

	env, err := db.GetEnvelope(t.Context(), "ACCOUNT1", RecoveryRef)
	if err != nil || string(env.CT) != "rec-ct" {
		t.Fatalf("recovery envelope = %+v, %v", env, err)
	}
	var hash []byte
	if err := db.QueryRowContext(t.Context(),
		`SELECT recovery_verifier_hash FROM accounts WHERE id = ?`, "ACCOUNT1").Scan(&hash); err != nil {
		t.Fatalf("read verifier hash: %v", err)
	}
	if string(hash) != "hashed-verifier" {
		t.Fatalf("verifier hash = %q", hash)
	}
}

// Sessions must survive a restart, so the secret must be persisted rather than
// regenerated per process — otherwise every deploy silently signs everyone out.
func TestSessionSecret_IsStableAcrossOpens(t *testing.T) {
	path := t.TempDir() + "/secret.db"

	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first, err := db.SessionSecret(t.Context())
	if err != nil {
		t.Fatalf("SessionSecret: %v", err)
	}
	again, err := db.SessionSecret(t.Context())
	if err != nil || again != first {
		t.Fatalf("SessionSecret on the same handle = %q, want the stable %q (err %v)", again, first, err)
	}
	db.Close()

	reopened, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	defer reopened.Close()
	afterRestart, err := reopened.SessionSecret(t.Context())
	if err != nil || afterRestart != first {
		t.Fatalf("SessionSecret after restart = %q, want %q (err %v)", afterRestart, first, err)
	}
	if len(first) != 64 {
		t.Fatalf("session secret is %d hex chars, want 64 (32 bytes)", len(first))
	}
}

func TestTouchCredential_RecordsCounterWithoutRejecting(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")
	id := []byte("cred-ACCOUNT1")

	if err := db.TouchCredential(t.Context(), id, 5, time.Now().UTC()); err != nil {
		t.Fatalf("TouchCredential: %v", err)
	}
	// Platform authenticators report 0 forever. Going "backwards" must be
	// accepted, not treated as a clone — enforcing it locks out every synced
	// passkey.
	if err := db.TouchCredential(t.Context(), id, 0, time.Now().UTC()); err != nil {
		t.Fatalf("TouchCredential with a lower counter: %v", err)
	}
	creds, err := db.CredentialsByAccount(t.Context(), "ACCOUNT1")
	if err != nil || len(creds) != 1 || creds[0].SignCount != 0 {
		t.Fatalf("stored sign count = %+v, %v; want the latest value 0", creds, err)
	}
}

func TestCredentialExists(t *testing.T) {
	db := newVaultStore(t)
	seedAccount(t, db, "ACCOUNT1")
	seedAccount(t, db, "ACCOUNT2")

	ok, err := db.CredentialExists(t.Context(), "ACCOUNT1", []byte("cred-ACCOUNT1"))
	if err != nil || !ok {
		t.Fatalf("CredentialExists for its own account = %v, %v; want true", ok, err)
	}
	// A credential belonging to somebody else must not authenticate this
	// account, even though the id itself is real.
	ok, err = db.CredentialExists(t.Context(), "ACCOUNT1", []byte("cred-ACCOUNT2"))
	if err != nil || ok {
		t.Fatalf("CredentialExists across accounts = %v, %v; want false", ok, err)
	}
}
