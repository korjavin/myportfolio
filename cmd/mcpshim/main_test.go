package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/korjavin/myportfolio/internal/mcpshim"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
)

// These tests drive the REAL built binary over its real stdio, because the
// properties they check are properties of the process, not of a function:
// what lands on fd 1, what lands on fd 2, and what an MCP client sees when it
// asks for the tool list. A unit test of main's internals cannot catch a
// stray fmt.Println in a dependency.
//
// The relay (bd myportfolio-ybp.2) does not exist yet, so the far end is
// fakeRelay — a real websocket server standing in for the relay and the
// paired browser tab at once.

const testPairingID = "cmd-test-pairing"

var testKey = bytes.Repeat([]byte{0x11}, mcpshim.PairingKeyBytes)

// startFakeRelay serves the shim leg and answers every request with
// {"ok": <method>} so the round trip is observable from the far side of the
// binary.
func startFakeRelay(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/mcp/relay/shim" || req.URL.Query().Get("pairing") != testPairingID {
			http.NotFound(w, req)
			return
		}
		c, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(64 << 10)
		for {
			_, data, err := c.Read(req.Context())
			if err != nil {
				return
			}
			payload, err := mcpshim.OpenFrame(testKey, testPairingID, data)
			if err != nil {
				return
			}
			msg, err := jsonrpc.DecodeMessage(payload)
			if err != nil {
				return
			}
			rpcReq, ok := msg.(*jsonrpc.Request)
			if !ok {
				continue
			}
			body, err := json.Marshal(map[string]string{"answered": rpcReq.Method})
			if err != nil {
				return
			}
			out, err := jsonrpc.EncodeMessage(&jsonrpc.Response{ID: rpcReq.ID, Result: body})
			if err != nil {
				return
			}
			frame, err := mcpshim.SealFrame(testKey, testPairingID, out)
			if err != nil {
				return
			}
			if err := c.Write(req.Context(), websocket.MessageBinary, frame); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func buildShim(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "mcpshim")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("go build ./cmd/mcpshim: %v\n%s", err, out)
	}
	return bin
}

func pairingCode(t *testing.T, relayURL string) string {
	t.Helper()
	code, err := mcpshim.FormatPairingCode(&mcpshim.PairingCode{
		RelayURL:  strings.Replace(relayURL, "http://", "ws://", 1),
		PairingID: testPairingID,
		Key:       testKey,
	})
	if err != nil {
		t.Fatalf("format pairing code: %v", err)
	}
	return code
}

// syncBuffer collects the child's stderr. os/exec copies into it from its own
// goroutine while the test reads it, so the buffer has to be guarded.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// session drives one running shim process over stdio.
type session struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *syncBuffer
	mu     sync.Mutex
	lines  []string
}

func startShim(t *testing.T, bin string, env ...string) *session {
	t.Helper()
	cmd := exec.Command(bin)
	cmd.Env = append(cmd.Environ(), env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	stderr := &syncBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start shim: %v", err)
	}
	s := &session{cmd: cmd, stdin: stdin, stdout: bufio.NewReader(stdout), stderr: stderr}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return s
}

func (s *session) send(t *testing.T, msg string) {
	t.Helper()
	if _, err := io.WriteString(s.stdin, msg+"\n"); err != nil {
		t.Fatalf("write to shim stdin: %v", err)
	}
}

// readResponse reads stdout lines until one carries the given id, recording
// every line it saw so the stdout-purity assertion can inspect them all.
func (s *session) readResponse(t *testing.T, id float64) map[string]any {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for id %v; stderr:\n%s", id, s.stderr.String())
		}
		line, err := s.stdout.ReadString('\n')
		if err != nil {
			t.Fatalf("read shim stdout: %v; stderr:\n%s", err, s.stderr.String())
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		s.mu.Lock()
		s.lines = append(s.lines, line)
		s.mu.Unlock()
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			t.Fatalf("stdout carried non-JSON, which corrupts the MCP transport: %q", line)
		}
		if msg["id"] == id {
			return msg
		}
	}
}

