-- Redesign subscriptions to store the subscription token directly as NOT NULL UNIQUE
-- instead of token_hash, dropping legacy subscription rows that lacked a stored token.
DROP TABLE IF EXISTS subscriptions;

CREATE TABLE subscriptions (
	id TEXT PRIMARY KEY,
	subscriber_id TEXT NOT NULL REFERENCES subscribers (id) ON DELETE RESTRICT,
	profile_id TEXT NOT NULL REFERENCES subscription_profiles (id),
	name TEXT NOT NULL,
	token TEXT NOT NULL UNIQUE,
	revoked_at INTEGER,
	expires_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE INDEX idx_subscriptions_subscriber ON subscriptions (subscriber_id, revoked_at);
CREATE INDEX idx_subscriptions_revoked_at ON subscriptions (revoked_at) WHERE revoked_at IS NOT NULL;
