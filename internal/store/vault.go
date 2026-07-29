package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// ErrAccountExists is returned when CreateAccountWithCredential collides with an
// existing account or credential id.
var ErrAccountExists = errors.New("store: account or credential already exists")

// ErrVersionConflict is returned by PutState when the caller's last-read
// version is not the version currently stored — the compare half of the
// compare-and-swap failed and the caller is stale (ARCHITECTURE.md 6). The
// blob PutState returns alongside it is the winner's, so the handler can hand
// it straight back in the 409 without a second, racy read.
var ErrVersionConflict = errors.New("store: state version conflict")

// Credential is one registered passkey.
type Credential struct {
	ID             []byte
	AccountID      string
	PublicKey      []byte
	Transports     string
	SignCount      uint32
	BackupEligible bool
	BackupState    bool
	CreatedAt      time.Time
}

// Envelope is a DEK wrapped under one credential's KEK (or under the recovery
// code's KEK_rec, with CredentialRef "recovery"). Nonce/CT/MAC are opaque here.
type Envelope struct {
	AccountID     string
	CredentialRef string
	V             int
	Nonce         []byte
	CT            []byte
	MAC           []byte
}

// StateBlob is an account's whole encrypted state at one CAS version.
type StateBlob struct {
	Version int64
	Nonce   []byte
	CT      []byte
}

// SessionSecret returns the process's session-cookie HMAC key, generating and
// persisting one on first call.
//
// Deliberately not an environment variable: a self-hosted deployment that
// forgets to set one would otherwise either fail to boot or — far worse —
// fall back to a default, and every session cookie in the world would be
// forgeable. Persisting it also means restarting the binary does not sign
// everyone out, which a per-process random secret would.
func (d *DB) SessionSecret(ctx context.Context) (string, error) {
	const name = "session_hmac"

	var secret []byte
	err := d.QueryRowContext(ctx, `SELECT secret FROM server_secrets WHERE name = ?`, name).Scan(&secret)
	if err == nil {
		return hex.EncodeToString(secret), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("store: read session secret: %w", err)
	}

	fresh := make([]byte, 32)
	if _, err := rand.Read(fresh); err != nil {
		return "", fmt.Errorf("store: generate session secret: %w", err)
	}
	// INSERT OR IGNORE, then re-read: two processes racing on first boot must
	// converge on ONE secret, not each keep its own and invalidate the other's
	// cookies.
	if _, err := d.ExecContext(ctx,
		`INSERT OR IGNORE INTO server_secrets (name, secret, created_at_unix) VALUES (?, ?, ?)`,
		name, fresh, time.Now().Unix()); err != nil {
		return "", fmt.Errorf("store: write session secret: %w", err)
	}
	if err := d.QueryRowContext(ctx, `SELECT secret FROM server_secrets WHERE name = ?`, name).Scan(&secret); err != nil {
		return "", fmt.Errorf("store: read back session secret: %w", err)
	}
	return hex.EncodeToString(secret), nil
}

// CreateAccountWithCredential is signup's single transaction: the account, its
// first passkey, and that passkey's DEK envelope land together or not at all.
//
// The atomicity is the point (bead A3). A crash between the credential and the
// envelope would leave a passkey with nothing to unwrap, which dead-ends cold
// unlock permanently — the user holds a working credential for an account whose
// DEK is unreachable, and no retry can fix it because the credential already
// exists.
func (d *DB) CreateAccountWithCredential(ctx context.Context, cred Credential, env Envelope, now time.Time) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin signup: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO accounts (id, created_at_unix) VALUES (?, ?)`,
		cred.AccountID, now.Unix()); err != nil {
		return fmt.Errorf("%w: %v", ErrAccountExists, err)
	}
	if err := insertCredential(ctx, tx, cred, now); err != nil {
		return err
	}
	if err := upsertEnvelope(ctx, tx, env); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit signup: %w", err)
	}
	return nil
}

func insertCredential(ctx context.Context, tx *sql.Tx, c Credential, now time.Time) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO credentials
		 (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.AccountID, c.PublicKey, c.Transports, c.SignCount, c.BackupEligible, c.BackupState, now.Unix())
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAccountExists, err)
	}
	return nil
}

func upsertEnvelope(ctx context.Context, tx *sql.Tx, e Envelope) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct, mac)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (account_id, credential_ref)
		 DO UPDATE SET v = excluded.v, nonce = excluded.nonce, ct = excluded.ct, mac = excluded.mac`,
		e.AccountID, e.CredentialRef, e.V, e.Nonce, e.CT, e.MAC)
	if err != nil {
		return fmt.Errorf("store: write envelope: %w", err)
	}
	return nil
}

