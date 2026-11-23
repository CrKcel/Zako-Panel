package xraycore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// defaultHandlerCallTimeout bounds one HandlerService RPC. A hung loopback call
// must not stall the sync loop or hold the config in an intermediate state.
const defaultHandlerCallTimeout = 5 * time.Second

// HandlerClient is the loopback gRPC HandlerService client.
//
// It mutates the running inbound only; it never rewrites the config file and never
// restarts Xray. A restarted Xray forgets these changes and reloads the config
// file, which is why the syncer also persists the user set to disk.
//
// The connection is created lazily like StatsClient and reconnects on its own, so
// an Xray restart does not need an agent restart.
type HandlerClient struct {
	conn    *grpc.ClientConn
	timeout time.Duration
	// targets names every managed inbound with the protocol its account encoding
	// belongs to. An adopted node can expose more than one inbound, and one user
	// needs a different account message per protocol.
	targets []InboundTarget
}

// HandlerClientOption customizes a HandlerClient.
type HandlerClientOption func(*HandlerClient)

// WithHandlerCallTimeout overrides the per-call deadline.
func WithHandlerCallTimeout(timeout time.Duration) HandlerClientOption {
	return func(client *HandlerClient) {
		if timeout > 0 {
			client.timeout = timeout
		}
	}
}

// NewHandlerClient dials target without blocking. inboundTag names the initial
// managed inbound to mutate; the syncer refreshes the targets from the config
// document before each hot update, because HandlerService addresses inbounds by
// tag and every inbound needs the account encoding of its own protocol.
func NewHandlerClient(target, inboundTag string, opts ...HandlerClientOption) (*HandlerClient, error) {
	if err := validateTarget(target); err != nil {
		return nil, err
	}
	if strings.TrimSpace(inboundTag) == "" {
		return nil, errors.New("xray: handler inbound tag is required")
	}

	client := &HandlerClient{timeout: defaultHandlerCallTimeout}
	for _, opt := range opts {
		opt(client)
	}
	// The protocol stays unknown until the syncer reads the document; an AddUser
	// before that refresh fails and converges through the config-restart path.
	if err := client.SetInboundTargets([]InboundTarget{{Tag: inboundTag}}); err != nil {
		return nil, err
	}

	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.ForceCodec(handlerCodec{})),
	)
	if err != nil {
		return nil, fmt.Errorf("xray: dial handler service %s: %w", target, err)
	}
	client.conn = conn
	return client, nil
}

// SetInboundTargets replaces the managed inbounds. Entries without a tag and
// duplicate tags are dropped so a malformed config cannot produce a no-op RPC.
func (c *HandlerClient) SetInboundTargets(targets []InboundTarget) error {
	seen := make(map[string]bool, len(targets))
	normalized := make([]InboundTarget, 0, len(targets))
	for _, target := range targets {
		tag := strings.TrimSpace(target.Tag)
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		target.Tag = tag
		normalized = append(normalized, target)
	}
	if len(normalized) == 0 {
		return errors.New("xray: at least one inbound target is required")
	}
	c.targets = normalized
	return nil
}

// InboundTargets returns the inbounds hot updates currently target.
func (c *HandlerClient) InboundTargets() []InboundTarget {
	return append([]InboundTarget(nil), c.targets...)
}

// Close releases the gRPC connection. It is safe to call once at shutdown.
func (c *HandlerClient) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	err := c.conn.Close()
	c.conn = nil
	if err != nil {
		return fmt.Errorf("xray: close handler client: %w", err)
	}
	return nil
}

// AddUser adds the user to every managed inbound with the account encoding of that
// inbound's protocol. Xray rejects a second user with the same email, so a replay
// after a partially applied diff fails; the syncer treats that as a signal to
// converge by applying the config file instead of retrying the same delta.
func (c *HandlerClient) AddUser(ctx context.Context, user User) error {
	if strings.TrimSpace(user.Email) == "" {
		return errors.New("xray: add user: email is required")
	}
	if strings.TrimSpace(user.UUID) == "" {
		return errors.New("xray: add user: uuid is required")
	}

	for _, target := range c.targets {
		request, err := encodeAddUserRequest(target, user)
		if err != nil {
			return fmt.Errorf("xray: add user to inbound %q: %w", target.Tag, err)
		}
		if err := c.alterInbound(ctx, request); err != nil {
			return fmt.Errorf("xray: add user to inbound %q: %w", target.Tag, err)
		}
	}
	return nil
}

// RemoveUser removes a client by email from every managed inbound. Xray reports an
// error when the email is unknown; callers must not interpret that as "already
// removed".
func (c *HandlerClient) RemoveUser(ctx context.Context, email string) error {
	if strings.TrimSpace(email) == "" {
		return errors.New("xray: remove user: email is required")
	}
	operation, err := encodeRemoveUserOperation(&removeUserOperation{Email: email})
	if err != nil {
		return fmt.Errorf("xray: remove user: %w", err)
	}
	for _, target := range c.targets {
		if err := c.removeUserFrom(ctx, target, operation); err != nil {
			return err
		}
	}
	return nil
}

// RemoveUserWherePresent removes a client by email from the managed inbounds that
// hold it. An inbound without the account is not an error: the caller is revoking
// an email the panel does not grant, and an adopted config may list its clients on
// one inbound only. Any other failure is still reported.
func (c *HandlerClient) RemoveUserWherePresent(ctx context.Context, email string) error {
	if strings.TrimSpace(email) == "" {
		return errors.New("xray: remove user: email is required")
	}
	operation, err := encodeRemoveUserOperation(&removeUserOperation{Email: email})
	if err != nil {
		return fmt.Errorf("xray: remove user: %w", err)
	}
	for _, target := range c.targets {
		if err := c.removeUserFrom(ctx, target, operation); err != nil && !isUserMissingError(err) {
			return err
		}
	}
	return nil
}

func (c *HandlerClient) removeUserFrom(ctx context.Context, target InboundTarget, operation []byte) error {
	request := &alterInboundRequest{
		Tag:       target.Tag,
		Operation: &typedMessage{Type: removeUserOperationType, Value: operation},
	}
	if err := c.alterInbound(ctx, request); err != nil {
		return fmt.Errorf("xray: remove user from inbound %q: %w", target.Tag, err)
	}
	return nil
}

// userMissingMarker is the fragment Xray's inbound handlers put in the gRPC error
// for an unknown account: "<protocol>: User <email> not found."
const userMissingMarker = "not found."

func isUserMissingError(err error) bool {
	return err != nil && strings.Contains(err.Error(), userMissingMarker)
}

func (c *HandlerClient) alterInbound(ctx context.Context, request *alterInboundRequest) error {
	if c.conn == nil {
		return errors.New("xray: handler client is closed")
	}
	callCtx, cancel := c.callContext(ctx)
	defer cancel()
	return c.conn.Invoke(callCtx, alterInboundMethod, request, &alterInboundResponse{})
}

func (c *HandlerClient) callContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if c.timeout <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, c.timeout)
}
