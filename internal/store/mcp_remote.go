package store

import (
	"context"
	"fmt"
	"time"
)

// MCPRemote is one account's enabled hosted connector (ARCHITECTURE.md §11
// Tier 2): the capability token its URL carries, the relay leg the server dials
// on the account's behalf, and that pairing's key SEALED.
//
// The key is never carried here in plaintext, in either direction — sealing and
// opening live in internal/server/mcp_seal.go, so this package stays a schema
// owner that cannot read what it stores. See 003_mcp_remote.sql for why this is
// the one table with a secret in it at all.
type MCPRemote struct {
	AccountID       string
	Token           string
	RelayURL        string
	PairingID       string
	PairingKeyCT    []byte
	PairingKeyNonce []byte
}

// UpsertMCPRemote enables the hosted connector for r.AccountID, replacing any
// existing enablement.
//
// Replacing is the point: re-minting has to leave NO trace of the previous
// pairing key, and one row per account with every secret column overwritten is
// what guarantees that. An insert-only table, or an update that spared the key
// columns, would leave a decryptable key behind for a connector the user
// believes they rotated.
func (d *DB) UpsertMCPRemote(ctx context.Context, r MCPRemote, now time.Time) error {
	if _, err := d.ExecContext(ctx,
		`INSERT INTO mcp_remote
		 (account_id, token, relay_url, pairing_id, pairing_key_ct, pairing_key_nonce, created_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (account_id)
		 DO UPDATE SET token = excluded.token, relay_url = excluded.relay_url,
		               pairing_id = excluded.pairing_id,
		               pairing_key_ct = excluded.pairing_key_ct,
		               pairing_key_nonce = excluded.pairing_key_nonce,
		               created_at_unix = excluded.created_at_unix`,
		r.AccountID, r.Token, r.RelayURL, r.PairingID, r.PairingKeyCT, r.PairingKeyNonce, now.Unix()); err != nil {
		// Deliberately no token in the message: it is a capability, and an error
		// string is the easiest place for one to reach a log. SQLite names the
		// column on a constraint violation, never the value.
		return fmt.Errorf("store: write mcp remote: %w", err)
	}
	return nil
}

// DeleteMCPRemote disables the hosted connector for accountID, dropping the
// sealed pairing key with it. Idempotent — deleting a row that is not there is
// success, because the caller's goal ("no key on disk for this account") holds
// either way.
func (d *DB) DeleteMCPRemote(ctx context.Context, accountID string) error {
	if _, err := d.ExecContext(ctx, `DELETE FROM mcp_remote WHERE account_id = ?`, accountID); err != nil {
		return fmt.Errorf("store: delete mcp remote: %w", err)
	}
	return nil
}

// ListMCPRemote returns every enabled connector, for the registry's rebuild at
// boot. Small by construction: one row per account that opted in.
func (d *DB) ListMCPRemote(ctx context.Context) ([]MCPRemote, error) {
	rows, err := d.QueryContext(ctx,
		`SELECT account_id, token, relay_url, pairing_id, pairing_key_ct, pairing_key_nonce
		 FROM mcp_remote ORDER BY created_at_unix`)
	if err != nil {
		return nil, fmt.Errorf("store: list mcp remote: %w", err)
	}
	defer rows.Close()

	var out []MCPRemote
	for rows.Next() {
		var r MCPRemote
		if err := rows.Scan(&r.AccountID, &r.Token, &r.RelayURL, &r.PairingID, &r.PairingKeyCT, &r.PairingKeyNonce); err != nil {
			return nil, fmt.Errorf("store: scan mcp remote: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: iterate mcp remote: %w", err)
	}
	return out, nil
}
