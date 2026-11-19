// Package state owns the agent's node-local BoltDB facts.
//
// The database survives restarts and is the node's side of the truth for counter
// baselines, unacknowledged reports, the persisted user set and scalar versions.
// Bucket names and key layouts are part of the on-disk format, so they must not
// change without a migration.
//
// The package exposes read/write primitives that operate on an opaque Tx handle.
// Delta accounting needs the pending report, the baselines and the Xray uptime to
// move together; one Store.Update call is the only transaction that guarantees
// that. The Bolt types stay inside this package so callers never depend on the
// storage engine.
package state

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Bucket names are persisted on disk. Changing one requires a migration.
var (
	// bucketMeta holds scalar metadata: users_ver, applied_config_version and
	// the last recorded Xray uptime.
	bucketMeta = []byte("meta")
	// bucketOutbox holds closed reports waiting for a Worker ACK, keyed by
	// report_id. Report IDs are ULIDs, so iteration order is age order.
	bucketOutbox = []byte("outbox")
	// bucketUsers stays allocated after the on-disk format shipped. The applied
	// user set lives in users.json so Xray's disk config and the set are written
	// as one unit, not in a second Bolt record.
	bucketUsers = []byte("users")
	// bucketBaseline holds the last observed cumulative counters plus the
	// uptime needed to detect an Xray restart.
	bucketBaseline = []byte("baseline")
	// bucketPending holds unsettled hourly reports, keyed by period start and
	// report_id so a restart resumes the same batch.
	bucketPending = []byte("pending_reports")
)

// Baseline key prefixes. Reserved keys start with '!' so they cannot collide
// with a user email or inbound tag.
var (
	baselineUserPrefix    = []byte("u|")
	baselineInboundPrefix = []byte("i|")
	baselineUptimeKey     = []byte("!uptime")
	baselineInitialized   = []byte("!initialized")
	baselineSampleAtKey   = []byte("!sample_at")
)

// ErrClosed is returned when a Store is used after Close.
var ErrClosed = errors.New("state: store is closed")

// MetadataKey identifies a scalar node-local fact.
type MetadataKey string

const (
	// KeyUsersVersion is the last users_ver whose set was fully applied locally:
	// the Xray config on disk and the persisted user set match it. Only the
	// syncer advances it after every write succeeded, so a failed apply cannot
	// claim users the node does not serve. 0 means never synced.
	KeyUsersVersion MetadataKey = "users_version"
	// KeyDesiredUsersVersion is the users_ver the Worker last advertised. It is a
	// sync trigger hint, not proof of application, so the syncer never uses it as
	// the applied version.
	KeyDesiredUsersVersion MetadataKey = "desired_users_version"
	// KeyAppliedConfigVersion is the last configuration version known to be running.
	KeyAppliedConfigVersion MetadataKey = "applied_config_version"
	// KeyDesiredConfigVersion is the last desired version advertised by the Worker.
	KeyDesiredConfigVersion MetadataKey = "desired_config_version"
	// KeyFailedConfigVersion records the latest config version that failed to apply
	// so the agent does not repeatedly restart Xray for the same broken version.
	KeyFailedConfigVersion MetadataKey = "failed_config_version"
	// KeyFailedAgentVersion records the latest agent version that failed to apply
	// or rolled back so the agent does not repeatedly retry the same broken version.
	KeyFailedAgentVersion MetadataKey = "failed_agent_version"
)

// Store is a BoltDB handle. It is safe for concurrent use by multiple goroutines
// as long as Close is not racing with accessors.
type Store struct {
	db *bolt.DB
}

// Tx is an opaque transaction handle passed to the storage primitives. It hides
// the underlying engine so accounting and the loops do not import bbolt.
type Tx struct {
	tx *bolt.Tx
}

