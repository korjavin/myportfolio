package store

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func openTemp(t *testing.T) *DB {
	t.Helper()
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestOpenRunsMigrations(t *testing.T) {
	db := openTemp(t)

	// The accounts table exists only if 001 actually ran; /readyz probes it.
	var accounts int
	if err := db.QueryRow(`SELECT count(*) FROM accounts`).Scan(&accounts); err != nil {
		t.Fatalf("accounts table missing after Open: %v", err)
	}

	var version int
	if err := db.QueryRow(`SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatalf("schema_migrations: %v", err)
	}
	want, err := loadMigrations(migrationsFS)
	if err != nil {
		t.Fatalf("loadMigrations: %v", err)
	}
	if version != len(want) {
		t.Errorf("applied version = %d, want %d", version, len(want))
	}
}

// Reopening must be a no-op, not a re-apply: 001's CREATE TABLE would error on
// the second run if the applied-set were not consulted.
func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	for i := range 2 {
		db, err := Open(context.Background(), path)
		if err != nil {
			t.Fatalf("Open #%d: %v", i+1, err)
		}
		db.Close()
	}
}

func TestForeignKeysEnforced(t *testing.T) {
	db := openTemp(t)
	if _, err := db.Exec(`CREATE TABLE child (account_id TEXT REFERENCES accounts(id))`); err != nil {
		t.Fatalf("create child: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO child (account_id) VALUES ('nope')`); err == nil {
		t.Error("insert violating a foreign key succeeded; PRAGMA foreign_keys is not ON")
	}
}

func TestLoadMigrationsRejectsNonContiguous(t *testing.T) {
	tests := map[string]fstest.MapFS{
		"gap": {
			"migrations/001_init.sql":  &fstest.MapFile{Data: []byte("SELECT 1;")},
			"migrations/003_later.sql": &fstest.MapFile{Data: []byte("SELECT 1;")},
		},
		// The collision two parallel branches actually produce.
		"duplicate number": {
			"migrations/001_init.sql":  &fstest.MapFile{Data: []byte("SELECT 1;")},
			"migrations/002_a.sql":     &fstest.MapFile{Data: []byte("SELECT 1;")},
			"migrations/002_b.sql":     &fstest.MapFile{Data: []byte("SELECT 1;")},
			"migrations/003_after.sql": &fstest.MapFile{Data: []byte("SELECT 1;")},
		},
		"does not start at 1": {
			"migrations/002_init.sql": &fstest.MapFile{Data: []byte("SELECT 1;")},
		},
		"unnumbered": {
			"migrations/init.sql": &fstest.MapFile{Data: []byte("SELECT 1;")},
		},
	}
	for name, fsys := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := loadMigrations(fsys); err == nil {
				t.Fatal("loadMigrations accepted a non-contiguous migration set")
			}
		})
	}
}

// Numeric ordering, not lexical. Unpadded names sort "1","10","11","2",... as
// strings, so a filename sort would report a spurious contiguity failure — and,
// worse, apply migrations out of order.
func TestLoadMigrationsOrdersNumerically(t *testing.T) {
	fsys := fstest.MapFS{}
	for i := 1; i <= 11; i++ {
		fsys[fmt.Sprintf("migrations/%d_x.sql", i)] = &fstest.MapFile{Data: []byte("SELECT 1;")}
	}
	got, err := loadMigrations(fsys)
	if err != nil {
		t.Fatalf("loadMigrations: %v", err)
	}
	for i, m := range got {
		if m.version != i+1 {
			t.Fatalf("migration at index %d has version %d", i, m.version)
		}
	}
}
