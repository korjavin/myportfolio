// Package store owns myportfolio's SQLite database: opening it with the
// project's pragmas and applying the numbered migrations at boot.
//
// The server is deliberately dumb (ARCHITECTURE.md principle 2) — it holds one
// opaque encrypted blob per account plus WebAuthn material — so this package
// stays a thin schema owner rather than growing a query layer of its own.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, so CGO_ENABLED=0 still yields one static binary
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// DB is the shared SQLite handle. It embeds *sql.DB so callers use
// Query/Exec/QueryRow directly.
type DB struct {
	*sql.DB
}

// Open opens (creating if absent) the SQLite database at path and brings its
// schema up to date. Migrations run here rather than in a separate exported
// step so there is exactly one call site and no way to boot an unmigrated
// server.
func Open(ctx context.Context, path string) (*DB, error) {
	sdb, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", path, err)
	}
	if err := sdb.PingContext(ctx); err != nil {
		sdb.Close()
		return nil, fmt.Errorf("store: ping %s: %w", path, err)
	}

	// WAL for Litestream-style replication; busy_timeout so a concurrent writer
	// retries instead of returning SQLITE_BUSY immediately; foreign_keys because
	// SQLite leaves enforcement OFF by default and every later table references
	// accounts(id). MaxOpenConns(1) keeps a single WAL writer, which also makes
	// the connection-scoped pragmas above stick for the process lifetime.
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := sdb.ExecContext(ctx, pragma); err != nil {
			sdb.Close()
			return nil, fmt.Errorf("store: %s: %w", pragma, err)
		}
	}
	sdb.SetMaxOpenConns(1)

	db := &DB{DB: sdb}
	if err := db.migrate(ctx); err != nil {
		sdb.Close()
		return nil, err
	}
	return db, nil
}

type migration struct {
	version int
	name    string
	body    string
}

// loadMigrations reads migrations/NNN_name.sql, ordered by NNN, and enforces
// that the numbers run contiguously from 001.
//
// The contiguity check is the point: with two tracks developing in parallel,
// two branches each adding an "002_" is the expected collision. Without this
// they merge cleanly and the second one is silently skipped forever on any
// database that already recorded version 2. Failing at boot is loud and cheap.
// fsys is a parameter only so the contiguity guard below is testable against a
// synthetic tree; production always passes migrationsFS.
func loadMigrations(fsys fs.FS) ([]migration, error) {
	names, err := fs.Glob(fsys, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("store: glob migrations: %w", err)
	}
	out := make([]migration, 0, len(names))
	for _, name := range names {
		base := path.Base(name)
		digits, _, ok := strings.Cut(base, "_")
		if !ok {
			return nil, fmt.Errorf("store: migration %q must be named NNN_description.sql", base)
		}
		version, err := strconv.Atoi(digits)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("store: migration %q has no positive integer version prefix", base)
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, fmt.Errorf("store: read %s: %w", name, err)
		}
		out = append(out, migration{version: version, name: base, body: string(body)})
	}
	// Sort by parsed version, not filename: "10_x.sql" must not sort before
	// "9_x.sql" just because '1' < '9'.
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i, m := range out {
		if m.version != i+1 {
			return nil, fmt.Errorf("store: migrations must be numbered contiguously from 001; found %q where %03d was expected", m.name, i+1)
		}
	}
	return out, nil
}

// migrate applies every migration not already recorded in schema_migrations,
// each in its own transaction (SQLite DDL is transactional, so a failure leaves
// no half-applied migration behind).
func (d *DB) migrate(ctx context.Context) error {
	migrations, err := loadMigrations(migrationsFS)
	if err != nil {
		return err
	}
	if _, err := d.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    applied_at_unix INTEGER NOT NULL
)`); err != nil {
		return fmt.Errorf("store: create schema_migrations: %w", err)
	}

	applied, err := d.appliedVersions(ctx)
	if err != nil {
		return err
	}
	for _, m := range migrations {
		if applied[m.version] {
			continue
		}
		if err := d.apply(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

func (d *DB) appliedVersions(ctx context.Context) (map[int]bool, error) {
	rows, err := d.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("store: read schema_migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[int]bool)
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			return nil, fmt.Errorf("store: scan schema_migrations: %w", err)
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: iterate schema_migrations: %w", err)
	}
	return applied, nil
}

func (d *DB) apply(ctx context.Context, m migration) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin %s: %w", m.name, err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	if _, err := tx.ExecContext(ctx, m.body); err != nil {
		return fmt.Errorf("store: apply %s: %w", m.name, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, name, applied_at_unix) VALUES (?, ?, ?)`,
		m.version, m.name, time.Now().Unix()); err != nil {
		return fmt.Errorf("store: record %s: %w", m.name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit %s: %w", m.name, err)
	}
	return nil
}