// bucket returns one of the on-disk buckets. A missing bucket means the database
// was not opened by this package, so it is reported as a corrupt store rather than
// silently recreated inside a read transaction.
func (t *Tx) bucket(name []byte) (*bolt.Bucket, error) {
	if t == nil || t.tx == nil {
		return nil, errors.New("state: transaction is required")
	}
	bucket := t.tx.Bucket(name)
	if bucket == nil {
		return nil, fmt.Errorf("state: bucket %q is missing", name)
	}
	return bucket, nil
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
		for _, name := range [][]byte{bucketMeta, bucketOutbox, bucketUsers, bucketBaseline, bucketPending} {
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

// View runs fn in a read-only transaction.
func (s *Store) View(fn func(tx *Tx) error) error {
	if fn == nil {
		return errors.New("state: view function is required")
	}
	db, err := s.handle()
	if err != nil {
		return err
	}
	return db.View(func(tx *bolt.Tx) error {
		return fn(&Tx{tx: tx})
	})
}

// Update runs fn in a single read-write transaction. Every multi-key update must
// use one Update call: a partially applied sample would double count or lose
// traffic.
func (s *Store) Update(fn func(tx *Tx) error) error {
	if fn == nil {
		return errors.New("state: update function is required")
	}
	db, err := s.handle()
	if err != nil {
		return err
	}
	return db.Update(func(tx *bolt.Tx) error {
		return fn(&Tx{tx: tx})
	})
}

// MetaInt64 returns the stored value and whether the key exists. Missing keys
// return zero with found=false so callers can distinguish "never recorded" from
// a legitimate zero version.
func (s *Store) MetaInt64(key MetadataKey) (value int64, found bool, err error) {
	err = s.View(func(tx *Tx) error {
		value, found, err = metaInt64(tx, key)
		return err
	})
	if err != nil {
		return 0, false, err
	}
	return value, found, nil
}

func metaInt64(tx *Tx, key MetadataKey) (int64, bool, error) {
	if key == "" {
		return 0, false, errors.New("state: metadata key is required")
	}
	bucket, err := tx.bucket(bucketMeta)
	if err != nil {
		return 0, false, err
	}
	raw := bucket.Get([]byte(key))
	if raw == nil {
		return 0, false, nil
	}
	if len(raw) != 8 {
		return 0, false, fmt.Errorf("state: metadata %q has %d bytes, want 8", key, len(raw))
	}
	return int64(binary.BigEndian.Uint64(raw)), true, nil
}

// SetMetaInt64 stores value atomically in its own transaction.
func (s *Store) SetMetaInt64(key MetadataKey, value int64) error {
	err := s.Update(func(tx *Tx) error {
		return setMetaInt64(tx, key, value)
	})
	if err != nil {
		return err
	}
	return nil
}

// MetaString returns the stored string value and whether the key exists.
func (s *Store) MetaString(key MetadataKey) (value string, found bool, err error) {
	err = s.View(func(tx *Tx) error {
		if key == "" {
			return errors.New("state: metadata key is required")
		}
		bucket, err := tx.bucket(bucketMeta)
		if err != nil {
			return err
		}
		raw := bucket.Get([]byte(key))
		if raw == nil {
			return nil
		}
		value = string(raw)
		found = true
		return nil
	})
	if err != nil {
		return "", false, err
	}
	return value, found, nil
}

// SetMetaString stores a string value atomically in its own transaction.
func (s *Store) SetMetaString(key MetadataKey, value string) error {
	if key == "" {
		return errors.New("state: metadata key is required")
	}
	return s.Update(func(tx *Tx) error {
		bucket, err := tx.bucket(bucketMeta)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(key), []byte(value))
	})
}

func setMetaInt64(tx *Tx, key MetadataKey, value int64) error {
	if key == "" {
		return errors.New("state: metadata key is required")
	}
	bucket, err := tx.bucket(bucketMeta)
	if err != nil {
		return err
	}
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], uint64(value))
	if err := bucket.Put([]byte(key), encoded[:]); err != nil {
		return fmt.Errorf("state: write metadata %q: %w", key, err)
	}
	return nil
}

// CounterBaseline is one cumulative counter pair at the last sample.
type CounterBaseline struct {
	UplinkBytes   int64
	DownlinkBytes int64
}

// Baselines is the complete counter baseline state written by one sample.
type Baselines struct {
	// Initialized is false until the first successful sample has established
	// baselines. No delta is produced before that point.
	Initialized bool
	// LastSampleAt is the previous sample time in Unix seconds. It is used to
	// detect a sample that spans an hour boundary, whose traffic cannot be
	// attributed to the earlier bucket exactly.
	LastSampleAt  int64
	UptimeSeconds int64
	Users         map[string]CounterBaseline
	Inbounds      map[string]CounterBaseline
}

func (b Baselines) clone() Baselines {
	cloned := Baselines{
		Initialized:   b.Initialized,
		LastSampleAt:  b.LastSampleAt,
		UptimeSeconds: b.UptimeSeconds,
		Users:         make(map[string]CounterBaseline, len(b.Users)),
		Inbounds:      make(map[string]CounterBaseline, len(b.Inbounds)),
	}
	for email, counter := range b.Users {
		cloned.Users[email] = counter
	}
	for tag, counter := range b.Inbounds {
		cloned.Inbounds[tag] = counter
	}
	return cloned
}

