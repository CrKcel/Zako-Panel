package atomicfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteReplacesFileAndLeavesNoTemporary(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "nested", "users.json")

	if err := Write(path, []byte("first"), 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := Write(path, []byte("second"), 0o600); err != nil {
		t.Fatalf("second Write: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "second" {
		t.Errorf("content = %q, want the replacement", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0o600); got != want {
		t.Errorf("mode = %o, want %o", got, want)
	}

	// A leftover temporary file would accumulate on every sync and confuse an
	// operator reading the state directory.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "users.json" {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Errorf("directory entries = %v, want only users.json", names)
	}
}

func TestWriteRequiresPath(t *testing.T) {
	if err := Write("", []byte("data"), 0o600); err == nil {
		t.Fatal("Write accepted an empty path")
	}
}
