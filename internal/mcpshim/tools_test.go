package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// dialToolServer connects an in-process MCP client to a tool server backed by
// call. No transport, no relay: this is about what the SDK does with the tools'
// results, which is the one thing both tiers depend on and neither can see.
func dialToolServer(t *testing.T, suffix string, call Caller) *sdkmcp.ClientSession {
	t.Helper()
	serverT, clientT := sdkmcp.NewInMemoryTransports()
	server := NewToolServer("test", "0", suffix, call)
	if _, err := server.Connect(t.Context(), serverT, nil); err != nil {
		t.Fatalf("connect server: %v", err)
	}
	session, err := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test", Version: "0"}, nil).
		Connect(t.Context(), clientT, nil)
	if err != nil {
		t.Fatalf("connect client: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func toolText(t *testing.T, res *sdkmcp.CallToolResult) string {
	t.Helper()
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*sdkmcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

// TestFailuresArriveAsToolResultsAndStayDistinguishable is the landmine both
// tiers share. The SDK re-emits a *jsonrpc.Error as a top-level PROTOCOL error,
// which an MCP client renders as "the connector is broken" and the model never
// reads — so a device-offline answer returned that way would silently drop the
// one sentence telling the user to unlock their tab. A plain error is packed into
// the tool result with isError instead, which is exactly what the MCP spec
// reserves for a call that failed.
//
// And the three shim failure modes must arrive as three different sentences: each
// calls for a different user action (wait and retry / re-pair / stop the second
// connector), so collapsing them reproduces the looks-alive-and-fails symptom
// that points nowhere.
func TestFailuresArriveAsToolResultsAndStayDistinguishable(t *testing.T) {
	seen := map[string]string{}
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"device offline", ErrDeviceOffline, "No unlocked device is online to answer"},
		{"pairing gone", ErrPairingGone, "This pairing no longer exists"},
		{"pairing replaced", ErrPairingReplaced, "Another connection took over this pairing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session := dialToolServer(t, "", func(context.Context, string, any) (json.RawMessage, error) {
				return nil, tc.err
			})
			res, err := session.CallTool(t.Context(), &sdkmcp.CallToolParams{Name: "mcp_help"})
			if err != nil {
				t.Fatalf("the failure surfaced as a PROTOCOL error, which the client renders as a broken connector and the model never reads: %v", err)
			}
			if !res.IsError {
				t.Error("the failure did not set isError, so the model has no signal the call failed")
			}
			text := toolText(t, res)
			if !strings.Contains(text, tc.want) {
				t.Fatalf("tool result = %q, want it to carry %q verbatim", text, tc.want)
			}
			if prev, dup := seen[text]; dup {
				t.Fatalf("this failure is indistinguishable from %q — each calls for a different user action", prev)
			}
			seen[text] = tc.name
		})
	}
}

// The two tools, their argument shapes and the suffix placement. The suffix is on
// BOTH descriptions on purpose: whichever tool the model reaches for first has to
// carry the disclosure.
func TestToolServerAdvertisesBothToolsWithTheSuffix(t *testing.T) {
	session := dialToolServer(t, " SUFFIX-MARKER.", func(context.Context, string, any) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	})
	res, err := session.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	got := map[string]*sdkmcp.Tool{}
	for _, tool := range res.Tools {
		got[tool.Name] = tool
	}
	if len(got) != 2 {
		// §11: there is deliberately no mcp_execute. A server-side script runner
		// would have nothing to read, and giving it something to read is the one
		// property this design exists to prevent.
		t.Fatalf("advertised %d tools, want exactly mcp_help and mcp_call: %v", len(got), res.Tools)
	}
	for _, name := range []string{"mcp_help", "mcp_call"} {
		tool, ok := got[name]
		if !ok {
			t.Fatalf("%s is not advertised", name)
		}
		if !strings.HasSuffix(tool.Description, " SUFFIX-MARKER.") {
			t.Errorf("%s description does not end in the caller's suffix: %q", name, tool.Description)
		}
	}
	// The argument shapes the browser responder decodes (wire.go). A dropped
	// field is a field no agent can ever pass.
	for name, want := range map[string][]string{
		"mcp_help": {"operation_id", "operation_ids", "topic", "query"},
		"mcp_call": {"operation_id", "params"},
	} {
		schema, err := json.Marshal(got[name].InputSchema)
		if err != nil {
			t.Fatalf("marshal %s input schema: %v", name, err)
		}
		for _, field := range want {
			if !strings.Contains(string(schema), `"`+field+`"`) {
				t.Errorf("%s input schema is missing %q: %s", name, field, schema)
			}
		}
	}
}

// A pairing the relay has forgotten answers the shim leg's dial with 401, and
// that is the same fact close code 4404 carries. It must arrive as
// ErrPairingGone, not as a transport error.
//
// This is the post-restart path and it is the COMMON one: the relay's pairing
// table is in-memory by design (§11), so every redeploy leaves a configured
// connector dialing a pairing that is gone. Before this it reported "gave up
// reconnecting after 3 attempts: … 401", which tells the user nothing to do.
func TestAForgottenPairingIsReportedAsGoneNotAsATransportFault(t *testing.T) {
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unknown or expired pairing", http.StatusUnauthorized)
	}))
	defer relay.Close()

	c := NewClientFromPairing(&PairingCode{
		RelayURL:  strings.Replace(relay.URL, "http://", "ws://", 1) + relayEndpoint,
		PairingID: "forgotten",
		Key:       make([]byte, PairingKeyBytes),
	}, nil)

	_, err := c.Call(t.Context(), "mcp_help", HelpInput{})
	if !errors.Is(err, ErrPairingGone) {
		t.Fatalf("Call against a relay that has forgotten the pairing = %v, want ErrPairingGone", err)
	}
	// Unwrapped, because it is a finished sentence for the user: a
	// "reconnect to relay" prefix would bury the instruction they must act on.
	if err.Error() != ErrPairingGone.Error() {
		t.Errorf("the terminal error was wrapped: %v", err)
	}
}
