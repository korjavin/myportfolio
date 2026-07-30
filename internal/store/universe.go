package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// GetQuoteUniverse returns the last stored universe blob and the unix second it
// was stored at, or (nil, 0, nil) when no refresh has ever succeeded.
//
// The bytes are returned verbatim because they are the response body: the
// endpoint's contract is that every caller gets the same bytes (ARCHITECTURE.md
// 7, bead myportfolio-18h.19), so nothing between here and the socket may
// re-encode them.
func (d *DB) GetQuoteUniverse(ctx context.Context) ([]byte, int64, error) {
	var (
		body      []byte
		updatedAt int64
	)
	err := d.QueryRowContext(ctx,
		`SELECT body, updated_at_unix FROM quote_universe WHERE id = 1`).Scan(&body, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("store: read quote universe: %w", err)
	}
	return body, updatedAt, nil
}

// PutQuoteUniverse replaces the single stored blob.
//
// It rejects an empty body rather than storing one, because "the refresh
// produced nothing" must never overwrite a good blob — a stale universe is
// serviceable and an empty one is not (bead landmine 2). The caller is expected
// to have merged in whatever the upstream failed to refresh; this is only the
// last line of defence.
func (d *DB) PutQuoteUniverse(ctx context.Context, body []byte, at time.Time) error {
	if len(body) == 0 {
		return errors.New("store: refusing to store an empty quote universe")
	}
	_, err := d.ExecContext(ctx,
		`INSERT INTO quote_universe (id, body, updated_at_unix) VALUES (1, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at_unix = excluded.updated_at_unix`,
		body, at.Unix())
	if err != nil {
		return fmt.Errorf("store: write quote universe: %w", err)
	}
	return nil
}
