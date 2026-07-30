// Command myportfolio serves the local-first investment-tracking PWA and its
// dumb sync server from a single origin.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/korjavin/myportfolio/internal/server"
	"github.com/korjavin/myportfolio/internal/store"
	"github.com/korjavin/myportfolio/web"
)

const shutdownGrace = 10 * time.Second

func main() {
	if err := run(); err != nil {
		slog.Error("myportfolio: exiting", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := env("MYPORTFOLIO_ADDR", ":8080")
	dbPath := env("MYPORTFOLIO_DB", "myportfolio.db")

	db, err := store.Open(ctx, dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	// Generated and persisted on first boot rather than configured: a
	// deployment that forgets to set a secret would otherwise either fail to
	// start or fall back to a default that makes every session cookie
	// forgeable. Persisting it also keeps sessions alive across restarts.
	sessionSecret, err := db.SessionSecret(ctx)
	if err != nil {
		return err
	}

	// Which reverse proxies may set the client's address for rate limiting.
	// Defaults to loopback only. Set this when the proxy reaches the app over a
	// Docker network or from another host — and do NOT set it when the app is
	// directly reachable, because then a forwarded-for header is just a string
	// the caller chose and the ceremony limiter would stop working.
	trustedProxies, err := server.ParseTrustedProxies(os.Getenv("MYPORTFOLIO_TRUSTED_PROXIES"))
	if err != nil {
		return err
	}

	// The pre-fetched quote universe (ARCHITECTURE.md §7,
	// internal/server/universe.go). Started here rather than inside server.New so
	// the handler is testable without a goroutine reaching for the internet, and
	// so it stops with the process's signal context.
	//
	// Nothing is configured for it: no API key anywhere, in the environment or in
	// the vault. It fetches a fixed symbol list from a keyless upstream and serves
	// one identical blob to everyone, and if that upstream is unavailable the app
	// falls back to the user's own key exactly as before.
	go server.StartQuoteUniverse(ctx, db)

	srv := &http.Server{
		Addr:    addr,
		Handler: server.New(web.StaticFS, db, sessionSecret, trustedProxies),
		// Slowloris guard: without it a client can hold a connection open
		// indefinitely by dribbling out request headers.
		ReadHeaderTimeout: 10 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		slog.Info("myportfolio: listening", "addr", addr, "db", dbPath)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
			return
		}
		errc <- nil
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	// Drain in-flight requests before the deferred db.Close, so no handler is
	// cut off mid-write against a closing SQLite handle.
	slog.Info("myportfolio: shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
