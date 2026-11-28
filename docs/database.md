# D1 数据库设计

控制面使用 Cloudflare D1（SQLite），表结构变更以 `migrations/` 目录下的递增 SQL 脚本为准。本篇说明表之间的关系，以及为什么把流量拆成几张表来存。

---

## 1. 通用约定

- **主键**：业务主键统一用 ULID 字符串；`subscribers.xray_email` 固定写成 `u_<ULID>`，不把真实邮箱写进 Xray 配置。
- **时间与数字**：所有时间字段存 Unix 秒整数（列名以 `_at` 结尾）；流量字节数存非负整数；配额和过期时间用 `NULL` 表示“无限制”。
- **软停用**：已有历史流量记录的节点和用户不做物理删除，避免历史账单和统计断层。
- **邮箱规范**：入库前统一转小写并去首尾空格。

---

## 2. 核心实体关系

```mermaid
erDiagram
    nodes ||--o{ endpoints : "1 对多接入端点"
    nodes ||--o{ node_configs : "配置版本历史"
    subscribers ||--|| subscriber_usage : "当月累计用量"
    subscribers ||--o{ subscriptions : "订阅链接"
    subscription_profiles ||--o{ subscriptions : "套用档案模板"
    subscription_profiles ||--o{ profile_nodes : "指定节点(可选)"
    nodes ||--o{ profile_nodes : "关联"
```

- **节点与注册**：`nodes` 存节点名称、Token 哈希、心跳周期、最后活跃时间、健康状态、版本号；`endpoints` 存公网地址、端口和协议参数（`params_json`）；全局可复用的注册令牌哈希（`enrollment_token_hash`）和轮换时间（`enrollment_token_rotated_at`）存在 `meta` 表中。
- **用户与凭据**：`subscribers` 存用户状态（`active` / `limited` / `expired` / `disabled`）、全局代理凭据（`xray_email`、`vless_uuid`，UUID 协议当 UUID、密码协议当密码）、停用移入回收站时间（`disabled_at`）、月度限额和到期时间；所有 `active` 用户统一下发到全部节点，取消或停用后保留行与历史统计关联。
- **订阅与档案**：`subscription_profiles` 存节点筛选策略（全量或指定列表）、`online_only` 开关、Clash 模板 JSON 与软删除时间（`deleted_at`）；`subscriptions` 存订阅 Token（`token TEXT NOT NULL UNIQUE`）和过期/撤销时间（`revoked_at`）。
- **配置与元数据**：`node_configs` 按 `(node_id, version)` 存不可变配置 JSON 与哈希，回滚时基于旧版本生成递增新版本；`meta` 存全局键值（如 `users_ver`、`default_subscriber_id`）；`audit_events` 记录关键管理操作。

---

## 3. 为什么把流量拆成 5 张表

为了同时满足**写入防重**、**图表快查**和**常数时间判超额**，流量数据按用途拆成了五张表：

| 表名 | 主键 / 粒度 | 干什么用的 |
| --- | --- | --- |
| `traffic_reports` | `(node_id, report_id)` | 存每次上报的凭证和载荷哈希，用来防重放和排查冲突 |
| `node_traffic_hourly` | `(node_id, bucket_start)` | 单节点每小时上下行总量，用于节点详情流量图 |
| `site_traffic_hourly` | `bucket_start` | 全站每小时总量，看全站趋势时只需扫这一张表，不用跨节点聚合 |
| `user_traffic_hourly` | `(subscriber_id, node_id, bucket_start)` | 每个用户在各节点的小时消耗，支撑用户明细与排行 |
| `subscriber_usage` | `subscriber_id` | 每个用户**当前自然月**的累计上下行总量，拉订阅和判超额时直接读这一行 |

---

## 4. 数据保留与自动清理

每天凌晨（Cron `17 3 * * *`）自动分批清理过期数据，单批最多删 **1,000 行**，避免长事务卡死或瞬间打满 D1 每日写入额度：

| 数据 | 保留时间 | 清理依据 |
| --- | --- | --- |
| 小时聚合桶（节点 / 全站 / 用户） | 90 天 | 按 `bucket_start` 清理 |
| 上报收据（`traffic_reports`） | 30 天 | 按 `received_at` 清理 |
| 审计日志（`audit_events`） | 180 天 | 按 `created_at` 清理 |
| 回收站（停用用户 / 撤销订阅 / 删除档案） | 30 天 | 分别按 `COALESCE(disabled_at, updated_at)`、`revoked_at`、`deleted_at` 物理清理 |
