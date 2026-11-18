package configsync

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

type fakeClient struct {
	mu      sync.Mutex
	cfg     *reporter.AgentConfig
	hasCfg  bool
	fetchFn func(ctx context.Context) (*reporter.AgentConfig, bool, error)
	results []*reporter.ConfigResult
}

func (f *fakeClient) FetchConfig(ctx context.Context) (*reporter.AgentConfig, bool, error) {
	if f.fetchFn != nil {
		return f.fetchFn(ctx)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cfg, f.hasCfg, nil
}

func (f *fakeClient) ReportConfigResult(_ context.Context, result *reporter.ConfigResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, result)
	return nil
}

type fakeRenderer struct {
	usersSeen []xraycore.User
	err       error
}

func (f *fakeRenderer) Render(static []byte, users []xraycore.User) ([]byte, error) {
	f.usersSeen = append([]xraycore.User(nil), users...)
	if f.err != nil {
		return nil, f.err
	}
	return static, nil
}

type fakeApplier struct {
	calls int
	err   error
	last  []byte
}

func (f *fakeApplier) Apply(_ context.Context, config []byte) error {
	f.calls++
	f.last = append([]byte(nil), config...)
	return f.err
}

func openTestStore(t *testing.T) (*state.Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := state.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, filepath.Join(dir, "users.json")
}

func TestCanonicalSHA256MatchesContractFixture(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", "agent-config.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cfg reporter.AgentConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}

	got, err := canonicalSHA256(cfg.Definition)
	if err != nil {
		t.Fatalf("canonicalSHA256: %v", err)
	}
	if got != cfg.DefinitionSHA256 {
		t.Fatalf("canonicalSHA256 = %s, want %s", got, cfg.DefinitionSHA256)
	}
}

