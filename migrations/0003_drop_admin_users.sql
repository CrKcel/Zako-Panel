CREATE TABLE node_configs_new (
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	definition_json TEXT NOT NULL,
	definition_sha256 TEXT NOT NULL,
	created_by TEXT,
	created_at INTEGER NOT NULL,
	applied_at INTEGER,
	last_error TEXT,
	PRIMARY KEY (node_id, version)
) WITHOUT ROWID;

INSERT INTO node_configs_new (node_id, version, definition_json, definition_sha256, created_by, created_at, applied_at, last_error)
SELECT node_id, version, definition_json, definition_sha256, created_by, created_at, applied_at, last_error
FROM node_configs;

DROP TABLE node_configs;
ALTER TABLE node_configs_new RENAME TO node_configs;

DROP TABLE admin_users;
