package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/xray"
)

type fetchCall struct {
	etag string
}

type fakeFetcher struct {
	// mutex guards the response fields: Run calls FetchUsers on its own goroutine
	// while a test changes the advertised set between syncs.
	mutex       sync.Mutex
	response    *reporter.UsersResponse
	notModified bool
	err         error
	calls       []fetchCall
	// signalled receives one value per fetch so a concurrent test can wait for a
	// call instead of sleeping.
	signalled chan fetchCall
}

func (f *fakeFetcher) FetchUsers(_ context.Context, etag string) (*reporter.UsersResponse, bool, error) {
	call := fetchCall{etag: etag}
	f.mutex.Lock()
	f.calls = append(f.calls, call)
	response, notModified, err := f.response, f.notModified, f.err
	f.mutex.Unlock()

	if f.signalled != nil {
		f.signalled <- call
	}
	if err != nil {
		return nil, false, err
	}
	return response, notModified, nil
}

func (f *fakeFetcher) set(response *reporter.UsersResponse, notModified bool, err error) {
	f.mutex.Lock()
	defer f.mutex.Unlock()
	f.response, f.notModified, f.err = response, notModified, err
}

func (f *fakeFetcher) call(index int) fetchCall {
	f.mutex.Lock()
	defer f.mutex.Unlock()
	return f.calls[index]
}

type fakeUsers struct {
	added   []xray.User
	removed []string
	addErr  map[string]error
	rmErr   map[string]error
	// live models the running inbound so a snapshot can be compared with disk.
	live map[string]string
}

func (u *fakeUsers) AddUser(_ context.Context, user xray.User) error {
	if err := u.addErr[user.Email]; err != nil {
		return err
	}
	if u.live == nil {
		u.live = map[string]string{}
	}
	if _, found := u.live[user.Email]; found {
		return errors.New("user already exists")
	}
	u.added = append(u.added, user)
	u.live[user.Email] = user.UUID
	return nil
}

func (u *fakeUsers) RemoveUser(_ context.Context, email string) error {
	if err := u.rmErr[email]; err != nil {
		return err
	}
	if _, found := u.live[email]; !found {
		return errors.New("user not found")
	}
	u.removed = append(u.removed, email)
	delete(u.live, email)
	return nil
}

// snapshot returns the live set as a deterministic document so tests can assert
// "the running inbound matches the config file".
func (u *fakeUsers) snapshot() string {
	emails := make([]string, 0, len(u.live))
	for email := range u.live {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	encoded, _ := json.Marshal(emails)
	return string(encoded)
}

type fakeConfig struct {
	present bool
	static  []byte
	writes  [][]byte
	written []xray.User
	err     error
}

func (c *fakeConfig) Exists() (bool, error) { return c.present, nil }

func (c *fakeConfig) Static() ([]byte, error) { return c.static, nil }

func (c *fakeConfig) Render(_ []byte, users []xray.User) ([]byte, error) {
	if c.err != nil {
		return nil, c.err
	}
	sorted := make([]xray.User, len(users))
	copy(sorted, users)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Email < sorted[j].Email })
	encoded, err := json.Marshal(sorted)
	if err != nil {
		return nil, err
	}
	c.written = users
	return encoded, nil
}

func (c *fakeConfig) Write(config []byte) error {
	c.writes = append(c.writes, config)
	c.static = config
	return nil
}

type fakeApplier struct {
	applied [][]byte
	err     error
	// live receives the restarted process's user set, so a successful apply makes
	// the fake inbound match the config file exactly as Xray would after a restart.
	live *fakeUsers
}

func (a *fakeApplier) Apply(_ context.Context, config []byte) error {
	a.applied = append(a.applied, config)
	if a.err != nil {
		return a.err
	}
	if a.live != nil {
		var users []xray.User
		if err := json.Unmarshal(config, &users); err != nil {
			return err
		}
		a.live.live = make(map[string]string, len(users))
		for _, user := range users {
			a.live.live[user.Email] = user.UUID
		}
	}
	return nil
}

