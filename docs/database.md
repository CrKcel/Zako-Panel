# D1 数据模型

表结构以 `migrations/` 下的追加式 SQL 为准，本文件说明字段约束、索引取舍与保留策略。接口见 [api.md](api.md)，写入路径见 [traffic.md](traffic.md)。

## 1. 通用约定

- ID 使用不可预测的 ULID 文本；`xray_email` 使用 `u_<ULID>`，不含个人信息。
- 邮箱字段统一做 trim 与小写规范化后再比较和建立唯一索引。
- 时间统一为 Unix 秒 INTEGER；API 使用 Unix 秒，字段名以 `_at` 结尾；前端负责本地化显示。
- 流量字节使用非负 INTEGER；JSON 中超过 `2^53-1` 时使用十进制字符串。
- `NULL` 表示不限量或永不到期；不使用 `0` 表达无限。
- 所有外键显式声明；有历史流量的节点与用户采用停用，不做物理删除。
- 迁移只追加 SQL 文件；部署前在 staging 验证并备份。

## 2. 核心表

```sql
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

CREATE UNIQUE INDEX idx_nodes_name ON nodes(name);
CREATE UNIQUE INDEX idx_nodes_token ON nodes(agent_token_hash);
CREATE INDEX idx_nodes_enabled ON nodes(enabled);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
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

CREATE INDEX idx_endpoints_node_enabled ON endpoints(node_id, enabled);
```

`params_json` 按协议校验：P0 为 `vless-reality`，字段包含 `sni`、`public_key`、`short_id`、`fingerprint`、`flow`、`network`；不接受任意 YAML 片段。

```sql
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

CREATE UNIQUE INDEX idx_subscribers_email
  ON subscribers(email) WHERE email IS NOT NULL;
CREATE INDEX idx_subscribers_status ON subscribers(status);

CREATE TABLE node_clients (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE RESTRICT,
  xray_email TEXT NOT NULL,
  vless_uuid TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (node_id, xray_email),
  UNIQUE (node_id, vless_uuid),
  UNIQUE (subscriber_id, node_id)
);

CREATE INDEX idx_node_clients_subscriber
  ON node_clients(subscriber_id, enabled);
```

`node_clients` 同时表达节点授权与凭据。P1 的 `PUT /subscribers/{subscriberId}/nodes` 对新增节点创建行，对移除节点置 `enabled=0` 而不删除，保留流量归属。多 endpoint 复用同一 `node_client`；需要协议独立凭据时再增加 `endpoint_clients` 表，不在 P0 提前抽象。

```sql
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
  profile_id TEXT NOT NULL
    REFERENCES subscription_profiles(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, node_id)
) WITHOUT ROWID;

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL
    REFERENCES subscribers(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES subscription_profiles(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_subscriptions_subscriber
  ON subscriptions(subscriber_id, revoked_at);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_admin_users_email ON admin_users(email);
```

## 3. 流量表

```sql
CREATE TABLE traffic_reports (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  has_counter_gap INTEGER NOT NULL DEFAULT 0
    CHECK (has_counter_gap IN (0, 1)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, report_id)
) WITHOUT ROWID;

CREATE TABLE node_traffic_hourly (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
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
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  uplink_bytes INTEGER NOT NULL DEFAULT 0,
  downlink_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, node_id, bucket_start)
) WITHOUT ROWID;

CREATE TABLE subscriber_usage (
  subscriber_id TEXT PRIMARY KEY
    REFERENCES subscribers(id) ON DELETE RESTRICT,
  cycle_start INTEGER NOT NULL,
  uplink_bytes INTEGER NOT NULL DEFAULT 0,
  downlink_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

设计说明：

- `site_traffic_hourly` 维护全站小时汇总，避免给 `node_traffic_hourly` 增加 `(bucket_start)` 二级索引。每次报表多写 1 行，换取仪表盘 O(24) 读取与节点桶无索引写入。
- `user_traffic_hourly` 以订阅用户为前缀，用户详情与排行按用户读取；不建额外索引。
- `subscriber_usage` 只保留当前周期汇总，额度判断与 `subscription-userinfo` 读取 O(1)。

## 4. 配置与元数据

```sql
CREATE TABLE node_configs (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL,
  created_by TEXT REFERENCES admin_users(id),
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

CREATE INDEX idx_audit_created ON audit_events(created_at);
```

`meta` 保存 `users_ver`（全局用户集合版本）与少量运行时设置。`definition_json` 不含 REALITY 私钥与用户凭据；版本号在节点内严格递增，回滚创建新版本而非降低版本号。配置发布语义见 [config-delivery.md](config-delivery.md)。

## 5. 数据保留与清理

- 小时桶保留 90 天，`traffic_reports` 保留 30 天，审计事件保留 180 天。
- 清理按主键或时间范围每批 1,000 行执行，避免单语句长时间写入；删除同样计入 D1 写入。
- 节点与用户停用不删除历史流量；物理删除只用于无历史数据的对象。
- D1 Time Travel 与部署前备份是恢复手段；迁移前在 staging 验证。