func (s *session) initialize(t *testing.T) {
	t.Helper()
	s.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
	s.readResponse(t, 1)
	s.send(t, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
}

// TestStdoutCarriesOnlyProtocolTraffic is the landmine assertion. stdout IS
// the MCP transport: a stray write to it corrupts the protocol and presents
// as the connector behaving erratically, a long way from "someone left a
// debug print in". Every line the process emits on fd 1 must be a JSON-RPC
// message, and the diagnostics must all be on fd 2.
func TestStdoutCarriesOnlyProtocolTraffic(t *testing.T) {
	relay := startFakeRelay(t)
	s := startShim(t, buildShim(t), "MYPORTFOLIO_MCP_CODE="+pairingCode(t, relay.URL))
	s.initialize(t)
	s.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	s.readResponse(t, 2)
	s.send(t, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mcp_help","arguments":{}}}`)
	s.readResponse(t, 3)

	s.mu.Lock()
	lines := append([]string(nil), s.lines...)
	s.mu.Unlock()
	// Logged so `go test -v` shows the actual session: what the connector put
	// on each fd is the thing under test, and reading it beats inferring it
	// from a pass/fail.
	t.Logf("stdout (the MCP transport), %d lines:\n%s", len(lines), strings.Join(lines, "\n"))
	t.Logf("stderr (diagnostics):\n%s", s.stderr.String())
	if len(lines) < 3 {
		t.Fatalf("expected at least 3 protocol lines, got %d", len(lines))
	}
	for _, line := range lines {
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			t.Fatalf("non-JSON on stdout: %q", line)
		}
		if msg["jsonrpc"] != "2.0" {
			t.Fatalf("stdout line is not a JSON-RPC message: %q", line)
		}
	}
	// And the diagnostics really did go somewhere — to stderr.
	if !strings.Contains(s.stderr.String(), "starting stdio MCP server") {
		t.Fatalf("startup log did not reach stderr; stderr:\n%s", s.stderr.String())
	}
}

// TestExactlyTwoToolsAreAdvertised: ARCHITECTURE.md §11 — mcp_help and
// mcp_call, and deliberately no mcp_execute. A server-side script runner would
// have nothing to read, because the server never sees plaintext.
func TestExactlyTwoToolsAreAdvertised(t *testing.T) {
	relay := startFakeRelay(t)
	s := startShim(t, buildShim(t), "MYPORTFOLIO_MCP_CODE="+pairingCode(t, relay.URL))
	s.initialize(t)
	s.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	resp := s.readResponse(t, 2)

	raw, err := json.Marshal(resp["result"])
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var listed struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatalf("unmarshal tools/list: %v", err)
	}
	var names []string
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names) // the SDK advertises them in its own order
	got := strings.Join(names, ",")
	if got != "mcp_call,mcp_help" {
		t.Fatalf("tools/list = %q, want exactly mcp_call and mcp_help — no third tool (ARCHITECTURE.md §11)", got)
	}
}

// TestHelpRoundTripReachesTheFarEnd: the whole path through the real binary —
// stdio in, sealed frame out, sealed frame back, stdio out.
func TestHelpRoundTripReachesTheFarEnd(t *testing.T) {
	relay := startFakeRelay(t)
	s := startShim(t, buildShim(t), "MYPORTFOLIO_MCP_CODE="+pairingCode(t, relay.URL))
	s.initialize(t)
	s.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp_help","arguments":{"topic":"performance"}}}`)
	resp := s.readResponse(t, 2)

	raw, err := json.Marshal(resp["result"])
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if !bytes.Contains(raw, []byte(`"answered":"mcp_help"`)) {
		t.Fatalf("mcp_help did not round trip to the far end: %s", raw)
	}
	if resp["error"] != nil {
		t.Fatalf("mcp_help returned an error: %v", resp["error"])
	}
}

