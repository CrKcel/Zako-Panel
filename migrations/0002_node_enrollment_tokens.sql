-- One-time node enrollment tokens for automated node registration.
CREATE TABLE node_enrollment_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	name_prefix TEXT,
	default_sni TEXT NOT NULL DEFAULT 'www.microsoft.com',
	default_port INTEGER NOT NULL DEFAULT 443 CHECK (default_port BETWEEN 1 AND 65535),
	default_fingerprint TEXT NOT NULL DEFAULT 'chrome',
	heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300
		CHECK (heartbeat_interval_seconds BETWEEN 60 AND 900),
	created_by TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	used_node_id TEXT REFERENCES nodes (id) ON DELETE SET NULL,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE INDEX idx_enrollment_tokens_expires ON node_enrollment_tokens (expires_at);
CREATE INDEX idx_enrollment_tokens_created ON node_enrollment_tokens (created_at DESC);
