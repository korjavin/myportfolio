// Package web embeds the PWA assets so the server ships as one static binary
// (ARCHITECTURE.md 1).
package web

import (
	"embed"
	"io/fs"
)

// Embedded as one directory pattern rather than medtracker's explicit
// per-entry list (web/static/embed.go). Two tracks add files under web/static
// in parallel; an explicit list would make every new top-level asset directory
// a merge conflict on this file — and medtracker needed a whole embed_test.go
// just to catch entries someone forgot to add.
//
//go:embed static
var staticRoot embed.FS

// StaticFS is the web/static tree rooted at its own directory, so a path in it
// is what the browser asks for ("/js/core/crypto.js").
var StaticFS = mustSub(staticRoot, "static")

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic("web: sub " + dir + ": " + err.Error())
	}
	return sub
}
