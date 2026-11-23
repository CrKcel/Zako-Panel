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
	// tags names every managed inbound. An adopted node can expose more than one
	// VLESS + REALITY inbound, and HandlerService addresses inbounds by tag.
	tags []string
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
// VLESS inbound to mutate; the syncer refreshes the tag set from the config
// document before each hot update, because HandlerService addresses inbounds by
// tag rather than by protocol.
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
	if err := client.SetInboundTags([]string{inboundTag}); err != nil {
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

// SetInboundTags replaces the managed inbound tags. Empty and duplicate entries
// are dropped so a config with an untagged inbound cannot produce a no-op RPC.
func (c *HandlerClient) SetInboundTags(tags []string) error {
	seen := make(map[string]bool, len(tags))
	normalized := make([]string, 0, len(tags))
	for _, tag := range tags {
		trimmed := strings.TrimSpace(tag)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return errors.New("xray: at least one inbound tag is required")
	}
	c.tags = normalized
	return nil
}

// InboundTags returns the tags hot updates currently target.
func (c *HandlerClient) InboundTags() []string {
	return append([]string(nil), c.tags...)
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

// AddUser adds a VLESS client with level 0 and the REALITY vision flow. Xray
// rejects a second user with the same email, so a replay after a partially
// applied diff fails; the syncer treats that as a signal to converge by applying
// the config file instead of retrying the same delta.
func (c *HandlerClient) AddUser(ctx context.Context, user User) error {
	if strings.TrimSpace(user.Email) == "" {
		return errors.New("xray: add user: email is required")
	}
	if strings.TrimSpace(user.UUID) == "" {
		return errors.New("xray: add user: uuid is required")
	}
	flow := user.Flow
	if flow == "" {
		flow = FlowVision
	}

	account, err := encodeVlessAccount(&vlessAccount{ID: user.UUID, Flow: flow})
	if err != nil {
		return fmt.Errorf("xray: add user: %w", err)
	}
	operation, err := encodeAddUserOperation(&addUserOperation{
		User: protocolUser{
			Level:   0,
			Email:   user.Email,
			Account: &typedMessage{Type: vlessAccountType, Value: account},
		},
	})
	if err != nil {
		return fmt.Errorf("xray: add user: %w", err)
	}

	for _, tag := range c.tags {
		request := &alterInboundRequest{
			Tag:       tag,
			Operation: &typedMessage{Type: addUserOperationType, Value: operation},
		}
		if err := c.alterInbound(ctx, request); err != nil {
			return fmt.Errorf("xray: add user to inbound %q: %w", tag, err)
		}
	}
	return nil
}

// RemoveUser removes a client by email. Xray reports an error when the email is
// unknown; callers must not interpret that as "already removed".
func (c *HandlerClient) RemoveUser(ctx context.Context, email string) error {
	if strings.TrimSpace(email) == "" {
		return errors.New("xray: remove user: email is required")
	}
	operation, err := encodeRemoveUserOperation(&removeUserOperation{Email: email})
	if err != nil {
		return fmt.Errorf("xray: remove user: %w", err)
	}
	for _, tag := range c.tags {
		request := &alterInboundRequest{
			Tag:       tag,
			Operation: &typedMessage{Type: removeUserOperationType, Value: operation},
		}
		if err := c.alterInbound(ctx, request); err != nil {
			return fmt.Errorf("xray: remove user from inbound %q: %w", tag, err)
		}
	}
	return nil
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
