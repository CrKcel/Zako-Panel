-- Core node model. Node status is derived from last_seen_at at read time.
CREATE TABLE nodes (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	agent_token_hash TEXT NOT NULL,
	heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300
		CHECK (heartbeat_interval_seconds BETWEEN 60 AND 900),
	last_seen_at INTEGER,
	xray_healthy INTEGER CHECK (xray_healthy IN (0, 1)),
	stats_healthy INTEGER CHECK (stats_healthy IN (0, 1)),
	agent_version TEXT,
	xray_version TEXT,
	sys_json TEXT,
	desired_config_version INTEGER NOT NULL DEFAULT 0,
	applied_config_version INTEGER NOT NULL DEFAULT 0,
	last_config_error TEXT,
	last_config_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_nodes_name ON nodes (name);
CREATE UNIQUE INDEX idx_nodes_token ON nodes (agent_token_hash);
CREATE INDEX idx_nodes_enabled ON nodes (enabled);

CREATE TABLE endpoints (
	id TEXT PRIMARY KEY,
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	protocol TEXT NOT NULL,
	host TEXT NOT NULL,
	port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
	params_json TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (node_id, name)
);

CREATE INDEX idx_endpoints_node_enabled ON endpoints (node_id, enabled);

CREATE TABLE subscribers (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT,
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'limited', 'expired', 'disabled')),
	traffic_limit_bytes INTEGER
		CHECK (traffic_limit_bytes IS NULL OR traffic_limit_bytes >= 0),
	expires_at INTEGER,
	usage_cycle_start INTEGER NOT NULL,
	usage_cycle_end INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_subscribers_email ON subscribers (email) WHERE email IS NOT NULL;
CREATE INDEX idx_subscribers_status ON subscribers (status);

-- Carries both node grants and per-node credentials. Disabling keeps history.
CREATE TABLE node_clients (
	id TEXT PRIMARY KEY,
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	subscriber_id TEXT NOT NULL REFERENCES subscribers (id) ON DELETE RESTRICT,
	xray_email TEXT NOT NULL,
	vless_uuid TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (node_id, xray_email),
	UNIQUE (node_id, vless_uuid),
	UNIQUE (subscriber_id, node_id)
);

CREATE INDEX idx_node_clients_subscriber ON node_clients (subscriber_id, enabled);

CREATE TABLE subscription_profiles (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	description TEXT,
	node_selection TEXT NOT NULL DEFAULT 'all'
		CHECK (node_selection IN ('all', 'selected')),
	online_only INTEGER NOT NULL DEFAULT 1 CHECK (online_only IN (0, 1)),
	clash_base_json TEXT NOT NULL DEFAULT '{}',
	proxy_groups_json TEXT NOT NULL DEFAULT '[]',
	rules_json TEXT NOT NULL DEFAULT '[]',
	revision INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE profile_nodes (
	profile_id TEXT NOT NULL REFERENCES subscription_profiles (id) ON DELETE CASCADE,
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	PRIMARY KEY (profile_id, node_id)
) WITHOUT ROWID;

CREATE TABLE subscriptions (
	id TEXT PRIMARY KEY,
	subscriber_id TEXT NOT NULL REFERENCES subscribers (id) ON DELETE RESTRICT,
	profile_id TEXT NOT NULL REFERENCES subscription_profiles (id),
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	revoked_at INTEGER,
	expires_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE INDEX idx_subscriptions_subscriber ON subscriptions (subscriber_id, revoked_at);

CREATE TABLE admin_users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_admin_users_email ON admin_users (email);

-- Report ids enforce idempotency together with payload_hash.
CREATE TABLE traffic_reports (
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	report_id TEXT NOT NULL,
	payload_hash TEXT NOT NULL,
	period_start INTEGER NOT NULL,
	period_end INTEGER NOT NULL,
	item_count INTEGER NOT NULL,
	has_counter_gap INTEGER NOT NULL DEFAULT 0 CHECK (has_counter_gap IN (0, 1)),
	received_at INTEGER NOT NULL,
	PRIMARY KEY (node_id, report_id)
) WITHOUT ROWID;

-- Writes are upserts of one row per report; reads scan the primary key range.
CREATE TABLE node_traffic_hourly (
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	bucket_start INTEGER NOT NULL,
	uplink_bytes INTEGER NOT NULL DEFAULT 0,
	downlink_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (node_id, bucket_start)
) WITHOUT ROWID;

CREATE TABLE site_traffic_hourly (
	bucket_start INTEGER PRIMARY KEY,
	uplink_bytes INTEGER NOT NULL DEFAULT 0,
	downlink_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE user_traffic_hourly (
	subscriber_id TEXT NOT NULL REFERENCES subscribers (id) ON DELETE RESTRICT,
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	bucket_start INTEGER NOT NULL,
	uplink_bytes INTEGER NOT NULL DEFAULT 0,
	downlink_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (subscriber_id, node_id, bucket_start)
) WITHOUT ROWID;

CREATE TABLE subscriber_usage (
	subscriber_id TEXT PRIMARY KEY REFERENCES subscribers (id) ON DELETE RESTRICT,
	cycle_start INTEGER NOT NULL,
	uplink_bytes INTEGER NOT NULL DEFAULT 0,
	downlink_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE node_configs (
	node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	definition_json TEXT NOT NULL,
	definition_sha256 TEXT NOT NULL,
	created_by TEXT REFERENCES admin_users (id),
	created_at INTEGER NOT NULL,
	applied_at INTEGER,
	last_error TEXT,
	PRIMARY KEY (node_id, version)
) WITHOUT ROWID;

CREATE TABLE meta (
	k TEXT PRIMARY KEY,
	v TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE audit_events (
	id TEXT PRIMARY KEY,
	actor_email TEXT,
	action TEXT NOT NULL,
	target_type TEXT,
	target_id TEXT,
	detail_json TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_created ON audit_events (created_at);