// ReadBaselines returns every stored counter baseline. It must be called inside a
// transaction so the caller can write the derived state atomically.
func ReadBaselines(tx *Tx) (Baselines, error) {
	bucket, err := tx.bucket(bucketBaseline)
	if err != nil {
		return Baselines{}, err
	}

	baselines := Baselines{
		Users:    make(map[string]CounterBaseline),
		Inbounds: make(map[string]CounterBaseline),
	}
	if raw := bucket.Get(baselineUptimeKey); raw != nil {
		if len(raw) != 8 {
			return Baselines{}, fmt.Errorf("state: uptime baseline has %d bytes, want 8", len(raw))
		}
		baselines.UptimeSeconds = int64(binary.BigEndian.Uint64(raw))
	}
	if raw := bucket.Get(baselineInitialized); raw != nil {
		if len(raw) != 1 {
			return Baselines{}, fmt.Errorf("state: initialized marker has %d bytes, want 1", len(raw))
		}
		baselines.Initialized = raw[0] == 1
	}
	if raw := bucket.Get(baselineSampleAtKey); raw != nil {
		if len(raw) != 8 {
			return Baselines{}, fmt.Errorf("state: sample timestamp has %d bytes, want 8", len(raw))
		}
		baselines.LastSampleAt = int64(binary.BigEndian.Uint64(raw))
	}

	err = bucket.ForEach(func(key, value []byte) error {
		switch {
		case bytes.HasPrefix(key, baselineUserPrefix):
			counter, err := decodeBaseline(value)
			if err != nil {
				return err
			}
			baselines.Users[string(key[len(baselineUserPrefix):])] = counter
		case bytes.HasPrefix(key, baselineInboundPrefix):
			counter, err := decodeBaseline(value)
			if err != nil {
				return err
			}
			baselines.Inbounds[string(key[len(baselineInboundPrefix):])] = counter
		}
		return nil
	})
	if err != nil {
		return Baselines{}, err
	}
	return baselines, nil
}