// AccountByCredentialID resolves the account owning a credential. This is the
// single-origin cold-unlock lookup (ARCHITECTURE.md 8.2): the client does not
// know its account id before the ceremony, so the asserted credential is what
// names it. Returns sql.ErrNoRows for an unknown credential.
func (d *DB) AccountByCredentialID(ctx context.Context, credentialID []byte) (string, error) {
	var accountID string
	if err := d.QueryRowContext(ctx,
		`SELECT account_id FROM credentials WHERE id = ?`, credentialID).Scan(&accountID); err != nil {
		return "", err
	}
	return accountID, nil
}

// CredentialsByAccount lists an account's registered passkeys.
func (d *DB) CredentialsByAccount(ctx context.Context, accountID string) ([]Credential, error) {
	rows, err := d.QueryContext(ctx,
		`SELECT id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix
		 FROM credentials WHERE account_id = ? ORDER BY created_at_unix`, accountID)
	if err != nil {
		return nil, fmt.Errorf("store: list credentials: %w", err)
	}
	defer rows.Close()

	var out []Credential
	for rows.Next() {
		var c Credential
		var createdAt int64
		if err := rows.Scan(&c.ID, &c.AccountID, &c.PublicKey, &c.Transports,
			&c.SignCount, &c.BackupEligible, &c.BackupState, &createdAt); err != nil {
			return nil, fmt.Errorf("store: scan credential: %w", err)
		}
		c.CreatedAt = time.Unix(createdAt, 0).UTC()
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: iterate credentials: %w", err)
	}
	return out, nil
}

// CredentialExists reports whether credentialID is still registered to
// accountID. RequireSession calls it on every request so that revoking a device
// (A7) takes effect immediately rather than whenever its 30-day session cookie
// happens to expire.
func (d *DB) CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error) {
	var one int
	err := d.QueryRowContext(ctx,
		`SELECT 1 FROM credentials WHERE account_id = ? AND id = ?`, accountID, credentialID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("store: credential lookup: %w", err)
	}
	return true, nil
}

// TouchCredential records an assertion's sign counter and time.
//
// Recorded, never enforced: platform authenticators report 0 forever, so a
// "counter did not increase" rule would reject every synced passkey. Clone
// detection is not available to us and pretending otherwise would only produce
// false lockouts (ARCHITECTURE.md 8, bead A4).
func (d *DB) TouchCredential(ctx context.Context, credentialID []byte, signCount uint32, at time.Time) error {
	if _, err := d.ExecContext(ctx,
		`UPDATE credentials SET sign_count = ?, last_used_at_unix = ? WHERE id = ?`,
		signCount, at.Unix(), credentialID); err != nil {
		return fmt.Errorf("store: touch credential: %w", err)
	}
	return nil
}

// GetEnvelope returns one envelope, or sql.ErrNoRows.
func (d *DB) GetEnvelope(ctx context.Context, accountID, credentialRef string) (*Envelope, error) {
	e := Envelope{AccountID: accountID, CredentialRef: credentialRef}
	if err := d.QueryRowContext(ctx,
		`SELECT v, nonce, ct, mac FROM envelopes WHERE account_id = ? AND credential_ref = ?`,
		accountID, credentialRef).Scan(&e.V, &e.Nonce, &e.CT, &e.MAC); err != nil {
		return nil, err
	}
	return &e, nil
}

