# API 契约

所有接口以 `packages/contracts/openapi.yaml` 为准，TypeScript 类型由该文件生成；Go 端结构体手写，并用 `packages/contracts/fixtures` 做契约测试。管理接口鉴权见 [security.md](security.md)，流量与订阅的业务规则见 [traffic.md](traffic.md) 与 [subscription.md](subscription.md)。

## 1. 通用约定

成功响应：

```json
{
  "data": {},
  "meta": {
    "request_id": "01J..."
  }
}
```

错误响应：

```json
{
  "error": {
    "code": "NODE_NOT_FOUND",
    "message": "Node not found",
    "request_id": "01J..."
  }
}
```

- 列表使用 `limit + cursor`，默认 50，最大 200；不使用深分页 offset。
- 所有输入在路由边界校验；SQL 全部使用绑定参数。
- 管理 API 不开放跨域；前端同源请求。
- 请求 ID 使用 ULID，写入日志与响应头 `X-Request-Id`。
- 不在日志、错误堆栈或分析事件中记录 token、完整订阅 URL、UUID 或请求体。

## 2. 管理 API

| 方法与路径 | 阶段 | 用途 |
| --- | --- | --- |
| `GET/POST /api/v1/admin/nodes` | P0 | 节点列表、创建节点（可同时创建首个 endpoint） |
| `GET/PATCH /api/v1/admin/nodes/{nodeId}` | P0 | 节点详情、心跳间隔与启用状态 |
| `POST /api/v1/admin/nodes/{nodeId}/agent-token/rotate` | P0 | 轮换 Agent token，返回一次性明文 |
| `GET /api/v1/admin/nodes/{nodeId}/status` | P0 | 心跳、健康、版本与最近配置错误 |
| `GET /api/v1/admin/nodes/{nodeId}/clients` | P0 | 节点本地入站需要的 `xray_email` 与 UUID |
| `GET/POST /api/v1/admin/nodes/{nodeId}/endpoints` | P0/P2 | endpoint 列表与新增；P0 只有一个 |
| `PATCH/DELETE /api/v1/admin/nodes/{nodeId}/endpoints/{endpointId}` | P0/P2 | 修改或停用 endpoint |
| `GET/POST /api/v1/admin/profiles` | P0 | 订阅档案列表与创建 |
| `GET/PATCH/DELETE /api/v1/admin/profiles/{profileId}` | P0 | 节点选择、Clash 基础字段、代理组与规则 |
| `GET /api/v1/admin/profiles/{profileId}/preview` | P0 | 渲染该档案当前会下发的 Clash 文档 |
| `GET/POST /api/v1/admin/subscriptions` | P0 | 订阅列表与创建，创建时返回一次性 token |
| `POST /api/v1/admin/subscriptions/{subscriptionId}/rotate` | P0 | 生成新 token 并撤销旧 token |
| `POST /api/v1/admin/subscriptions/{subscriptionId}/revoke` | P0 | 撤销订阅 |
| `GET /api/v1/admin/traffic/summary` | P0 | 按时间、节点或用户聚合流量 |
| `GET/POST /api/v1/admin/subscribers` | P1 | 用户、额度、周期与到期管理 |
| `GET/PATCH /api/v1/admin/subscribers/{subscriberId}` | P1 | 用户详情与状态 |
| `PUT /api/v1/admin/subscribers/{subscriberId}/nodes` | P1 | 整体替换节点授权，创建或停用 `node_clients` |
| `GET/POST /api/v1/admin/admins` | P1 | 管理员列表与新增 |
| `PATCH /api/v1/admin/admins/{adminId}` | P1 | 修改管理员角色与启用状态 |
| `GET/POST /api/v1/admin/nodes/{nodeId}/configs` | P2 | 创建并发布配置版本、查看历史 |
| `GET /api/v1/admin/nodes/{nodeId}/configs/{version}` | P2 | 配置详情与 diff 数据 |
| `POST /api/v1/admin/nodes/{nodeId}/configs/{version}/rollback` | P2 | 从历史定义创建新版本 |

标为 P1 与 P2 的管理接口已注册路由并通过入参校验，但服务层尚未实现，返回 `501 NOT_IMPLEMENTED`。P0 验收不依赖这些接口。

流量汇总支持 `from`、`to`、`groupBy=node|subscriber|site`、`nodeId`、`subscriberId`；最大时间范围 31 天。`from`、`to` 为 Unix 秒，归一到小时边界。

创建节点时，节点与首个 endpoint 在同一 D1 batch 写入，并为当前默认订阅用户创建 `node_clients`。P1 的 `PUT /subscribers/{subscriberId}/nodes` 为新增授权补齐凭据。

`GET /api/v1/admin/nodes/{nodeId}/clients` 返回该节点的 `node_clients` 记录，用于在 P0 手工配置节点本地入站。`xray_email` 必须与该入站 client 的 `email` 一致，否则统计无法归属到订阅用户。

### 2.1 档案预览

`GET /api/v1/admin/profiles/{profileId}/preview` 返回该档案针对某个订阅用户会渲染出的 Clash 文档，用于在创建订阅前确认节点选择、代理组与规则。查询参数 `subscriberId` 省略时使用 `meta.default_subscriber_id`。

