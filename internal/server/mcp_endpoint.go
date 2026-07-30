package server

// The hosted MCP endpoint (ARCHITECTURE.md §11 Tier 2): the URL the user pastes
// into Claude or ChatGPT. Ported from medicationtrackerbot's
// internal/cloudserver/mcp_endpoint.go.
//
// It is an HTTP front door and nothing more. The frame crypto, the relay, the
// close codes, the browser responder and the catalog all already exist; this
// authenticates a token against mcp_remote.go's registry and hands the request
// to the SDK's streamable handler, which drives an internal mcpshim.Client — so
// there is one wire contract with Tier 1 and not two (the tools themselves are
// defined once, in mcpshim.NewToolServer).
//
// # This is the only route that answers without a session cookie
//
// It is reachable from the public internet by design, so every line here is a
// trust boundary:
//
//   - The token is the whole credential. It is compared in constant time
//     (registry.lookup), never logged, never echoed, and never put in an error
//     string — a 404 body says nothing about whether the token, the account or
//     the connector was the thing that did not exist.
//   - The body is capped, at the relay's own frame ceiling rather than the SDK's
//     4 MiB default: nothing larger than a relay frame can be forwarded anyway.
//   - A connector disabled between the token check and the call is refused,
//     because every call goes through entry.call — which re-checks revocation —
//     and never through entry.client.
//   - Failed token lookups are throttled per client IP and successful calls per
//     token, both on rate_limit.go's limiter. Never a second limiter keying on
//     RemoteAddr: clientIP's trusted-proxy handling is what keeps every user
//     behind a reverse proxy out of one shared bucket.
//   - No CSP change. This is server-to-server HTTP, not a browser fetch, so
//     connect-src needs no entry and widening the three-host budget for it would
//     be wrong.

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/korjavin/myportfolio/internal/mcpshim"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	hostedServerName    = "myportfolio-mcp-hosted"
	hostedServerVersion = "0.1.0"

	// hostedCallMax/-Window bound tool calls per TOKEN once authenticated, so a
	// retry-storming hosted client cannot hammer the relay-and-device round trip
	// unbounded. Keyed on the token because that is what identifies the account
	// here — there is no session and no subdomain — and it stays in memory
	// exactly as long as the live entry does.
	//
	// ponytail: the sibling's 60/min, not measured against real connector
	// traffic. Tune once claude.ai/ChatGPT usage is observed.
	hostedCallMax    = 60
	hostedCallWindow = time.Minute

	// hostedFailMax/-Window bound FAILED token lookups per client IP. This is
	// defence in depth and not the boundary: our token is 256 bits (mcp_remote.go
	// diverges from the sibling here, whose short typeable token made the
	// throttle load-bearing), so there is no brute-force story to stop. It costs
	// nothing and it caps the cheapest way to make this endpoint do work.
	//
	// It cannot be per-account like the sibling's: single origin (§8.2) means the
	// token is the only identifier we have until it is looked up, so there is no
	// account to key on at the point of failure.
	hostedFailMax    = 60
	hostedFailWindow = time.Minute

	// hostedSessionTimeout drops idle MCP sessions. A hosted client that walks
	// away otherwise keeps its session forever.
	hostedSessionTimeout = 30 * time.Minute
)

// hostedToolDescriptionSuffix is appended to BOTH tool descriptions. Ported from
// the sibling's constant of the same name and reworded for us.
//
// It goes in the tool description and that placement is the whole point. §11:
// Tier 2 gives up the blind-relay property, "and that is not a detail to bury" —
// for this server to speak MCP to Claude's servers it must hold the pairing key
// and seal frames on the browser's behalf, so it sees requests and responses in
// plaintext in transit. Said here, the model relays it to the user on first use;
// said in a settings screen, it is read once and never again. Do not water it
// down and do not move it to a doc.
//
// It also names Tier 1, because "use the other one" is the actionable half of the
// disclosure, and it states the device requirement up front so an agent does not
// have to fail a call to discover it.
const hostedToolDescriptionSuffix = " IMPORTANT — how this connector is wired, tell the user if they ask about privacy: this is myportfolio's HOSTED connector, and it sits between your AI client and the user's own unlocked browser tab by their explicit consent. The myportfolio server holds the pairing key for them and therefore sees these MCP requests and responses in plaintext while relaying them (it does not store them). This is NOT the end-to-end-encrypted option: the local mcpshim connector keeps the key on the user's own machine and leaves the server blind, and anyone who does not want the server in the middle should use that one instead. Every call needs a live, unlocked myportfolio browser tab, because the data is end-to-end encrypted and only that tab can answer; if none is online you get a clear error saying so instead of a hang."

// errRelayURLNotSelf is enable's rejection of a pairing code whose relay_url
// points somewhere other than this server — H3's handler should answer it with a
// 400. It never quotes the URL back: the caller submitted it, and the message is
// for a confused user rather than for someone probing what the server can reach.
var errRelayURLNotSelf = errors.New("server: mcp remote: this pairing code's relay_url is not this server")