// TestPairingKeyNeverReachesStderr: the shim holds the pairing key and must
// never transmit or print it. stderr is where every diagnostic goes, so it is
// the place a leak would land.
func TestPairingKeyNeverReachesStderr(t *testing.T) {
	relay := startFakeRelay(t)
	code := pairingCode(t, relay.URL)
	s := startShim(t, buildShim(t), "MYPORTFOLIO_MCP_CODE="+code)
	s.initialize(t)
	s.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp_help","arguments":{}}}`)
	s.readResponse(t, 2)

	err := s.stdin.Close()
	if err != nil {
		t.Fatalf("close stdin: %v", err)
	}
	_ = s.cmd.Wait()

	forms := []string{
		hex.EncodeToString(testKey),
		base64.StdEncoding.EncodeToString(testKey),
		base64.RawURLEncoding.EncodeToString(testKey),
		string(testKey),
		code, // the whole code embeds the key
	}
	stderr := s.stderr.String()
	for _, form := range forms {
		if strings.Contains(stderr, form) {
			t.Fatalf("stderr leaks the pairing key or the code:\n%s", stderr)
		}
	}
}

// TestMissingAndInvalidCodesFailActionably: no panic, no silent exit — a
// message that says what to do.
func TestMissingAndInvalidCodesFailActionably(t *testing.T) {
	bin := buildShim(t)
	relay := startFakeRelay(t)
	good := pairingCode(t, relay.URL)
	// One character of the code body flipped — the case the checksum exists to
	// catch, and the one that used to reach the user as "no device online".
	mistyped := good[:len(good)-6] + flip(good[len(good)-6]) + good[len(good)-5:]

	for name, tc := range map[string]struct{ env, want string }{
		"missing":  {"MYPORTFOLIO_MCP_CODE=", "MYPORTFOLIO_MCP_CODE is not set"},
		"garbage":  {"MYPORTFOLIO_MCP_CODE=nonsense", "invalid MYPORTFOLIO_MCP_CODE"},
		"mistyped": {"MYPORTFOLIO_MCP_CODE=" + mistyped, "checksum mismatch"},
		"wrong app": {
			"MYPORTFOLIO_MCP_CODE=mtmcp1." + base64.RawURLEncoding.EncodeToString([]byte(`{"relay_url":"wss://r","pairing_id":"p"}`)) + ".abcd",
			`missing \"mpmcp1.\" prefix`,
		},
	} {
		t.Run(name, func(t *testing.T) {
			cmd := exec.Command(bin)
			cmd.Env = append(cmd.Environ(), tc.env)
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()

			var exitErr *exec.ExitError
			if err == nil {
				t.Fatal("shim exited 0 with a bad pairing code")
			} else if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
				t.Fatalf("shim did not exit cleanly with status 1: %v", err)
			}
			if stdout.Len() != 0 {
				t.Fatalf("failure path wrote to stdout, which is the MCP transport: %q", stdout.String())
			}
			if !strings.Contains(stderr.String(), tc.want) {
				t.Fatalf("stderr = %q, want it to mention %q", stderr.String(), tc.want)
			}
			if strings.Contains(strings.ToLower(stderr.String()), "panic") {
				t.Fatalf("shim panicked instead of reporting: %s", stderr.String())
			}
			// A malformed code must never be reported in language that reads
			// as the offline case; conflating the two is what made a typo
			// unattributable. An UNSET variable has no such confusion — there
			// is no code to have mistyped — so it is exempt.
			if name == "missing" {
				return
			}
			if !strings.Contains(stderr.String(), "NOT the same as 'no device online'") {
				t.Fatalf("startup failure does not distinguish itself from the offline case: %s", stderr.String())
			}
		})
	}
}

// flip returns a different base64url character, for building a one-character
// typo.
func flip(c byte) string {
	if c == 'A' {
		return "B"
	}
	return "A"
}
