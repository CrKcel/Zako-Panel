// Package syncer owns the users_ver -> Xray user set pipeline.
//
// The Worker advertises users_ver in every report response; a change triggers
// GET /api/v1/agent/users with If-None-Match. This is a P1 capability: persisting
// a set atomically to disk and applying it through HandlerService is not
// implemented, and the agent logs that instead of claiming a node is in sync.
package syncer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
)

// ErrNotImplemented marks the unimplemented fetch/persist/apply pipeline.
var ErrNotImplemented = errors.New("syncer: user sync not implemented")

// UsersVersion is meta.users_ver as exposed by the control plane. The Worker
// accepts its decimal form as the If-None-Match entity tag, so ETag is the only
// supported encoding; callers must not invent their own validator.
type UsersVersion int64

func (v UsersVersion) String() string {
	return strconv.FormatInt(int64(v), 10)
}

// ETag returns the quoted entity tag for If-None-Match. A matching tag yields
// HTTP 304 and no body.
func (v UsersVersion) ETag() string {
	return strconv.Quote(v.String())
}

// Syncer applies versioned user sets. User sync and remote config application
// share one mutation lock (docs/agent.md §4.3); this P1 placeholder has no apply
// path, so no lock is acquired yet.
type Syncer struct {
	reporter  *reporter.Reporter
	state     *state.Store
	usersPath string
	logger    *slog.Logger
}

// New validates dependencies. usersPath is where the user set will be written
// with mode 0600 and atomically renamed into place.
func New(client *reporter.Reporter, store *state.Store, usersPath string, logger *slog.Logger) (*Syncer, error) {
	if client == nil {
		return nil, errors.New("syncer: reporter is required")
	}
	if store == nil {
		return nil, errors.New("syncer: state store is required")
	}
	if usersPath == "" {
		return nil, errors.New("syncer: users path is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Syncer{reporter: client, state: store, usersPath: usersPath, logger: logger}, nil
}

// SyncOnce performs one versioned fetch and apply. It is not implemented: it
// does not fetch users, persist them, mutate Xray, or update the stored
// users_ver. Returning a typed error keeps callers from treating the node as
// synchronized.
func (s *Syncer) SyncOnce(context.Context) error {
	return fmt.Errorf("syncer: sync users: %w", ErrNotImplemented)
}

// Run blocks until ctx is canceled. It deliberately does not poll: a no-op loop
// that succeeds would leave the node silently out of sync.
func (s *Syncer) Run(ctx context.Context) error {
	s.logger.Info("syncer idle: user sync not implemented", "users_path", s.usersPath)
	<-ctx.Done()
	return nil
}
