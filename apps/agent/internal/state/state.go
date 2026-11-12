// Package state owns the agent's node-local BoltDB facts.
//
// The database survives restarts and is the node's side of the truth for counter
// baselines, unacknowledged reports, the persisted user set and scalar versions.
// Bucket names are part of the on-disk format, so they must not change without a
// migration.
//
// Outbox ACK/retention and user-set persistence accessors are deliberately absent:
// their semantics belong to the reporter and syncer implementations.
package state

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	bucketMeta   = []byte("meta")
	bucketOutbox = []byte("outbox")
	bucketUsers  = []byte("users")
)

// ErrClosed is returned when a Store is used after Close.
var ErrClosed = errors.New("state: store is closed")

// MetadataKey identifies a scalar node-local fact.
type MetadataKey string

const (
	// KeyUsersVersion is the last users_ver applied locally; 0 means never synced.
	KeyUsersVersion MetadataKey = "users_version"
	// KeyAppliedConfigVersion is the last configuration version known to be running.
	KeyAppliedConfigVersion MetadataKey = "applied_config_version"
	// KeyXrayUptimeSeconds is the Xray uptime at the last sample, used to detect
	// counter resets after an Xray restart.
	KeyXrayUptimeSeconds MetadataKey = "xray_uptime_seconds"
)

// Store is a BoltDB handle. It is safe for concurrent use by multiple goroutines
// as long as Close is not racing with accessors.
type Store struct {
	db *bolt.DB
}

// Open creates the database at path with mode 0600 and initializes all buckets.
// Bolt refuses to create missing parent directories; the installer owns them.
func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("state: path is required")
	}

	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("state: open %s: %w", path, err)
	}
	// bolt.Open applies the mode only when it creates the file. Enforce the
	// architecture's 0600 invariant for pre-existing databases as well.
	if err := os.Chmod(path, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("state: set permissions on %s: %w", path, err)
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{bucketMeta, bucketOutbox, bucketUsers} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return fmt.Errorf("create bucket %q: %w", name, err)
			}
		}
		return nil
	}); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("state: initialize %s: %w", path, err)
	}

	return &Store{db: db}, nil
}

// Close releases the database file lock. It is safe to call once after all loops
// have stopped.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	if err != nil {
		return fmt.Errorf("state: close: %w", err)
	}
	return nil
}

// MetaInt64 returns the stored value and whether the key exists. Missing keys
// return zero with found=false so callers can distinguish "never recorded" from
// a legitimate zero version.
func (s *Store) MetaInt64(key MetadataKey) (value int64, found bool, err error) {
	db, err := s.handle()
	if err != nil {
		return 0, false, err
	}
	if key == "" {
		return 0, false, errors.New("state: metadata key is required")
	}

	err = db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketMeta)
		if bucket == nil {
			return fmt.Errorf("state: bucket %q is missing", bucketMeta)
		}
		raw := bucket.Get([]byte(key))
		if raw == nil {
			return nil
		}
		if len(raw) != 8 {
			return fmt.Errorf("state: metadata %q has %d bytes, want 8", key, len(raw))
		}
		value = int64(binary.BigEndian.Uint64(raw))
		found = true
		return nil
	})
	if err != nil {
		return 0, false, err
	}
	return value, found, nil
}

// SetMetaInt64 stores value atomically in its own transaction.
func (s *Store) SetMetaInt64(key MetadataKey, value int64) error {
	db, err := s.handle()
	if err != nil {
		return err
	}
	if key == "" {
		return errors.New("state: metadata key is required")
	}

	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], uint64(value))
	return db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketMeta)
		if bucket == nil {
			return fmt.Errorf("state: bucket %q is missing", bucketMeta)
		}
		if err := bucket.Put([]byte(key), encoded[:]); err != nil {
			return fmt.Errorf("state: write metadata %q: %w", key, err)
		}
		return nil
	})
}

func (s *Store) handle() (*bolt.DB, error) {
	if s == nil || s.db == nil {
		return nil, ErrClosed
	}
	return s.db, nil
}