type fixture struct {
	syncer  *Syncer
	store   *state.Store
	users   *fakeUsers
	config  *fakeConfig
	applier *fakeApplier
	fetcher *fakeFetcher
	path    string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	directory := t.TempDir()
	store, err := state.Open(filepath.Join(directory, "state.db"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	f := &fixture{
		store:   store,
		users:   &fakeUsers{live: map[string]string{}},
		config:  &fakeConfig{present: true, static: []byte(`{"clients":[]}`)},
		applier: &fakeApplier{},
		fetcher: &fakeFetcher{signalled: make(chan fetchCall, 8)},
		path:    filepath.Join(directory, "users.json"),
	}
	f.applier.live = f.users
	f.rebuild(t)
	return f
}

// rebuild constructs a Syncer from the current fakes. Calling it again models an
// agent restart: the new instance starts from the store and disk only.
func (f *fixture) rebuild(t *testing.T) {
	t.Helper()
	syncer, err := New(Options{
		Fetcher:   f.fetcher,
		Users:     f.users,
		Store:     f.store,
		UsersPath: f.path,
		Config:    f.config,
		Applier:   f.applier,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f.syncer = syncer
}

func (f *fixture) appliedVersion(t *testing.T) int64 {
	t.Helper()
	version, _, err := f.store.MetaInt64(state.KeyUsersVersion)
	if err != nil {
		t.Fatalf("MetaInt64: %v", err)
	}
	return version
}

func (f *fixture) usersFile(t *testing.T) reporter.UsersResponse {
	t.Helper()
	data, err := os.ReadFile(f.path)
	if err != nil {
		t.Fatalf("read users file: %v", err)
	}
	var stored reporter.UsersResponse
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatalf("decode users file: %v", err)
	}
	return stored
}

func usersOf(version int64, entries map[string]string) *reporter.UsersResponse {
	emails := make([]string, 0, len(entries))
	for email := range entries {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	users := make([]reporter.User, 0, len(emails))
	for _, email := range emails {
		users = append(users, reporter.User{XrayEmail: email, VlessUUID: entries[email]})
	}
	return &reporter.UsersResponse{Version: version, Users: users}
}

func TestSyncOnceAppliesInitialSetAndPersistsIt(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)

	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}

	if etag := f.fetcher.call(0).etag; etag != "" {
		t.Errorf("first etag = %q, want none for a never-synced node", etag)
	}
	if len(f.users.added) != 2 {
		t.Fatalf("added = %+v, want both users", f.users.added)
	}
	if f.users.added[0].Flow != xray.FlowVision {
		t.Errorf("flow = %q, want %q", f.users.added[0].Flow, xray.FlowVision)
	}
	if len(f.applier.applied) != 0 {
		t.Errorf("restart fallback used for a clean hot update: %d applies", len(f.applier.applied))
	}
	if len(f.config.writes) != 1 {
		t.Fatalf("config writes = %d, want 1", len(f.config.writes))
	}
	if got := f.users.snapshot(); got != `["u_a","u_b"]` {
		t.Errorf("live users = %s, want both persisted users", got)
	}

	if got := f.appliedVersion(t); got != 13 {
		t.Errorf("applied version = %d, want 13", got)
	}
	stored := f.usersFile(t)
	if stored.Version != 13 || len(stored.Users) != 2 {
		t.Errorf("users file = %+v, want version 13 with two users", stored)
	}
	info, err := os.Stat(f.path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	// UUIDs are credentials; the persisted set must stay private.
	if got, want := info.Mode().Perm(), os.FileMode(0o600); got != want {
		t.Errorf("users.json mode = %o, want %o", got, want)
	}
}

func TestSyncOnceShortCircuitsOnNotModified(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("first SyncOnce: %v", err)
	}

	f.fetcher.set(nil, true, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("second SyncOnce: %v", err)
	}

	if got, want := f.fetcher.call(1).etag, `"13"`; got != want {
		t.Errorf("etag = %q, want the applied version as %s", got, want)
	}
	if len(f.config.writes) != 1 {
		t.Errorf("config writes = %d, want no write on 304", len(f.config.writes))
	}
	if len(f.users.added) != 1 {
		t.Errorf("added = %+v, want no duplicate add on 304", f.users.added)
	}
	if len(f.applier.applied) != 0 {
		t.Errorf("restart fallback used on 304: %d applies", len(f.applier.applied))
	}
}

func TestSyncOnceAppliesEachKindOfDiff(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{
		"u_keep":   "uuid-keep",
		"u_change": "uuid-old",
		"u_remove": "uuid-remove",
	}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("first SyncOnce: %v", err)
	}

	f.users.added = nil
	f.users.removed = nil
	f.fetcher.set(usersOf(14, map[string]string{
		"u_keep":   "uuid-keep",
		"u_change": "uuid-new",
		"u_add":    "uuid-add",
	}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("second SyncOnce: %v", err)
	}

	// A UUID change must remove the old credential before adding the new one:
	// Xray keeps emails unique, so the reverse order is rejected.
	if len(f.users.removed) != 2 {
		t.Fatalf("removed = %+v, want u_change and u_remove", f.users.removed)
	}
	if f.users.removed[0] != "u_change" || f.users.removed[1] != "u_remove" {
		t.Errorf("removed order = %+v, want sorted emails", f.users.removed)
	}
	if len(f.users.added) != 2 {
		t.Fatalf("added = %+v, want u_add and the new u_change uuid", f.users.added)
	}
	if f.users.added[0].Email != "u_add" || f.users.added[1].UUID != "uuid-new" {
		t.Errorf("added = %+v, want u_add then u_change with the new uuid", f.users.added)
	}
	if got := f.users.snapshot(); got != `["u_add","u_change","u_keep"]` {
		t.Errorf("live users = %s, want the converged set", got)
	}
	if got := f.appliedVersion(t); got != 14 {
		t.Errorf("applied version = %d, want 14", got)
	}
}

func TestSyncOnceFallsBackToRestartWhenHotUpdateFails(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)
	f.users.addErr = map[string]error{"u_b": errors.New("inbound rejected the user")}

	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}

	if len(f.applier.applied) != 1 {
		t.Fatalf("restart applies = %d, want the fallback to run once", len(f.applier.applied))
	}
	if got := f.appliedVersion(t); got != 13 {
		t.Errorf("applied version = %d, want 13 after a successful fallback", got)
	}
	stored := f.usersFile(t)
	if len(stored.Users) != 2 {
		t.Errorf("users file = %+v, want both users", stored)
	}
	if !strings.Contains(string(f.applier.applied[0]), "uuid-b") {
		t.Errorf("applied config = %s, want the rendered document with both users", f.applier.applied[0])
	}
	if got := f.users.snapshot(); got != `["u_a","u_b"]` {
		t.Errorf("live users after the restart fallback = %s, want both users", got)
	}
}

