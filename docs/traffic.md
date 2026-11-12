# 流量采集与入账

平台按小时桶记录节点、站点与订阅用户流量，额度判断读取当前周期汇总。上报接口与字段校验见 [api.md](api.md)，表结构与保留期见 [database.md](database.md)，Agent 进程模型见 [agent.md](agent.md)。

## 1. Xray 统计配置

Xray 配置必须包含 stats、policy、API inbound 与 routing：

```json
{
  "stats": {},
  "policy": {
    "levels": {
      "0": {
        "statsUserUplink": true,
        "statsUserDownlink": true
      }
    },
    "system": {
      "statsInboundUplink": true,
      "statsInboundDownlink": true
    }
  },
  "api": {
    "tag": "api",
    "services": ["StatsService", "HandlerService"]
  },
  "inbounds": [
    {
      "tag": "api",
      "listen": "127.0.0.1",
      "port": 10085,
      "protocol": "dokodemo-door",
      "settings": { "address": "127.0.0.1" }
    }
  ],
  "routing": {
    "rules": [
      { "type": "field", "inboundTag": ["api"], "outboundTag": "api" }
    ]
  }
}
```

- 每个需要统计的用户设置稳定且唯一的 `email`，对应 `node_clients.xray_email`。
- 统计键：`user>>>EMAIL>>>traffic>>>uplink|downlink`、`inbound>>>TAG>>>traffic>>>uplink|downlink`。
- 节点流量只汇总代理 inbound tag，排除 `api` inbound，避免把本地 API 流量计入用户流量。
- Agent 使用 `QueryStats(pattern="user>>>", reset=false)`、inbound 查询与 `GetSysStats`；不使用 `reset=true`。

## 2. Agent 采样与增量

```text
每 30 秒读取原始计数器：
  首次看到计数器：只建立基线，不回填未知历史
  当前值 >= 基线：delta = 当前值 - 基线
  当前值 < 基线或 Xray uptime 回退：delta = 当前值，标记 counter gap
  缺失计数器：记录异常，不产生负 delta

在同一 BoltDB 事务中：
  保存 delta 到当前未结算报表
  更新原始计数基线与 Xray uptime

每 15 分钟（默认，Worker 下发）：
  按小时边界和 40 个用户条目上限切分非零 delta
  为每份报表生成持久 report_id 并关闭批次
  发送最早未 ACK 报表
  只有收到报告级 ACK 才删除 outbox
```

- 报表 `period_start`/`period_end` 必须落在同一小时桶；跨边界时按采样时间切分，无法精确归属的尾部计入下一小时并标记 `has_counter_gap`。
- Agent 重启后从 BoltDB 恢复基线、outbox、`users_ver` 与配置版本。
- 网络失败采用指数退避与 jitter；Worker 返回 `429` 时遵守 `Retry-After` 或加大退避。
- Agent 使用心跳返回的 `server_time` 检测明显时钟偏移，节点仍应通过 timesyncd/NTP 校时。
- outbox 中超过 7 天的报表丢弃并记录告警，避免与 Worker 报表 ID 保留期冲突。

## 3. Worker 幂等入账

单次上报按以下顺序处理：

1. 验证 Agent token 与请求体。
2. `batch` 提交心跳更新，并读取该节点用户映射与订阅周期：

```sql
UPDATE nodes
SET last_seen_at = ?, xray_healthy = ?, stats_healthy = ?,
    agent_version = ?, xray_version = ?, sys_json = ?,
    applied_config_version = ?, updated_at = ?
WHERE id = ?;

SELECT subscriber_id, xray_email
FROM node_clients
WHERE node_id = ? AND xray_email IN (/* ≤ 40 个绑定参数 */);

SELECT id, usage_cycle_start, status, traffic_limit_bytes, expires_at
FROM subscribers
WHERE id IN (/* 去重后的订阅用户 */);
```

3. 将 `traffic.users` 中的 `xray_email` 映射为 `subscriber_id`；未知邮箱只计入节点与站点桶。
4. `batch` 提交流量，顺序固定：

