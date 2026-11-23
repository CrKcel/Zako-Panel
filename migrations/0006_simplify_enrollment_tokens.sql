-- Deployment no longer asks the panel for protocol parameters: the node reports
-- the endpoints it already serves during enrollment. SQLite cannot drop the
-- columns in place because default_port is referenced by a CHECK constraint, so
-- the table is rebuilt with the same identity and expiry columns.
CREATE TABLE node_enrollment_tokens_new (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	name_prefix TEXT,
	heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300
		CHECK (heartbeat_interval_seconds BETWEEN 60 AND 900),
	created_by TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	used_node_id TEXT REFERENCES nodes (id) ON DELETE SET NULL,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);

INSERT INTO node_enrollment_tokens_new
	(id, token_hash, name_prefix, heartbeat_interval_seconds, created_by,
	 expires_at, used_at, used_node_id, revoked_at, created_at)
SELECT id, token_hash, name_prefix, heartbeat_interval_seconds, created_by,
	expires_at, used_at, used_node_id, revoked_at, created_at
FROM node_enrollment_tokens;

DROP TABLE node_enrollment_tokens;

ALTER TABLE node_enrollment_tokens_new RENAME TO node_enrollment_tokens;

CREATE INDEX idx_enrollment_tokens_expires ON node_enrollment_tokens (expires_at);
CREATE INDEX idx_enrollment_tokens_created ON node_enrollment_tokens (created_at DESC);