func TestSyncOnceKeepsVersionWhenFallbackFails(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("first SyncOnce: %v", err)
	}

	f.users.addErr = map[string]error{"u_b": errors.New("inbound rejected the user")}
	f.applier.err = errors.New("health check failed after restart")
	f.fetcher.set(usersOf(14, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)

	if err := f.syncer.SyncOnce(context.Background()); err == nil {
		t.Fatal("SyncOnce reported success although both apply paths failed")
	}
	if got := f.appliedVersion(t); got != 13 {
		t.Errorf("applied version = %d, want 13 because the set was not applied", got)
	}

	// The retry must converge once the host recovers, without a fresh version.
	f.applier.err = nil
	f.fetcher.set(usersOf(14, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("retry SyncOnce: %v", err)
	}
	if got := f.appliedVersion(t); got != 14 {
		t.Errorf("applied version after retry = %d, want 14", got)
	}
	if got := f.users.snapshot(); got != `["u_a","u_b"]` {
		t.Errorf("live users after retry = %s, want both users", got)
	}
}

func TestSyncOnceRetryConvergesAfterPartiallyAppliedHotUpdate(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("first SyncOnce: %v", err)
	}

	// The hot update removes u_a and then fails on u_c, so the running Xray and the
	// stored set disagree. The version must not move, and the retry has to converge
	// even though repeating the same removal now fails on Xray's side.
	f.users.addErr = map[string]error{"u_c": errors.New("inbound rejected the user")}
	f.applier.err = errors.New("restart failed")
	f.fetcher.set(usersOf(14, map[string]string{"u_b": "uuid-b", "u_c": "uuid-c"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err == nil {
		t.Fatal("SyncOnce reported success although both apply paths failed")
	}
	if got := f.appliedVersion(t); got != 13 {
		t.Errorf("applied version = %d, want 13", got)
	}
	if stored := f.usersFile(t); len(stored.Users) != 2 || stored.Version != 13 {
		t.Errorf("users file = %+v, want the previous set kept", stored)
	}

	f.applier.err = nil
	f.users.addErr = nil
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("retry SyncOnce: %v", err)
	}
	if got := f.appliedVersion(t); got != 14 {
		t.Errorf("applied version after retry = %d, want 14", got)
	}
	if got := f.users.snapshot(); got != `["u_b","u_c"]` {
		t.Errorf("live users after retry = %s, want the converged set", got)
	}
	if stored := f.usersFile(t); stored.Version != 14 || len(stored.Users) != 2 {
		t.Errorf("users file after retry = %+v, want version 14 with two users", stored)
	}
}

func TestSyncOnceRepairsConfigAfterInterruptedApply(t *testing.T) {
	f := newFixture(t)
	// users.json already matches the Worker while the disk config does not: an
	// earlier attempt was interrupted before the config write. The running Xray may
	// hold users the file does not have, so only a restart converges it.
	if err := os.WriteFile(f.path, []byte(`{"version":13,"users":[{"xray_email":"u_a","vless_uuid":"uuid-a"}]}`), 0o600); err != nil {
		t.Fatalf("seed users file: %v", err)
	}
	if err := f.store.SetMetaInt64(state.KeyUsersVersion, 13); err != nil {
		t.Fatalf("SetMetaInt64: %v", err)
	}
	f.config.static = []byte(`{"clients":[]}`)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a"}), false, nil)

	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if len(f.users.added) != 0 {
		t.Errorf("added = %+v, want no hot update when the set already matches", f.users.added)
	}
	if len(f.applier.applied) != 1 {
		t.Errorf("restart applies = %d, want the config repaired through a restart", len(f.applier.applied))
	}
	if got := f.appliedVersion(t); got != 13 {
		t.Errorf("applied version = %d, want 13", got)
	}
}

func TestSyncOnceRecoversAfterRestart(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("first SyncOnce: %v", err)
	}

	// A restart loses the in-memory state of the old Syncer; the new instance must
	// rebuild the applied set from disk and the store.
	f.users = &fakeUsers{live: map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}}
	f.applier.live = f.users
	f.rebuild(t)
	f.fetcher.set(nil, true, nil)

	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce after restart: %v", err)
	}
	if got, want := f.fetcher.call(1).etag, `"13"`; got != want {
		t.Errorf("etag after restart = %q, want %s from the persisted version", got, want)
	}
	if len(f.config.writes) != 1 {
		t.Errorf("config writes = %d, want none after restart", len(f.config.writes))
	}

	// A changed version after the restart must diff against the persisted set, not
	// against an empty one.
	f.fetcher.set(usersOf(14, map[string]string{"u_a": "uuid-a"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("second SyncOnce after restart: %v", err)
	}
	if len(f.users.removed) != 1 || f.users.removed[0] != "u_b" {
		t.Errorf("removed = %+v, want only u_b", f.users.removed)
	}
	if len(f.users.added) != 0 {
		t.Errorf("added = %+v, want no re-add of an existing user", f.users.added)
	}
}

func TestSyncOnceIgnoresStaleAndMissingConfig(t *testing.T) {
	f := newFixture(t)
	if err := f.store.SetMetaInt64(state.KeyUsersVersion, 14); err != nil {
		t.Fatalf("SetMetaInt64: %v", err)
	}
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce with a stale response: %v", err)
	}
	if len(f.config.writes) != 0 || len(f.users.added) != 0 {
		t.Errorf("stale response was applied: writes %d adds %d", len(f.config.writes), len(f.users.added))
	}
	if got := f.appliedVersion(t); got != 14 {
		t.Errorf("applied version = %d, want 14 kept", got)
	}

	f.config.present = false
	f.fetcher.set(usersOf(15, map[string]string{"u_a": "uuid-a"}), false, nil)
	if err := f.syncer.SyncOnce(context.Background()); !errors.Is(err, ErrNoConfig) {
		t.Errorf("SyncOnce error = %v, want ErrNoConfig", err)
	}
}

