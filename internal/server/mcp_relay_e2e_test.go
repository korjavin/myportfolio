package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/korjavin/myportfolio/internal/mcpshim"
)

// This file closes the one gap neither side could close alone. cmd/mcpshim's
// tests drive the real binary against a FAKE relay; mcp_relay_test.go drives the
// real relay from the shim's client library. Neither proves the two halves meet.
// Here the actual cmd/mcpshim process talks over stdio, through the actual relay
// handler, to a responder holding a key the server never saw.

// stdioShim is one running mcpshim process, spoken to over its MCP transport.
type stdioShim struct {
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *lockedBuffer
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startStdioShim(t *testing.T, code string) *stdioShim {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "mcpshim")
	if out, err := exec.Command("go", "build", "-o", bin, "../../cmd/mcpshim").CombinedOutput(); err != nil {
		t.Fatalf("build cmd/mcpshim: %v\n%s", err, out)
	}

	cmd := exec.Command(bin)
	cmd.Env = append(cmd.Environ(), "MYPORTFOLIO_MCP_CODE="+code)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	stderr := &lockedBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start mcpshim: %v", err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return &stdioShim{stdin: stdin, stdout: bufio.NewReader(stdout), stderr: stderr}
}

// roundTrip writes one JSON-RPC line and reads until the reply with id arrives.
func (s *stdioShim) roundTrip(t *testing.T, msg string, id float64) map[string]any {
	t.Helper()
	if _, err := io.WriteString(s.stdin, msg+"\n"); err != nil {
		t.Fatalf("write to mcpshim stdin: %v\nstderr:\n%s", err, s.stderr.String())
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		line, err := s.stdout.ReadString('\n')
		if err != nil {
			t.Fatalf("read mcpshim stdout: %v\nstderr:\n%s", err, s.stderr.String())
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(line), &out); err != nil {
			t.Fatalf("mcpshim wrote non-JSON to the MCP transport: %q", line)
		}
		if out["id"] == id {
			return out
		}
	}
	t.Fatalf("timed out waiting for id %v\nstderr:\n%s", id, s.stderr.String())
	return nil
}

func (s *stdioShim) notify(t *testing.T, msg string) {
	t.Helper()
	if _, err := io.WriteString(s.stdin, msg+"\n"); err != nil {
		t.Fatalf("write to mcpshim stdin: %v", err)
	}
}

// TestTheRealShimBinaryReachesADeviceThroughThisRelay: a tool call enters the
// shim process on stdin, leaves as a sealed frame, crosses the relay, is opened
// and answered by the device leg, and comes back out on stdout. The relay in the
// middle is this package's handler and it holds no key.
func TestTheRealShimBinaryReachesADeviceThroughThisRelay(t *testing.T) {
	f := newRelayFixture(t)
	pairingID := f.mint(t)
	device := f.dialDevice(t, pairingID)
	go respondOnDevice(t, device, f.key, pairingID)

	// Exactly the code Settings will mint, relay endpoint and all — the shim is
	// told nothing else about where the legs live.
	code, err := mcpshim.FormatPairingCode(&mcpshim.PairingCode{
		RelayURL:  f.relayURL(),
		PairingID: pairingID,
		Key:       f.key,
	})
	if err != nil {
		t.Fatalf("format pairing code: %v", err)
	}

	shim := startStdioShim(t, code)
	shim.roundTrip(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"relay-e2e","version":"1"}}}`, 1)
	shim.notify(t, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)

	resp := shim.roundTrip(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcp_help","arguments":{"topic":"performance"}}}`, 2)
	if resp["error"] != nil {
		t.Fatalf("tools/call returned a protocol error: %v\nstderr:\n%s", resp["error"], shim.stderr.String())
	}
	raw, err := json.Marshal(resp["result"])
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if !bytes.Contains(raw, []byte("mcp_help")) || !bytes.Contains(raw, []byte("performance")) {
		t.Fatalf("the call did not reach the device and come back: %s", raw)
	}
	t.Logf("tools/call result through the real relay: %s", raw)

	// The relay saw only ciphertext, and the shim's diagnostics must not leak the
	// key either — the code carries it, so a logged code is a logged key.
	if strings.Contains(shim.stderr.String(), code) {
		t.Fatal("mcpshim logged the pairing code, which carries the key")
	}
}
