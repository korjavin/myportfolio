// Package web embeds the PWA assets so the server ships as one static binary
// (ARCHITECTURE.md 1).
package web

import (
	"embed"
	"io/fs"
	"strings"
)

// Embedded as one directory pattern rather than medtracker's explicit
// per-entry list (web/static/embed.go). Two tracks add files under web/static
// in parallel; an explicit list would make every new top-level asset directory
// a merge conflict on this file — and medtracker needed a whole embed_test.go
// just to catch entries someone forgot to add.
//
// The domain modules ARE listed one by one, and that is the opposite call on
// purpose. ARCHITECTURE.md 2 puts them OUTSIDE web/static (shared pure logic,
// not shell assets) while 10 has web/static/js/features import them directly —
// so they must be reachable at /domain/*.js or every feature module 404s and
// the app is unreachable code. The doc never said how the two directories meet
// on the wire; this is that answer. A `domain` directory pattern would also
// embed *.test.js and the 108 KB of Portfolio Performance fixtures into the
// binary and serve them publicly, and go:embed has no exclusion syntax. The
// drift this risks is covered by features.embed-domain.test.js, which fails if
// a /domain/ path the shell precaches is missing from this list.
//
//go:embed static
//go:embed domain/money.js domain/schema.js domain/portfolio.js domain/perf.js domain/ppimport.js
var webRoot embed.FS

// StaticFS answers the URLs the browser asks for: everything is the web/static
// tree rooted at its own directory ("/css/styles.css"), except the /domain/
// prefix, which is web/domain.
//
// Deliberately a prefix switch rather than a general union with web/static as
// the fallback: a fallback would also start answering "/static/css/styles.css"
// out of webRoot, which would silently resurrect the /static/-prefixed asset
// paths that have already 404'd twice in this repo. Those must keep failing.
var StaticFS fs.FS = splitFS{
	static: mustSub(webRoot, "static"),
	root:   webRoot,
}

type splitFS struct {
	static fs.FS // web/static, rooted — serves every path but /domain/...
	root   fs.FS // web/, unrooted — serves domain/... under its own name
}

func (s splitFS) Open(name string) (fs.File, error) {
	if name == "domain" || strings.HasPrefix(name, "domain/") {
		return s.root.Open(name)
	}
	return s.static.Open(name)
}

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic("web: sub " + dir + ": " + err.Error())
	}
	return sub
}
