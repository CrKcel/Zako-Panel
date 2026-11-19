package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
)

type fakeRunner struct {
	calls [][]string
	fn    func(name string, args ...string) ([]byte, error)
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	if f.fn != nil {
		return f.fn(name, args...)
	}
	return nil, nil
}

type fakeClient struct {
	results []*reporter.UpdateResult
}

func (f *fakeClient) ReportUpdateResult(_ context.Context, result *reporter.UpdateResult) error {
	f.results = append(f.results, result)
	return nil
}

func buildTarGz(t *testing.T, name string, content []byte, typeflag byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{
		Name:     name,
		Mode:     0o755,
		Size:     int64(len(content)),
		Typeflag: typeflag,
	}
	if typeflag == tar.TypeSymlink {
		hdr.Linkname = "/etc/passwd"
		hdr.Size = 0
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if len(content) > 0 && typeflag == tar.TypeReg {
		if _, err := tw.Write(content); err != nil {
			t.Fatalf("write tar body: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}

func openTestStore(t *testing.T) *state.Store {
	t.Helper()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("open state store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestParseSelfUpdateDirective(t *testing.T) {
	ver, ok := ParseSelfUpdateDirective([]reporter.Directive{
		{Type: "uninstall", Payload: map[string]json.RawMessage{"remove_xray": json.RawMessage(`false`)}},
		{Type: "self_update", Payload: map[string]json.RawMessage{"target_version": json.RawMessage(`"v0.2.0"`)}},
	})
	if !ok || ver != "0.2.0" {
		t.Fatalf("ParseSelfUpdateDirective = (%q, %v), want (0.2.0, true)", ver, ok)
	}

	if _, ok := ParseSelfUpdateDirective([]reporter.Directive{{Type: "self_update"}}); ok {
		t.Fatal("expected missing payload to return false")
	}
}

func TestUpdateOnceStagesAndTriggersUnit(t *testing.T) {
	binPayload := []byte("#!/bin/sh\necho zako-agent 0.2.0\n")
	archive := buildTarGz(t, "zako-agent", binPayload, tar.TypeReg)
	sum := sha256.Sum256(archive)
	sumsTxt := fmt.Sprintf("%s  zako-agent-linux-amd64.tar.gz\n", hex.EncodeToString(sum[:]))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dl/agent/SHA256SUMS":
			_, _ = w.Write([]byte(sumsTxt))
		case "/dl/agent/zako-agent-linux-amd64.tar.gz":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	stateDir := t.TempDir()
	store := openTestStore(t)
	client := &fakeClient{}
	runner := &fakeRunner{
		fn: func(name string, args ...string) ([]byte, error) {
			if len(args) == 1 && args[0] == "--version" {
				return []byte("zako-agent 0.2.0 (linux/amd64)\n"), nil
			}
			return nil, nil
		},
	}

	mgr, err := NewManager(Options{
		BaseURL:        srv.URL,
		CurrentVersion: "0.1.0",
		StateDir:       stateDir,
		Client:         client,
		Store:          store,
		Runner:         runner,
		GOOS:           "linux",
		GOARCH:         "amd64",
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	if err := mgr.UpdateOnce(context.Background(), "v0.2.0"); err != nil {
		t.Fatalf("UpdateOnce: %v", err)
	}

	stagedBytes, err := os.ReadFile(filepath.Join(stateDir, updateSubdir, stagedBinName))
	if err != nil {
		t.Fatalf("read staged binary: %v", err)
	}
	if !bytes.Equal(stagedBytes, binPayload) {
		t.Fatalf("staged binary mismatch")
	}

	pendingRaw, err := os.ReadFile(filepath.Join(stateDir, updateSubdir, pendingFile))
	if err != nil {
		t.Fatalf("read pending.json: %v", err)
	}
	var pending PendingUpdate
	if err := json.Unmarshal(pendingRaw, &pending); err != nil {
		t.Fatalf("decode pending.json: %v", err)
	}
	if pending.TargetVersion != "0.2.0" || pending.FromVersion != "0.1.0" {
		t.Fatalf("unexpected pending update: %+v", pending)
	}

	if len(runner.calls) != 2 || strings.Join(runner.calls[1], " ") != "systemctl start zako-agent-update.service" {
		t.Fatalf("unexpected runner calls: %+v", runner.calls)
	}
}

func TestUpdateOnceRejectsHashMismatchAndSuppressesRetry(t *testing.T) {
	archive := buildTarGz(t, "zako-agent", []byte("binary"), tar.TypeReg)
	badSums := strings.Repeat("0", 64) + "  zako-agent-linux-amd64.tar.gz\n"

	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		switch r.URL.Path {
		case "/dl/agent/SHA256SUMS":
			_, _ = w.Write([]byte(badSums))
		case "/dl/agent/zako-agent-linux-amd64.tar.gz":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	store := openTestStore(t)
	client := &fakeClient{}
	mgr, err := NewManager(Options{
		BaseURL:        srv.URL,
		CurrentVersion: "0.1.0",
		StateDir:       t.TempDir(),
		Client:         client,
		Store:          store,
		Runner:         &fakeRunner{},
		GOOS:           "linux",
		GOARCH:         "amd64",
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	if err := mgr.UpdateOnce(context.Background(), "0.2.0"); err == nil {
		t.Fatal("expected hash mismatch error")
	}
	if len(client.results) != 1 || client.results[0].Status != reporter.ConfigStatusFailed || client.results[0].Error.Code != "UPDATE_HASH_MISMATCH" {
		t.Fatalf("unexpected reported results: %+v", client.results)
	}

	// Second attempt for the same failed version must be suppressed.
	hitsBefore := hits
	if err := mgr.UpdateOnce(context.Background(), "0.2.0"); err != nil {
		t.Fatalf("suppressed retry returned error: %v", err)
	}
	if hits != hitsBefore {
		t.Fatalf("expected suppressed retry to make no HTTP requests, got %d new hits", hits-hitsBefore)
	}
}

func TestExtractAgentBinaryRejectsTraversalAndSymlinks(t *testing.T) {
	traversal := buildTarGz(t, "../zako-agent", []byte("bad"), tar.TypeReg)
	if _, err := extractAgentBinary(traversal); err == nil {
		t.Fatal("expected path traversal archive to be rejected")
	}

	symlink := buildTarGz(t, "zako-agent", nil, tar.TypeSymlink)
	if _, err := extractAgentBinary(symlink); err == nil {
		t.Fatal("expected symlink entry to be rejected")
	}
}

func TestApplyUpdateSuccessAndRollback(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		stateDir := t.TempDir()
		updateDir := filepath.Join(stateDir, updateSubdir)
		if err := os.MkdirAll(updateDir, 0o750); err != nil {
			t.Fatal(err)
		}
		binPath := filepath.Join(t.TempDir(), "zako-agent")
		if err := os.WriteFile(binPath, []byte("old-bin"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(updateDir, stagedBinName), []byte("new-bin"), 0o755); err != nil {
			t.Fatal(err)
		}
		pendingRaw, _ := json.Marshal(PendingUpdate{TargetVersion: "0.2.0", FromVersion: "0.1.0"})
		if err := os.WriteFile(filepath.Join(updateDir, pendingFile), pendingRaw, 0o600); err != nil {
			t.Fatal(err)
		}

		runner := &fakeRunner{}
		err := ApplyUpdate(context.Background(), ApplyOptions{
			StateDir:          stateDir,
			BinaryPath:        binPath,
			Runner:            runner,
			ObserveTimeout:    10 * time.Millisecond,
			ObserveInterval:   5 * time.Millisecond,
			SettleDelay:       -1,
			SkipVersionVerify: true,
		})
		if err != nil {
			t.Fatalf("ApplyUpdate: %v", err)
		}

		got, _ := os.ReadFile(binPath)
		if string(got) != "new-bin" {
			t.Fatalf("installed binary = %q, want new-bin", got)
		}
		bak, _ := os.ReadFile(binPath + ".bak")
		if string(bak) != "old-bin" {
			t.Fatalf("backup binary = %q, want old-bin", bak)
		}
		resRaw, err := os.ReadFile(filepath.Join(updateDir, resultFile))
		if err != nil {
			t.Fatalf("read result.json: %v", err)
		}
		var res reporter.UpdateResult
		_ = json.Unmarshal(resRaw, &res)
		if res.Status != reporter.ConfigStatusApplied || res.TargetVersion != "0.2.0" {
			t.Fatalf("unexpected result.json: %+v", res)
		}
	})

	t.Run("rollback when service fails health check", func(t *testing.T) {
		stateDir := t.TempDir()
		updateDir := filepath.Join(stateDir, updateSubdir)
		if err := os.MkdirAll(updateDir, 0o750); err != nil {
			t.Fatal(err)
		}
		binPath := filepath.Join(t.TempDir(), "zako-agent")
		if err := os.WriteFile(binPath, []byte("old-bin"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(updateDir, stagedBinName), []byte("broken-bin"), 0o755); err != nil {
			t.Fatal(err)
		}
		pendingRaw, _ := json.Marshal(PendingUpdate{TargetVersion: "0.2.0", FromVersion: "0.1.0"})
		if err := os.WriteFile(filepath.Join(updateDir, pendingFile), pendingRaw, 0o600); err != nil {
			t.Fatal(err)
		}

		runner := &fakeRunner{
			fn: func(name string, args ...string) ([]byte, error) {
				if len(args) >= 1 && args[0] == "is-active" {
					return nil, errors.New("inactive")
				}
				return nil, nil
			},
		}
		err := ApplyUpdate(context.Background(), ApplyOptions{
			StateDir:          stateDir,
			BinaryPath:        binPath,
			Runner:            runner,
			ObserveTimeout:    10 * time.Millisecond,
			ObserveInterval:   5 * time.Millisecond,
			SettleDelay:       -1,
			SkipVersionVerify: true,
		})
		if err == nil {
			t.Fatal("expected ApplyUpdate to return rollback error")
		}

		got, _ := os.ReadFile(binPath)
		if string(got) != "old-bin" {
			t.Fatalf("binary after rollback = %q, want old-bin", got)
		}

		store := openTestStore(t)
		client := &fakeClient{}
		mgr, _ := NewManager(Options{
			BaseURL:        "https://panel.test",
			CurrentVersion: "0.1.0",
			StateDir:       stateDir,
			Client:         client,
			Store:          store,
		})
		if err := mgr.ReportPendingOutcome(context.Background()); err != nil {
			t.Fatalf("ReportPendingOutcome: %v", err)
		}
		if len(client.results) != 1 || client.results[0].Status != reporter.ConfigStatusFailed || client.results[0].Error.Code != "UPDATE_ROLLED_BACK" {
			t.Fatalf("unexpected reported rollback result: %+v", client.results)
		}
		failedVer, found, _ := store.MetaString(state.KeyFailedAgentVersion)
		if !found || failedVer != "0.2.0" {
			t.Fatalf("failed_agent_version = (%q, %v), want (0.2.0, true)", failedVer, found)
		}
	})
}
