package server

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"time"
)

// readyzTimeout bounds the database probe. A readiness check that can hang is
// worse than none: the orchestrator waits on it instead of restarting.
const readyzTimeout = 2 * time.Second

// readyDB is the one method readyz needs, so a test can hand it a closed
// database without standing up the whole store.
type readyDB interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type statusResponse struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// healthz is a liveness probe: it answers 200 unconditionally, so the container
// orchestrator's restart behavior depends only on the process being alive.
func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, statusResponse{Status: "ok"})
}

// readyz answers whether this instance can actually serve, by reading the
// database rather than asserting it is alive. Ported from medtracker's
// cloudserver/health.go, which learned this the hard way: a database that was
// locked, corrupt, or on a full disk reported perfectly healthy while every
// request failed.
//
// The probe is a real read of a real table, not a Ping. A Ping succeeds against
// a handle whose file has been deleted or whose schema never migrated; counting
// rows in accounts touches the B-tree and fails when the database is genuinely
// unusable. The count itself is deliberately NOT reported — this endpoint is
// unauthenticated, and how many people are on the box is not something a
// passer-by needs to learn.
func readyz(db readyDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readyzTimeout)
		defer cancel()

		var accounts int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM accounts`).Scan(&accounts); err != nil {
			// Logged, not returned: the error text can name the filesystem path.
			slog.Error("readyz: database unreadable", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, statusResponse{Status: "unready", Error: "database unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, statusResponse{Status: "ready"})
	}
}
