package uninstall

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/zako-panel/zako-agent/internal/reporter"
)

type fakeCall struct {
	name string
	args []string
}

type fakeRunner struct {
	calls []fakeCall
	errOn string
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) error {
	f.calls = append(f.calls, fakeCall{name: name, args: args})
	if f.errOn != "" && strings.Contains(name+" "+strings.Join(args, " "), f.errOn) {
		return errors.New("boom")
	}
	return nil
}

type fakeFS struct {
	existing   map[string]bool
	removed    []string
	removedAll []string
	written    map[string][]byte
}

func newFakeFS(paths ...string) *fakeFS {
	m := make(map[string]bool, len(paths))
	for _, p := range paths {
		m[p] = true
	}
	return &fakeFS{
		existing: m,
		written:  make(map[string][]byte),
	}
}

func (f *fakeFS) Remove(path string) error {
	f.removed = append(f.removed, path)
	delete(f.existing, path)
	return nil
}

func (f *fakeFS) RemoveAll(path string) error {
	f.removedAll = append(f.removedAll, path)
	delete(f.existing, path)
	return nil
}

func (f *fakeFS) Exists(path string) bool {
	return f.existing[path]
}

func (f *fakeFS) WriteFile(path string, data []byte, _ os.FileMode) error {
	f.written[path] = data
	f.existing[path] = true
	return nil
}

func TestRunRequiresRoot(t *testing.T) {
	err := Run(context.Background(), Options{
		Geteuid: func() int { return 1000 },
	})
	if err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("expected root error, got %v", err)
	}
}

func TestRunKeepsXrayAndUserWhenXrayRemains(t *testing.T) {
	runner := &fakeRunner{}
	fs := newFakeFS(DefaultXrayUnitPath)
	var out, errOut bytes.Buffer
	notified := false

	err := Run(context.Background(), Options{
		ConfigPath: DefaultConfigPath,
		RemoveXray: false,
		LocalOnly:  false,
		Stdout:     &out,
		Stderr:     &errOut,
		Runner:     runner,
		FS:         fs,
		Geteuid:    func() int { return 0 },
		NotifyFunc: func(_ context.Context, configPath string) error {
			notified = true
			if configPath != DefaultConfigPath {
				t.Fatalf("configPath = %q, want %q", configPath, DefaultConfigPath)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if !notified {
		t.Fatal("expected control plane to be notified")
	}

	for _, call := range runner.calls {
		if call.name == "userdel" || call.name == "groupdel" {
			t.Fatalf("unexpected user/group removal while xray.service remains: %+v", call)
		}
	}
	for _, p := range fs.removed {
		if p == DefaultXrayUnitPath || p == DefaultXrayBinaryPath {
			t.Fatalf("unexpected xray file removal: %s", p)
		}
	}
}

func TestRunRemovesXrayAndContinuesOnNotifyFailure(t *testing.T) {
	runner := &fakeRunner{}
	fs := newFakeFS(DefaultXrayUnitPath)
	var out, errOut bytes.Buffer

	err := Run(context.Background(), Options{
		ConfigPath: DefaultConfigPath,
		RemoveXray: true,
		LocalOnly:  false,
		Stdout:     &out,
		Stderr:     &errOut,
		Runner:     runner,
		FS:         fs,
		Geteuid:    func() int { return 0 },
		NotifyFunc: func(_ context.Context, _ string) error {
			return errors.New("panel unreachable")
		},
	})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if !strings.Contains(errOut.String(), "warning") {
		t.Fatalf("expected warning in stderr, got %q", errOut.String())
	}

	wantCalls := []fakeCall{
		{name: "systemctl", args: []string{"stop", "zako-agent.service"}},
		{name: "systemctl", args: []string{"disable", "zako-agent.service"}},
		{name: "systemctl", args: []string{"stop", "xray.service"}},
		{name: "systemctl", args: []string{"disable", "xray.service"}},
		{name: "systemctl", args: []string{"daemon-reload"}},
		{name: "userdel", args: []string{"zako-agent"}},
		{name: "groupdel", args: []string{"zako-agent"}},
	}
	if !reflect.DeepEqual(runner.calls, wantCalls) {
		t.Fatalf("calls = %+v, want %+v", runner.calls, wantCalls)
	}
}

func TestParseUninstallDirective(t *testing.T) {
	triggered, removeXray := ParseUninstallDirective([]reporter.Directive{
		{Type: "noop"},
		{Type: "uninstall", Payload: map[string]json.RawMessage{"remove_xray": json.RawMessage("true")}},
	})
	if !triggered || !removeXray {
		t.Fatalf("got (%v, %v), want (true, true)", triggered, removeXray)
	}

	triggered, removeXray = ParseUninstallDirective([]reporter.Directive{{Type: "noop"}})
	if triggered || removeXray {
		t.Fatalf("got (%v, %v), want (false, false)", triggered, removeXray)
	}
}

func TestTriggerFromDirective(t *testing.T) {
	runner := &fakeRunner{}
	fs := newFakeFS()

	if err := TriggerFromDirective(context.Background(), true, DefaultStateDir, runner, fs); err != nil {
		t.Fatalf("TriggerFromDirective failed: %v", err)
	}
	marker := filepath.Join(DefaultStateDir, RemoveXrayMarkerName)
	if _, ok := fs.written[marker]; !ok {
		t.Fatalf("expected marker %s to be written", marker)
	}
	want := []fakeCall{{name: "systemctl", args: []string{"start", "--no-block", UninstallUnitName}}}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("calls = %+v, want %+v", runner.calls, want)
	}
}