// SetRecoveryMaterial writes the Emergency Kit's envelope and SHA-256(verifier)
// in one transaction. Splitting them would let a partial failure pair a new
// envelope with the old verifier: one code then authenticates but cannot
// decrypt, the other decrypts but cannot authenticate, and the account is
// silently unrecoverable.
func (d *DB) SetRecoveryMaterial(ctx context.Context, accountID string, env Envelope, verifierHash []byte) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin recovery material: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	env.AccountID = accountID
	env.CredentialRef = RecoveryRef
	if err := upsertEnvelope(ctx, tx, env); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE accounts SET recovery_verifier_hash = ? WHERE id = ?`, verifierHash, accountID); err != nil {
		return fmt.Errorf("store: write recovery verifier: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit recovery material: %w", err)
	}
	return nil
}

// RecoveryVerifierHash returns the stored SHA-256(verifier) for accountID, or
// nil when the account does not exist or has never uploaded recovery material.
//
// The two cases are deliberately indistinguishable to the caller: the
// redemption endpoint must answer identically for a wrong code and an account
// id that was never real, or it becomes an account-existence oracle.
func (d *DB) RecoveryVerifierHash(ctx context.Context, accountID string) ([]byte, error) {
	var hash []byte
	err := d.QueryRowContext(ctx,
		`SELECT recovery_verifier_hash FROM accounts WHERE id = ?`, accountID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: read recovery verifier: %w", err)
	}
	return hash, nil
}

// EnrollRecoveredCredential is Path C's single transaction: the passkey enrolled
// against a redeemed recovery code, that passkey's DEK envelope, the ROTATED
// recovery envelope, and the hash of the new code's verifier all land together
// or not at all.
//
// The atomicity is what makes rotation non-optional rather than a prompt. The
// redeemed code has been typed into a machine, so it must stop opening the vault
// at the exact moment its replacement passkey starts working — not one HTTP
// request later, where a closed tab or a failed upload would leave a live code
// the user has been told is dead. Overwriting recovery_verifier_hash here IS the
// burn: the old verifier ceases to exist in the same commit.
func (d *DB) EnrollRecoveredCredential(ctx context.Context, cred Credential, env, recEnv Envelope, verifierHash []byte, now time.Time) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin recovery enrollment: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	if err := insertCredential(ctx, tx, cred, now); err != nil {
		return err
	}
	if err := upsertEnvelope(ctx, tx, env); err != nil {
		return err
	}
	recEnv.AccountID = cred.AccountID
	recEnv.CredentialRef = RecoveryRef
	if err := upsertEnvelope(ctx, tx, recEnv); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE accounts SET recovery_verifier_hash = ? WHERE id = ?`,
		verifierHash, cred.AccountID); err != nil {
		return fmt.Errorf("store: rotate recovery verifier: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit recovery enrollment: %w", err)
	}
	return nil
}

// RecoveryRef is the credential_ref reserved for the Emergency Kit's envelope.
// It can never collide with a real credential ref, which is base64url and
// therefore never contains a lowercase word with no padding ambiguity — but the
// reservation is enforced explicitly at the HTTP layer regardless.
const RecoveryRef = "recovery"

// GetState returns the account's current state blob, or nil when it has never
// uploaded one (a fresh account, which the API answers with 204).
func (d *DB) GetState(ctx context.Context, accountID string) (*StateBlob, error) {
	var b StateBlob
	err := d.QueryRowContext(ctx,
		`SELECT version, nonce, ct FROM state_blobs WHERE account_id = ?`, accountID).
		Scan(&b.Version, &b.Nonce, &b.CT)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: read state: %w", err)
	}
	return &b, nil
}

// PutState is the compare-and-swap of ARCHITECTURE.md 6. lastRead is the
// version the caller last saw (0 for an account with no blob yet); on success
// the blob is stored as lastRead+1 and returned at that version.
//
// A caller whose lastRead is not the stored version gets ErrVersionConflict and
// the CURRENT blob, which the handler returns in the 409 body. The server never
// merges — merging is the client's job (A6), because the server cannot read
// either side.
//
// Read and write share one transaction, and Open pins the pool to a single
// connection, so two simultaneous PUTs at the same version serialize: exactly
// one wins.
func (d *DB) PutState(ctx context.Context, accountID string, lastRead int64, nonce, ct []byte, now time.Time) (*StateBlob, error) {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("store: begin put state: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	var current *StateBlob
	var b StateBlob
	err = tx.QueryRowContext(ctx,
		`SELECT version, nonce, ct FROM state_blobs WHERE account_id = ?`, accountID).
		Scan(&b.Version, &b.Nonce, &b.CT)
	switch {
	case err == nil:
		current = &b
	case errors.Is(err, sql.ErrNoRows):
		current = nil
	default:
		return nil, fmt.Errorf("store: read state for CAS: %w", err)
	}

	var currentVersion int64
	if current != nil {
		currentVersion = current.Version
	}
	if lastRead != currentVersion {
		// current may be nil (caller claims a version for a blob that does not
		// exist); the handler reports version 0 in that case.
		return current, ErrVersionConflict
	}

	next := currentVersion + 1
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO state_blobs (account_id, version, nonce, ct, updated_at_unix)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (account_id)
		 DO UPDATE SET version = excluded.version, nonce = excluded.nonce,
		               ct = excluded.ct, updated_at_unix = excluded.updated_at_unix`,
		accountID, next, nonce, ct, now.Unix()); err != nil {
		return nil, fmt.Errorf("store: write state: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("store: commit state: %w", err)
	}
	return &StateBlob{Version: next, Nonce: nonce, CT: ct}, nil
}
