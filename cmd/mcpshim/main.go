// Command mcpshim is the local half of the MCP blind relay (ARCHITECTURE.md
// §11): a stdio MCP server for Claude Desktop / Claude Code that forwards
// mcp_help and mcp_call to your own unlocked browser tab as encrypted frames,
// and brings the answers back. It holds the pairing key; the relay it talks
// through holds only ciphertext.
//
// Configuration is one environment variable, MYPORTFOLIO_MCP_CODE, holding
// the one-time code from the app's Connect Claude screen. There is no config
// file: the only setting is a secret, and a secret on disk is a secret to
// manage.
//
// The binary is deliberately thin — dial, crypto and correlation all live in
// internal/mcpshim so the tests can drive them without spawning a process.
//
// # stdout is the transport
//
// The MCP stdio transport IS this process's stdout. Any other write to it —
// a debug print, a stray fmt.Println, a library that logs to the default
// logger — lands in the middle of a JSON-RPC stream and corrupts the
// protocol. That presents as the connector "behaving erratically", which is
// a long way from the one-line cause. So every diagnostic in this binary
// goes to stderr, slog's default handler is repointed at stderr before
// anything can use it, and TestStdoutCarriesOnlyProtocolTraffic asserts it
// against the real built binary.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/korjavin/myportfolio/internal/mcpshim"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

const version = "0.1.0"

// codeEnvVar is this project's variable, not the sibling's
// MEDTRACKER_MCP_CODE: the two apps' codes carry different prefixes and
// different AAD labels, so a code in the wrong variable must fail loudly at
// parse rather than half-work.
const codeEnvVar = "MYPORTFOLIO_MCP_CODE"

// toolDescriptionSuffix is appended to both tool descriptions so the model
// learns the end-to-end-encrypted, device-required architecture up front
// instead of having to fail a call to discover it (ARCHITECTURE.md §11: "this
// is a real product limitation and belongs in the user-facing copy").
//
// This is Tier 1's suffix, and the claim "never to a server" is true only here.
// internal/server's Tier-2 hosted endpoint has its own, which says the opposite
// because for that tier the server does hold the key. The suffix is the ONLY
// thing the two tiers vary — the tools themselves are defined once, in
// mcpshim.NewToolServer.
const toolDescriptionSuffix = " This connector talks end-to-end encrypted directly to your own unlocked browser tab, never to a server — if no device is unlocked and online it returns a clear error instead of hanging."

func main() {
	// Before anything else: slog's package default writes to stderr already,
	// but say so explicitly so a future change to the default cannot quietly
	// route diagnostics into the MCP transport.
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	showVersion := flag.Bool("version", false, "print version and exit")
	flag.CommandLine.SetOutput(os.Stderr)
	flag.Parse()
	if *showVersion {
		// stderr, not stdout: -version is a human asking, and stdout belongs
		// to the protocol even on a run that never speaks it.
		fmt.Fprintln(os.Stderr, "mcpshim "+version)
		return
	}

	code := os.Getenv(codeEnvVar)
	if code == "" {
		slog.Error("[mcpshim] " + codeEnvVar + " is not set — open your portfolio, go to Settings › Connect Claude, and paste the one-time code into that variable")
		os.Exit(1)
	}

	// This exit is the whole reason a mistyped code is survivable, so the
	// message says which of the two failures this is.
	//
	// A pairing code carries a checksum (pairingcode.go), so a typo is caught
	// here and the process refuses to start. Without that, a wrong key parsed
	// cleanly, the shim connected, the relay dutifully piped frames the
	// browser could not open, and every call timed out into "no unlocked
	// device is online" — the design's own documented limitation, and
	// therefore the last thing anyone would think to question. Saying "this
	// is not the offline case" here, and "this is not a typo" in
	// ErrDeviceOffline, is what keeps the two apart.
	//
	// Note what is NOT logged: the error names the defect (wrong prefix, bad
	// base64, checksum mismatch, wrong key length) and never echoes the code,
	// because the code carries the pairing key.
	client, err := mcpshim.NewClient(code)
	if err != nil {
		slog.Error("[mcpshim] invalid "+codeEnvVar+" — the code itself is malformed (mistyped, truncated, or from a different app), which is NOT the same as 'no device online'. Copy it again from Settings › Connect Claude; the shim refuses to start rather than pair with a key that would make every call time out.", "error", err)
		os.Exit(1)
	}

	// The tools themselves live in mcpshim.NewToolServer, shared with the Tier-2
	// hosted endpoint so the two cannot drift into two wire contracts.
	server := mcpshim.NewToolServer("myportfolio-mcp-shim", version, toolDescriptionSuffix, client.Call)

	slog.Info("[mcpshim] starting stdio MCP server", "version", version)
	if err := server.Run(context.Background(), &sdkmcp.StdioTransport{}); err != nil {
		slog.Error("[mcpshim] server error", "error", err)
		os.Exit(1)
	}
}