```json
{
  "data": {
    "document": "mixed-port: 7890\nproxies:\n  - name: Tokyo-01\n...",
    "proxies": [{ "name": "Tokyo-01", "node_id": "01J..." }],
    "skipped": [{ "node_id": "01J...", "node_name": "Osaka-01", "reason": "offline" }],
    "subscriber": { "id": "01J...", "name": "默认用户", "blocked_reason": null }
  }
}
```

- `document` 与订阅响应走同一套渲染与筛选逻辑，代理 UUID 替换为占位值；预览不暴露凭据。
- `skipped` 说明节点被排除的原因，取 `disabled`、`offline`、`unhealthy`、`not_selected`、`no_endpoint`。
- `subscriber.blocked_reason` 取 `inactive`、`expired`、`over_quota` 或 `null`，与订阅接口返回 `403` 的条件一致。
- 没有可分发节点时返回空 `proxies`，不返回 `503`；`503` 只属于真正下发订阅的路径。

## 3. Agent API

Agent 请求使用 `Authorization: Bearer <node_id>.<secret>`。请求体上限与报表切分规则见 [traffic.md](traffic.md)。

### 3.1 上报

`POST /api/v1/agent/report`

```json
{
  "sent_at": 1780000000,
  "agent_version": "0.1.0",
  "xray_version": "25.10.1",
  "xray_healthy": true,
  "stats_healthy": true,
  "applied_config_version": 3,
  "users_ver": 12,
  "sys": {
    "cpu": 0.12,
    "mem": 0.41,
    "load": 0.30,
    "uptime": 86400
  },
  "traffic": {
    "report_id": "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
    "period_start": 1780000000,
    "period_end": 1780000900,
    "has_counter_gap": false,
    "node": {
      "uplink_bytes": 10240,
      "downlink_bytes": 204800
    },
    "users": [
      {
        "xray_email": "u_01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
        "uplink_bytes": 10240,
        "downlink_bytes": 204800
      }
    ]
  }
}
```

响应：

```json
{
  "data": {
    "ack_report_id": "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
    "server_time": 1780000002,
    "heartbeat_interval_seconds": 300,
    "traffic_interval_seconds": 900,
    "users_ver": 13,
    "desired_config_version": 3,
    "unknown_users": 0,
    "directives": []
  }
}
```

规则：

- 心跳与流量共用一个端点；纯心跳请求省略 `traffic`，`ack_report_id` 为 `null`。
- 单份报表最多 40 个用户条目、64 KB；超出返回 `413`，Agent 切分后重试。
- `period_end > period_start`，跨度不超过 3600 秒；`period_start` 与 `period_end - 1` 必须位于同一小时桶，跨桶返回 `422`，由 Agent 在采样侧切分。
- `period_end` 允许最多 5 分钟未来偏移；超过 7 天的报表返回 `422`。
- 同一报表内的 `xray_email` 必须唯一；重复条目由 Agent 聚合，Worker 收到重复条目返回 `422`。
- `payload_hash` 为 `traffic` 对象规范化 JSON（键排序）的 SHA-256；同一 `report_id` 重复提交且 hash 相同按成功返回，hash 不同返回 `409 REPORT_CONFLICT`。
- Agent 收到 `409` 丢弃该报表并告警，不阻塞后续队列。
- 未知 `xray_email` 仍计入节点与站点流量，跳过用户汇总，响应包含 `unknown_users` 计数。
- 心跳字段先于流量批次提交；流量批次失败不会让节点被判离线。
- Agent 以响应中的 `heartbeat_interval_seconds` 与 `traffic_interval_seconds` 为准，持久化后在下一次调度生效。
- `sys` 为可选字段，限制 2 KB；P1 UI 使用，P0 可忽略。
- `directives` 保留给未来扩展，当前返回空数组；旧 Agent 忽略未知类型。

### 3.2 用户列表

`GET /api/v1/agent/users`

```json
{
  "data": {
    "version": 13,
    "users": [
      {
        "xray_email": "u_01J...",
        "vless_uuid": "00000000-0000-0000-0000-000000000000"
      }
    ]
  }
}
```

- 只返回该节点上启用且订阅用户状态为 `active` 的凭据。
- 支持 `If-None-Match`；版本未变化返回 `304`。

### 3.3 配置

- `GET /api/v1/agent/config`：返回当前 `desired_config_version` 的定义、SHA-256 与版本；Agent 版本已是最新时返回 `204`。
- `POST /api/v1/agent/config/result`：

```json
{
  "version": 4,
  "status": "applied",
  "applied_at": 1780000000,
  "error": null
}
```

- `status` 取 `applied` / `failed`；错误包含 `code` 与 `message`，不包含私钥或完整配置。
- 迟到的旧版本结果不能覆盖更新版本状态。

发布与应用流程见 [config-delivery.md](config-delivery.md)。

## 4. 订阅 API

- `GET /sub/{token}/clash.yaml`
- `GET /sub/{token}/uri?encoding=base64`
- `GET /sub/{token}/uri?encoding=plain`

状态码：

| 状态码 | 条件 |
| --- | --- |
| `401` | token 不存在或已撤销 |
| `403` | 订阅用户停用、到期、超额，或订阅本身到期 |
| `503` | 身份有效，但当前没有可分发节点 |
| `400` | 不支持的编码或格式 |
| `404` | 未知路径 |

订阅 token 明文只在创建或轮换响应中出现一次；管理和 Agent API 不返回明文。生成逻辑见 [subscription.md](subscription.md)。