func TestRunSyncsOnTrigger(t *testing.T) {
	f := newFixture(t)
	f.fetcher.set(usersOf(13, map[string]string{"u_a": "uuid-a"}), false, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.syncer.Run(ctx) }()

	select {
	case <-f.fetcher.signalled:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not sync on start")
	}

	f.fetcher.set(usersOf(14, map[string]string{"u_a": "uuid-a", "u_b": "uuid-b"}), false, nil)
	f.syncer.Trigger()
	select {
	case <-f.fetcher.signalled:
	case <-time.After(5 * time.Second):
		t.Fatal("Trigger did not cause a sync")
	}
	waitFor(t, func() bool { return f.appliedVersion(t) == 14 })

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run error = %v, want nil on cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop on cancellation")
	}
}

func TestTriggerNeverBlocks(t *testing.T) {
	f := newFixture(t)
	for range 100 {
		f.syncer.Trigger()
	}
	// One pending sync is enough; the channel must not block the reporter.
	if len(f.syncer.trigger) != 1 {
		t.Errorf("pending triggers = %d, want 1", len(f.syncer.trigger))
	}
}

func TestNewValidatesDependencies(t *testing.T) {
	store, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	base := Options{
		Fetcher:   &fakeFetcher{},
		Users:     &fakeUsers{},
		Store:     store,
		UsersPath: filepath.Join(t.TempDir(), "users.json"),
		Config:    &fakeConfig{present: true},
		Applier:   &fakeApplier{},
	}
	if _, err := New(base); err != nil {
		t.Fatalf("New with complete options: %v", err)
	}
	cases := map[string]func(*Options){
		"fetcher":    func(o *Options) { o.Fetcher = nil },
		"users":      func(o *Options) { o.Users = nil },
		"store":      func(o *Options) { o.Store = nil },
		"users path": func(o *Options) { o.UsersPath = "" },
		"config":     func(o *Options) { o.Config = nil },
		"applier":    func(o *Options) { o.Applier = nil },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			opts := base
			mutate(&opts)
			if _, err := New(opts); err == nil {
				t.Fatalf("New accepted options without %s", name)
			}
		})
	}
}

// waitFor polls until condition holds. It bounds a concurrent test on a real
// deadline without sleeping for a fixed duration the way a time.Sleep would.
func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before the deadline")
}