// relayURLIsSelf reports whether relayURL is this server's own relay endpoint,
// reached over a WebSocket scheme. It is the SSRF guard on enable: the hosted
// client only ever dials the account's own origin, and mcp-pairing minted
// relay_url as "<ws|wss>://" + location.host + relayEndpoint, which is exactly
// the request's own Host.
//
// Where this diverges from the sibling, and it is the divergence §11 says already
// bit once: its relay_url is a bare ORIGIN, so its check requires an empty path.
// Ours carries the full relay endpoint, so requiring an empty path here would
// reject every legitimate code and porting the sibling's line verbatim is wrong
// in both directions.
//
// The port cannot simply be taken from the request: the Host header is
// caller-supplied, so trusting a port from it would let an authenticated caller
// aim the dial at any TCP port on this server's own IP — the same SSRF one step
// removed. So the port is pinned to what a real browser origin actually produces:
// none, the standard web ports, or this process's real listen port for the
// direct-port self-hosted case.
func relayURLIsSelf(relayURL, reqHost, listenPort string) bool {
	u, err := url.Parse(relayURL)
	if err != nil {
		return false
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return false
	}
	// Exactly the relay endpoint. A trailing slash is the one variation the shim
	// itself tolerates (shimLegURL trims it), so tolerate it identically.
	if strings.TrimSuffix(u.Path, "/") != relayEndpoint {
		return false
	}
	// Nothing may ride along: credentials, a query or a fragment in relay_url
	// would all be carried into the dial, and a legitimate code has none.
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	// url.Hostname strips the brackets from an IPv6 literal; stripPort does not.
	if u.Hostname() != strings.Trim(stripPort(reqHost), "[]") {
		return false
	}
	switch p := u.Port(); {
	case p == "" || p == "80" || p == "443":
		return true
	case listenPort != "" && p == listenPort:
		return true
	default:
		return false
	}
}

// serverListenPort returns the port this process is actually listening on for
// req (net/http stashes the listener address under LocalAddrContextKey). Empty
// when unavailable — a synthesized httptest.NewRequest, say — in which case
// relayURLIsSelf accepts only the standard web ports.
func serverListenPort(req *http.Request) string {
	addr, ok := req.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok || addr == nil {
		return ""
	}
	if _, port, err := net.SplitHostPort(addr.String()); err == nil {
		return port
	}
	return ""
}

// mcpEntryCtxKey carries the request's already-validated registry entry to the
// SDK's getServer callback.
//
// Stashing it, rather than looking the token up a second time in getServer, is
// what closes the gap between the check and the handoff: a second lookup could
// resolve differently — or not at all — because the user hit disconnect in
// between, and the SDK would answer "no server available" instead of the
// connector's own revocation text. The ENTRY is stashed and not entry.client,
// which is the other half: entry.call re-checks revocation on every call, while
// a bare client pointer would happily redial a pairing the user has revoked.
type mcpEntryCtxKey struct{}

func withMCPEntry(ctx context.Context, entry *mcpRemoteEntry) context.Context {
	return context.WithValue(ctx, mcpEntryCtxKey{}, entry)
}

func mcpEntryFromContext(ctx context.Context) *mcpRemoteEntry {
	entry, _ := ctx.Value(mcpEntryCtxKey{}).(*mcpRemoteEntry)
	return entry
}

// mcpEndpoint builds the handler mounted at /mcp/{token}. Built once at startup
// so the SDK handler's session table is shared across requests, which is what
// makes a stateful streamable session work at all.
func (a *API) mcpEndpoint() http.Handler {
	streamable := sdkmcp.NewStreamableHTTPHandler(func(r *http.Request) *sdkmcp.Server {
		entry := mcpEntryFromContext(r.Context())
		if entry == nil {
			// Unreachable through the wrapper below, which always stashes one.
			// Returning nil makes the SDK refuse the request rather than serve a
			// server with no connector behind it.
			return nil
		}
		return mcpshim.NewToolServer(hostedServerName, hostedServerVersion, hostedToolDescriptionSuffix, entry.call)
	}, &sdkmcp.StreamableHTTPOptions{
		SessionTimeout: hostedSessionTimeout,
		// The relay's own per-frame ceiling. Nothing bigger can cross to the
		// device, so accepting more would only buy an attacker cheap allocation.
		MaxRequestBodyBytes: maxRelayFrameBytes,
		// The SDK's DNS-rebinding guard 403s any request whose Host is not
		// loopback when the LISTENER is — which is the ordinary self-hosted shape
		// here: MYPORTFOLIO_ADDR=127.0.0.1:8080 behind a reverse proxy on the
		// same host, exactly the topology defaultTrustedProxies exists for. The
		// guard protects browser-driven flows that trust an origin or a cookie;
		// this route trusts neither — the token in the path is its entire auth
		// boundary — so here it is a false positive with no upside.
		DisableLocalhostProtection: true,
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry := a.mcpRemote.lookup(r.PathValue("token"))
		if entry == nil {
			// One uniform rejection for every failure — no such token, a token
			// for a connector the user disabled, a revoked one. A 404 that
			// distinguished them would confirm which tokens exist.
			if !a.mcpFailLimiter.Allow(clientIP(r, a.trustedProxies)) {
				http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
				return
			}
			http.NotFound(w, r)
			return
		}
		if !a.mcpCallLimiter.Allow(entry.token) {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		streamable.ServeHTTP(w, r.WithContext(withMCPEntry(r.Context(), entry)))
	})
}
