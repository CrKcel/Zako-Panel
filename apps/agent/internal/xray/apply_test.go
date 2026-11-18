package xray

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	calls  []string
	output map[string]error
}

func (r *fakeRunner) Run(_ context.Context, name string, args ...string) error {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	for prefix, err := range r.output {
		if strings.HasPrefix(call, prefix) {
			return err
		}
	}
	return nil
}

func (r *fakeRunner) count(prefix string) int {
	count := 0
	for _, call := range r.calls {
		if strings.HasPrefix(call, prefix) {
			count++
		}
	}
	return count
}

type fakeRestarter struct {
	calls int
	err   error
	order *[]string
}

func (r *fakeRestarter) Restart(context.Context) error {
	r.calls++
	if r.order != nil {
		*r.order = append(*r.order, "restart")
	}
	return r.err
}

type fakeHealth struct {
	failures int
	calls    int
	order    *[]string
}

func (h *fakeHealth) Check(context.Context) error {
	h.calls++
	if h.order != nil {
		*h.order = append(*h.order, "health")
	}
	if h.failures > 0 {
		h.failures--
		return errors.New("api inbound is not answering")
	}
	return nil
}

type applierFixture struct {
	applier   *ConfigApplier
	path      string
	runner    *fakeRunner
	restarter *fakeRestarter
	health    *fakeHealth
	order     *[]string
}

func newApplierFixture(t *testing.T, healthFailures int) *applierFixture {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "config.json")
	if err := os.WriteFile(path, []byte(`{"previous": true}`), 0o640); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	order := make([]string, 0)
	runner := &fakeRunner{output: map[string]error{}}
	restarter := &fakeRestarter{order: &order}
	health := &fakeHealth{failures: healthFailures, order: &order}
	applier, err := NewConfigApplier(ConfigApplierOptions{
		ConfigPath:     path,
		BinaryPath:     "/usr/local/bin/xray",
		Runner:         runner,
		Restarter:      restarter,
		Health:         health,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Sleep:          func(context.Context, time.Duration) error { return nil },
		HealthAttempts: 3,
	})
	if err != nil {
		t.Fatalf("NewConfigApplier: %v", err)
	}
	return &applierFixture{applier: applier, path: path, runner: runner, restarter: restarter, health: health, order: &order}
}

func (f *applierFixture) read(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(f.path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	return string(data)
}

func TestApplyValidatesBeforeReplacingAndRestarts(t *testing.T) {
	fixture := newApplierFixture(t, 0)

	if err := fixture.applier.Apply(context.Background(), []byte(`{"inbounds": []}`)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if fixture.runner.count("/usr/local/bin/xray run -test -config ") != 1 {
		t.Errorf("validation calls = %v, want one `xray run -test -config`", fixture.runner.calls)
	}
	if got := fixture.read(t); got != `{"inbounds": []}` {
		t.Errorf("config = %q, want the new document", got)
	}
	if fixture.restarter.calls != 1 {
		t.Errorf("restart calls = %d, want 1", fixture.restarter.calls)
	}
	// The restart must happen before the health check, and validation before both.
	if len(*fixture.order) != 2 || (*fixture.order)[0] != "restart" || (*fixture.order)[1] != "health" {
		t.Errorf("order = %v, want restart then health", *fixture.order)
	}
}

func TestApplyValidationFailureKeepsRunningConfig(t *testing.T) {
	fixture := newApplierFixture(t, 0)
	fixture.runner.output["/usr/local/bin/xray run -test"] = errors.New("invalid config")

	err := fixture.applier.Apply(context.Background(), []byte(`{"broken": true}`))
	if err == nil {
		t.Fatal("Apply accepted a config the binary rejects")
	}
	if got := fixture.read(t); got != `{"previous": true}` {
		t.Errorf("config = %q, want the previous document untouched", got)
	}
	if fixture.restarter.calls != 0 {
		t.Errorf("restart calls = %d, want none for an invalid document", fixture.restarter.calls)
	}
}

func TestApplyHealthFailureRestoresPreviousConfigAndRestarts(t *testing.T) {
	// Every health check fails, so the second restart cannot be verified either.
	fixture := newApplierFixture(t, 1<<30)

	err := fixture.applier.Apply(context.Background(), []byte(`{"new": true}`))
	if err == nil {
		t.Fatal("Apply reported success although Xray never became healthy")
	}
	if !strings.Contains(err.Error(), "previous config restored") {
		t.Errorf("error = %v, want it to mention the restore", err)
	}
	if got := fixture.read(t); got != `{"previous": true}` {
		t.Errorf("config = %q, want the previous document restored", got)
	}
	if fixture.restarter.calls != 2 {
		t.Errorf("restart calls = %d, want one per attempt", fixture.restarter.calls)
	}
}

func TestApplyRetriesHealthUntilTheInboundAnswers(t *testing.T) {
	fixture := newApplierFixture(t, 2)

	if err := fixture.applier.Apply(context.Background(), []byte(`{"new": true}`)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if fixture.health.calls != 3 {
		t.Errorf("health checks = %d, want 3 (two failures then success)", fixture.health.calls)
	}
	if got := fixture.read(t); got != `{"new": true}` {
		t.Errorf("config = %q, want the new document kept", got)
	}
}

func TestApplyRestartFailureRestoresPreviousConfig(t *testing.T) {
	fixture := newApplierFixture(t, 0)
	fixture.restarter.err = errors.New("polkit denied the restart")

	err := fixture.applier.Apply(context.Background(), []byte(`{"new": true}`))
	if err == nil {
		t.Fatal("Apply reported success although the restart failed")
	}
	if got := fixture.read(t); got != `{"previous": true}` {
		t.Errorf("config = %q, want the previous document restored", got)
	}
}

func TestNewConfigApplierValidatesDependencies(t *testing.T) {
	health := &fakeHealth{}
	cases := map[string]ConfigApplierOptions{
		"no config path": {BinaryPath: "/usr/local/bin/xray", Health: health},
		"no binary":      {ConfigPath: "/etc/xray/config.json", Health: health},
		"no health":      {ConfigPath: "/etc/xray/config.json", BinaryPath: "/usr/local/bin/xray"},
	}
	for name, opts := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewConfigApplier(opts); err == nil {
				t.Fatalf("NewConfigApplier accepted %s", name)
			}
		})
	}
}
