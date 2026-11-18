// Package atomicfile replaces files so a reader never observes a partial write.
//
// Two agent artifacts are read by other processes: users.json is reloaded by the
// next agent start and /etc/xray/config.json is read by Xray on restart. The
// helper writes a temporary file in the target directory, fsyncs it, renames it
// over the target and fsyncs the directory, so a crash leaves either the old or
// the new file. The directory fsync is what makes the rename itself durable; the
// file fsync alone can leave an empty entry after a power loss.
package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Write replaces path with data using mode. Missing parent directories are
// created with 0700; the caller owns the directory tree, so widening an existing
// directory is never attempted.
func Write(path string, data []byte, mode os.FileMode) error {
	if path == "" {
		return errors.New("atomicfile: path is required")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("atomicfile: create directory %s: %w", directory, err)
	}

	file, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("atomicfile: create temporary file next to %s: %w", path, err)
	}
	temporary := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(temporary)
	}

	if _, err := file.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("atomicfile: write %s: %w", temporary, err)
	}
	// CreateTemp uses 0600; chmod before the rename so the final inode already
	// carries the required mode.
	if err := file.Chmod(mode); err != nil {
		cleanup()
		return fmt.Errorf("atomicfile: set mode on %s: %w", temporary, err)
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("atomicfile: sync %s: %w", temporary, err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("atomicfile: close %s: %w", temporary, err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("atomicfile: replace %s: %w", path, err)
	}
	if err := syncDirectory(directory); err != nil {
		return err
	}
	return nil
}

func syncDirectory(directory string) error {
	handle, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("atomicfile: open directory %s: %w", directory, err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("atomicfile: sync directory %s: %w", directory, err)
	}
	return nil
}