// ReplaceBaselines makes baselines the complete stored baseline set. Entries that
// vanished from the sample are deleted, which is how a missing counter is cleaned
// up instead of producing a negative delta on its return.
func ReplaceBaselines(tx *Tx, baselines Baselines) error {
	bucket, err := tx.bucket(bucketBaseline)
	if err != nil {
		return err
	}

	stale := make([][]byte, 0)
	err = bucket.ForEach(func(key, _ []byte) error {
		switch {
		case bytes.HasPrefix(key, baselineUserPrefix):
			if _, found := baselines.Users[string(key[len(baselineUserPrefix):])]; !found {
				stale = append(stale, append([]byte(nil), key...))
			}
		case bytes.HasPrefix(key, baselineInboundPrefix):
			if _, found := baselines.Inbounds[string(key[len(baselineInboundPrefix):])]; !found {
				stale = append(stale, append([]byte(nil), key...))
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, key := range stale {
		if err := bucket.Delete(key); err != nil {
			return fmt.Errorf("state: delete stale baseline %q: %w", key, err)
		}
	}

	for email, counter := range baselines.Users {
		if err := bucket.Put(append(append([]byte(nil), baselineUserPrefix...), email...), encodeBaseline(counter)); err != nil {
			return fmt.Errorf("state: write user baseline: %w", err)
		}
	}
	for tag, counter := range baselines.Inbounds {
		if err := bucket.Put(append(append([]byte(nil), baselineInboundPrefix...), tag...), encodeBaseline(counter)); err != nil {
			return fmt.Errorf("state: write inbound baseline: %w", err)
		}
	}

	var uptime [8]byte
	binary.BigEndian.PutUint64(uptime[:], uint64(baselines.UptimeSeconds))
	if err := bucket.Put(baselineUptimeKey, uptime[:]); err != nil {
		return fmt.Errorf("state: write uptime baseline: %w", err)
	}
	marker := byte(0)
	if baselines.Initialized {
		marker = 1
	}
	if err := bucket.Put(baselineInitialized, []byte{marker}); err != nil {
		return fmt.Errorf("state: write initialized marker: %w", err)
	}
	var sampleAt [8]byte
	binary.BigEndian.PutUint64(sampleAt[:], uint64(baselines.LastSampleAt))
	if err := bucket.Put(baselineSampleAtKey, sampleAt[:]); err != nil {
		return fmt.Errorf("state: write sample timestamp: %w", err)
	}
	return nil
}

func encodeBaseline(counter CounterBaseline) []byte {
	var encoded [16]byte
	binary.BigEndian.PutUint64(encoded[0:8], uint64(counter.UplinkBytes))
	binary.BigEndian.PutUint64(encoded[8:16], uint64(counter.DownlinkBytes))
	return encoded[:]
}

func decodeBaseline(raw []byte) (CounterBaseline, error) {
	if len(raw) != 16 {
		return CounterBaseline{}, fmt.Errorf("state: baseline has %d bytes, want 16", len(raw))
	}
	return CounterBaseline{
		UplinkBytes:   int64(binary.BigEndian.Uint64(raw[0:8])),
		DownlinkBytes: int64(binary.BigEndian.Uint64(raw[8:16])),
	}, nil
}

// ReportUser is one non-zero user entry in a report batch.
type ReportUser struct {
	Email         string `json:"xray_email"`
	UplinkBytes   int64  `json:"uplink_bytes"`
	DownlinkBytes int64  `json:"downlink_bytes"`
}

// TrafficReport is one immutable report batch. Its report_id is generated when
// the batch is opened and never changes, so a retry after an ACK loss is
// idempotent on the Worker.
type TrafficReport struct {
	ReportID      string       `json:"report_id"`
	PeriodStart   int64        `json:"period_start"`
	PeriodEnd     int64        `json:"period_end"`
	HasCounterGap bool         `json:"has_counter_gap"`
	UplinkBytes   int64        `json:"uplink_bytes"`
	DownlinkBytes int64        `json:"downlink_bytes"`
	Users         []ReportUser `json:"users"`
}

// AddUser accumulates delta for email and keeps Users sorted by email.
func (r *TrafficReport) AddUser(email string, uplink, downlink int64) {
	for index := range r.Users {
		if r.Users[index].Email == email {
			r.Users[index].UplinkBytes += uplink
			r.Users[index].DownlinkBytes += downlink
			return
		}
	}
	r.Users = append(r.Users, ReportUser{Email: email, UplinkBytes: uplink, DownlinkBytes: downlink})
	sort.Slice(r.Users, func(i, j int) bool { return r.Users[i].Email < r.Users[j].Email })
}

// User returns the entry for email if present.
func (r TrafficReport) User(email string) (ReportUser, bool) {
	for _, user := range r.Users {
		if user.Email == email {
			return user, true
		}
	}
	return ReportUser{}, false
}

// Empty reports carry no traffic and are never persisted.
func (r TrafficReport) Empty() bool {
	return r.UplinkBytes == 0 && r.DownlinkBytes == 0 && len(r.Users) == 0
}

func pendingKey(periodStart int64, reportID string) []byte {
	key := make([]byte, 8, 8+len(reportID))
	binary.BigEndian.PutUint64(key, uint64(periodStart))
	return append(key, reportID...)
}

func encodeReport(report TrafficReport) ([]byte, error) {
	encoded, err := json.Marshal(report)
	if err != nil {
		return nil, fmt.Errorf("state: encode report %s: %w", report.ReportID, err)
	}
	return encoded, nil
}

func decodeReport(raw []byte) (TrafficReport, error) {
	var report TrafficReport
	if err := json.Unmarshal(raw, &report); err != nil {
		return TrafficReport{}, fmt.Errorf("state: decode report: %w", err)
	}
	return report, nil
}

// PendingReportsForHour returns open reports whose period starts at hourStart, in
// report_id order.
func PendingReportsForHour(tx *Tx, hourStart int64) ([]TrafficReport, error) {
	bucket, err := tx.bucket(bucketPending)
	if err != nil {
		return nil, err
	}
	prefix := make([]byte, 8)
	binary.BigEndian.PutUint64(prefix, uint64(hourStart))

	reports := make([]TrafficReport, 0, 1)
	cursor := bucket.Cursor()
	for key, value := cursor.Seek(prefix); key != nil && bytes.HasPrefix(key, prefix); key, value = cursor.Next() {
		report, err := decodeReport(value)
		if err != nil {
			return nil, err
		}
		reports = append(reports, report)
	}
	return reports, nil
}

// PutPendingReport creates or replaces an open report. Its key is derived from
// PeriodStart and ReportID.
func PutPendingReport(tx *Tx, report TrafficReport) error {
	encoded, err := encodeReport(report)
	if err != nil {
		return err
	}
	bucket, err := tx.bucket(bucketPending)
	if err != nil {
		return err
	}
	if err := bucket.Put(pendingKey(report.PeriodStart, report.ReportID), encoded); err != nil {
		return fmt.Errorf("state: write pending report %s: %w", report.ReportID, err)
	}
	return nil
}

// DeletePendingReport removes one open report after it moved to the outbox.
func DeletePendingReport(tx *Tx, report TrafficReport) error {
	bucket, err := tx.bucket(bucketPending)
	if err != nil {
		return err
	}
	if err := bucket.Delete(pendingKey(report.PeriodStart, report.ReportID)); err != nil {
		return fmt.Errorf("state: delete pending report %s: %w", report.ReportID, err)
	}
	return nil
}

// PendingReports returns every open report ordered by period start and report_id.
func PendingReports(tx *Tx) ([]TrafficReport, error) {
	bucket, err := tx.bucket(bucketPending)
	if err != nil {
		return nil, err
	}
	reports := make([]TrafficReport, 0)
	err = bucket.ForEach(func(_, value []byte) error {
		report, err := decodeReport(value)
		if err != nil {
			return err
		}
		reports = append(reports, report)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return reports, nil
}

// PutOutboxReport stores one closed report. The key is the report_id, so
// re-enqueueing after a crash overwrites instead of duplicating.
func PutOutboxReport(tx *Tx, report TrafficReport) error {
	if report.ReportID == "" {
		return errors.New("state: outbox report requires a report_id")
	}
	encoded, err := encodeReport(report)
	if err != nil {
		return err
	}
	bucket, err := tx.bucket(bucketOutbox)
	if err != nil {
		return err
	}
	if err := bucket.Put([]byte(report.ReportID), encoded); err != nil {
		return fmt.Errorf("state: write outbox report %s: %w", report.ReportID, err)
	}
	return nil
}

// EarliestOutboxReport returns the oldest pending report. Outbox keys are ULIDs,
// which sort chronologically.
func EarliestOutboxReport(tx *Tx) (TrafficReport, bool, error) {
	bucket, err := tx.bucket(bucketOutbox)
	if err != nil {
		return TrafficReport{}, false, err
	}
	key, value := bucket.Cursor().First()
	if key == nil {
		return TrafficReport{}, false, nil
	}
	report, err := decodeReport(value)
	if err != nil {
		return TrafficReport{}, false, err
	}
	return report, true, nil
}

// OutboxReports returns every stored report in report_id order.
func OutboxReports(tx *Tx) ([]TrafficReport, error) {
	bucket, err := tx.bucket(bucketOutbox)
	if err != nil {
		return nil, err
	}
	reports := make([]TrafficReport, 0)
	err = bucket.ForEach(func(_, value []byte) error {
		report, err := decodeReport(value)
		if err != nil {
			return err
		}
		reports = append(reports, report)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return reports, nil
}

// DeleteOutboxReport removes one acknowledged report. Deleting a missing key is
// not an error: duplicate ACKs are harmless.
func DeleteOutboxReport(tx *Tx, reportID string) error {
	bucket, err := tx.bucket(bucketOutbox)
	if err != nil {
		return err
	}
	if err := bucket.Delete([]byte(reportID)); err != nil {
		return fmt.Errorf("state: delete outbox report %s: %w", reportID, err)
	}
	return nil
}

// OutboxLen returns the number of reports waiting for an ACK.
func (s *Store) OutboxLen() (int, error) {
	count := 0
	err := s.View(func(tx *Tx) error {
		bucket, err := tx.bucket(bucketOutbox)
		if err != nil {
			return err
		}
		cursor := bucket.Cursor()
		for key, _ := cursor.First(); key != nil; key, _ = cursor.Next() {
			count++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

// EarliestOutbox returns the oldest report waiting for an ACK.
func (s *Store) EarliestOutbox() (TrafficReport, bool, error) {
	var report TrafficReport
	var found bool
	err := s.View(func(tx *Tx) error {
		var err error
		report, found, err = EarliestOutboxReport(tx)
		return err
	})
	if err != nil {
		return TrafficReport{}, false, err
	}
	return report, found, nil
}

// DeleteOutbox removes one report in its own transaction.
func (s *Store) DeleteOutbox(reportID string) error {
	return s.Update(func(tx *Tx) error {
		return DeleteOutboxReport(tx, reportID)
	})
}

func (s *Store) handle() (*bolt.DB, error) {
	if s == nil || s.db == nil {
		return nil, ErrClosed
	}
	return s.db, nil
}
