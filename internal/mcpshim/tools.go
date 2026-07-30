package mcpshim

// The two tools, defined ONCE for both tiers (ARCHITECTURE.md §11 "Two tiers").
//
// Tier 1 is cmd/mcpshim, a local stdio server holding the pairing key. Tier 2 is
// internal/server's hosted streamable-HTTP endpoint, which drives a Client of
// this same package. They are two transports in front of one wire contract, and
// this file is where that contract lives so it cannot become two: the tool
// names, the argument shapes (wire.go, which the browser responder decodes) and
// the result flattening are shared, and the only thing a caller varies is the
// honesty suffix on each description — because the two tiers have genuinely
// different things to be honest about.
//
// The suffix is a parameter and not a constant for exactly that reason, and it
// is the one place either tier gets to differ. Tier 1 can say the server is
// blind; Tier 2 must say the opposite, in the tool description, because that is
// the text the model relays to the user.

import (
	"context"
	"encoding/json"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// The base descriptions, minus the per-tier suffix. Deliberately short: every
// byte here is sent to the model on every tools/list.
const (
	helpToolDescription = "Discover the small read-only catalog of portfolio operations this connector can run. Call with no arguments for the terse catalog, then pass operation_id (or operation_ids) for an operation's full schema."
	callToolDescription = "Run exactly one portfolio operation by id — see mcp_help for the catalog. Read-only: this connector cannot modify your portfolio."
)

// A Caller runs one MCP method against the paired device and returns the
// responder's raw result. Client.Call is Tier 1's implementation; Tier 2 passes
// a wrapper that additionally refuses once the user has revoked the connector.
//
// Its error must be a PLAIN error, never a *jsonrpc.Error. AddTool packs a plain
// error into the tool result with isError set — which is where the model can
// read it — but returns a *jsonrpc.Error as a top-level protocol failure, which
// an MCP client renders as "the connector is broken" and the model never sees.
// ErrDeviceOffline is the whole reason that distinction matters: the one sentence
// telling the user to unlock their tab has to reach them. ShimCore.Call already
// flattens responder errors for this reason; do not undo it here or in a Caller.
type Caller func(ctx context.Context, method string, params any) (json.RawMessage, error)

// NewToolServer builds the MCP server a tier serves: mcp_help and mcp_call,
// backed by call, with descriptionSuffix appended to both descriptions.
//
// There is deliberately no third tool. ARCHITECTURE.md §11: an mcp_execute-style
// server-side script runner would have nothing to read, because the server never
// sees plaintext — and giving it something to read is the one property this whole
// design exists to prevent.
func NewToolServer(name, version, descriptionSuffix string, call Caller) *sdkmcp.Server {
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: name, Version: version}, nil)

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_help",
		Description: helpToolDescription + descriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input HelpInput) (*sdkmcp.CallToolResult, any, error) {
		return relayTool(ctx, call, "mcp_help", input)
	})

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_call",
		Description: callToolDescription + descriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input CallInput) (*sdkmcp.CallToolResult, any, error) {
		return relayTool(ctx, call, "mcp_call", input)
	})

	return server
}

// relayTool is both tools' body: hand the arguments to the device, hand its
// answer back untouched. The result is returned as the output value rather than
// as Content so the SDK fills in both the structured content and its JSON text.
func relayTool(ctx context.Context, call Caller, method string, params any) (*sdkmcp.CallToolResult, any, error) {
	result, err := call(ctx, method, params)
	if err != nil {
		// Returned as-is, and it must stay a plain error — see Caller.
		return nil, nil, err
	}
	return nil, json.RawMessage(result), nil
}