func TestSyncOnceAppliesConfigAndPersistsVersion(t *testing.T) {
	store, usersPath := openTestStore(t)
	usersJSON := `{"version":1,"users":[{"xray_email":"u_1","vless_uuid":"00000000-0000-0000-0000-000000000001"}]}`
	if err := os.WriteFile(usersPath, []byte(usersJSON), 0o600); err != nil {
		t.Fatalf("write users.json: %v", err)
	}

	def := json.RawMessage(`{"b":2,"a":1}`)
	hash, err := canonicalSHA256(def)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	if err := store.SetMetaInt64(state.KeyDesiredConfigVersion, 3); err != nil {
		t.Fatalf("set desired: %v", err)
	}

	client := &fakeClient{
		hasCfg: true,
		cfg:    &reporter.AgentConfig{Version: 3, DefinitionSHA256: hash, Definition: def},
	}
	renderer := &fakeRenderer{}
	applier := &fakeApplier{}

	s, err := New(Options{
		Client:    client,
		Store:     store,
		UsersPath: usersPath,
		Config:    renderer,
		Applier:   applier,
		XrayMu:    &sync.Mutex{},
		Clock:     func() time.Time { return time.Unix(1780000000, 0) },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}

	if applier.calls != 1 {
		t.Fatalf("applier.calls = %d, want 1", applier.calls)
	}
	if len(renderer.usersSeen) != 1 || renderer.usersSeen[0].Email != "u_1" {
		t.Fatalf("usersSeen = %+v, want u_1", renderer.usersSeen)
	}
	applied, _, _ := store.MetaInt64(state.KeyAppliedConfigVersion)
	if applied != 3 {
		t.Fatalf("applied_config_version = %d, want 3", applied)
	}
	if len(client.results) != 1 || client.results[0].Status != reporter.ConfigStatusApplied || client.results[0].Version != 3 {
		t.Fatalf("results = %+v, want 1 applied result for v3", client.results)
	}
}

func TestSyncOnceRejectsHashMismatchAndSuppressesRetryUntilNewVersion(t *testing.T) {
	store, usersPath := openTestStore(t)
	if err := store.SetMetaInt64(state.KeyDesiredConfigVersion, 4); err != nil {
		t.Fatalf("set desired: %v", err)
	}
	if err := store.SetMetaInt64(state.KeyAppliedConfigVersion, 2); err != nil {
		t.Fatalf("set applied: %v", err)
	}

	client := &fakeClient{
		hasCfg: true,
		cfg: &reporter.AgentConfig{
			Version:          4,
			DefinitionSHA256: "0000000000000000000000000000000000000000000000000000000000000000",
			Definition:       json.RawMessage(`{"inbounds":[]}`),
		},
	}
	applier := &fakeApplier{}

	s, err := New(Options{
		Client:    client,
		Store:     store,
		UsersPath: usersPath,
		Config:    &fakeRenderer{},
		Applier:   applier,
		Clock:     func() time.Time { return time.Unix(1780000000, 0) },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := s.SyncOnce(context.Background()); err == nil {
		t.Fatal("expected error on hash mismatch")
	}
	if applier.calls != 0 {
		t.Fatalf("applier.calls = %d, want 0", applier.calls)
	}
	applied, _, _ := store.MetaInt64(state.KeyAppliedConfigVersion)
	if applied != 2 {
		t.Fatalf("applied_config_version = %d, want 2", applied)
	}
	failed, _, _ := store.MetaInt64(state.KeyFailedConfigVersion)
	if failed != 4 {
		t.Fatalf("failed_config_version = %d, want 4", failed)
	}
	if len(client.results) != 1 || client.results[0].Status != reporter.ConfigStatusFailed || client.results[0].Error.Code != "CONFIG_HASH_MISMATCH" {
		t.Fatalf("results = %+v, want CONFIG_HASH_MISMATCH", client.results)
	}

	// Second SyncOnce for the same failed version must be a no-op.
	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatalf("second SyncOnce: %v", err)
	}
	if len(client.results) != 1 {
		t.Fatalf("expected no duplicate failure report, got %d results", len(client.results))
	}
}

func TestSyncOnceSuppressesRetryOnApplyFailureAndRecoversOnNewVersion(t *testing.T) {
	store, usersPath := openTestStore(t)
	def := json.RawMessage(`{"inbounds":[]}`)
	hash, _ := canonicalSHA256(def)

	if err := store.SetMetaInt64(state.KeyDesiredConfigVersion, 5); err != nil {
		t.Fatalf("set desired: %v", err)
	}

	client := &fakeClient{
		hasCfg: true,
		cfg:    &reporter.AgentConfig{Version: 5, DefinitionSHA256: hash, Definition: def},
	}
	applier := &fakeApplier{err: errors.New("xray run -test failed")}

	s, err := New(Options{
		Client:    client,
		Store:     store,
		UsersPath: usersPath,
		Config:    &fakeRenderer{},
		Applier:   applier,
		Clock:     func() time.Time { return time.Unix(1780000000, 0) },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := s.SyncOnce(context.Background()); err == nil {
		t.Fatal("expected apply error")
	}
	if applier.calls != 1 {
		t.Fatalf("applier.calls = %d, want 1", applier.calls)
	}

	// Same version 5 should not retry.
	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce suppressed retry: %v", err)
	}
	if applier.calls != 1 {
		t.Fatalf("applier.calls = %d, want still 1", applier.calls)
	}

	// Publish version 6 and fix applier.
	applier.err = nil
	client.cfg = &reporter.AgentConfig{Version: 6, DefinitionSHA256: hash, Definition: def}
	if err := store.SetMetaInt64(state.KeyDesiredConfigVersion, 6); err != nil {
		t.Fatalf("set desired 6: %v", err)
	}

	if err := s.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce v6: %v", err)
	}
	if applier.calls != 2 {
		t.Fatalf("applier.calls = %d, want 2", applier.calls)
	}
	applied, _, _ := store.MetaInt64(state.KeyAppliedConfigVersion)
	failed, _, _ := store.MetaInt64(state.KeyFailedConfigVersion)
	if applied != 6 || failed != 0 {
		t.Fatalf("applied=%d failed=%d, want 6 and 0", applied, failed)
	}
}