```sql
INSERT INTO traffic_reports
  (node_id, report_id, payload_hash, period_start, period_end,
   item_count, has_counter_gap, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

INSERT INTO node_traffic_hourly
  (node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(node_id, bucket_start) DO UPDATE SET
  uplink_bytes = node_traffic_hourly.uplink_bytes + excluded.uplink_bytes,
  downlink_bytes = node_traffic_hourly.downlink_bytes + excluded.downlink_bytes,
  updated_at = excluded.updated_at;

INSERT INTO site_traffic_hourly
  (bucket_start, uplink_bytes, downlink_bytes, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(bucket_start) DO UPDATE SET
  uplink_bytes = site_traffic_hourly.uplink_bytes + excluded.uplink_bytes,
  downlink_bytes = site_traffic_hourly.downlink_bytes + excluded.downlink_bytes,
  updated_at = excluded.updated_at;

-- 每 16 行一条语句，6 个绑定参数/行，避免超过 100 参数限制
INSERT INTO user_traffic_hourly
  (subscriber_id, node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at)
VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?) /* ... */
ON CONFLICT(subscriber_id, node_id, bucket_start) DO UPDATE SET
  uplink_bytes = user_traffic_hourly.uplink_bytes + excluded.uplink_bytes,
  downlink_bytes = user_traffic_hourly.downlink_bytes + excluded.downlink_bytes,
  updated_at = excluded.updated_at;

-- 每 20 行一条语句，5 个绑定参数/行
INSERT INTO subscriber_usage
  (subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at)
VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?) /* ... */
ON CONFLICT(subscriber_id) DO UPDATE SET
  uplink_bytes = CASE
    WHEN subscriber_usage.cycle_start = excluded.cycle_start
    THEN subscriber_usage.uplink_bytes + excluded.uplink_bytes
    ELSE excluded.uplink_bytes END,
  downlink_bytes = CASE
    WHEN subscriber_usage.cycle_start = excluded.cycle_start
    THEN subscriber_usage.downlink_bytes + excluded.downlink_bytes
    ELSE excluded.downlink_bytes END,
  cycle_start = excluded.cycle_start,
  updated_at = excluded.updated_at;
```

5. 若 `traffic_reports` 插入触发唯一约束，整个流量 batch 回滚；Worker 查询该 `report_id` 的 `payload_hash`：相同则按成功返回 ACK，不同则返回 `409`。心跳批次已提交，节点状态不受影响。
6. `subscriber_usage.cycle_start` 使用订阅用户当前的 `usage_cycle_start`；周期已滚动时，CASE 分支重置累计值。
7. 心跳中的 `applied_config_version` 只接受不大于 `desired_config_version` 的值。

报表切分后每份报表独立 `report_id`、独立 batch；单份失败不影响其他报表。D1 batch 是原子事务，任一语句失败会回滚整个 batch。

## 4. 额度与周期

- `subscribers.usage_cycle_start` / `usage_cycle_end` 定义当前周期；默认创建时设为当月至下月同日，月末按目标月最后一天截断；周期边界按 UTC 计算。
- 每 15 分钟 Cron 检查：`now >= usage_cycle_end` 时推进周期、重置 `subscriber_usage` 并更新订阅用户。
- 周期内状态按以下优先级派生并物化到 `subscribers.status`：`disabled`（管理员停用）优先，其次 `expired`（`expires_at <= now`），其次 `limited`（有限额且 `usage >= limit`），否则 `active`。
- 状态变化时递增 `meta.users_ver`，触发 Agent 拉取用户列表。
- 管理员修改额度、到期、状态或节点授权时，在同一 D1 batch 中更新订阅用户并递增 `users_ver`。
- 订阅请求实时校验状态、额度与到期，不依赖 Cron 的物化结果。
- 从节点移除用户后，已建立的连接不会被主动中断；新连接与后续配置刷新才生效。
