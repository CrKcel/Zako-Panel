# API 契约与接口规范

系统 API 以 `packages/contracts/openapi.yaml` 作为契约定义源，TypeScript 类型由代码生成工具同步更新；Go 端结构体在 `apps/agent` 中定义，并通过跨语言测试用例保障兼容性。认证授权设计详见 [security.md](security.md)，业务处理规则详见 [traffic.md](traffic.md) 与 [subscription.md](subscription.md)。

Agent 安装包与二进制下载端点由独立 Downloads Worker 托管，不属于控制面 OpenAPI 契约，分发细节详见 [deployment.md](deployment.md)。

## 1. 通用设计规范

### 1.1 统一响应封装

成功响应结构：

```json
{
  "data": {},
  "meta": {
    "request_id": "01J..."
  }
}
```

错误响应结构：

```json
{
  "error": {
    "code": "NODE_NOT_FOUND",
    "message": "Node not found",
    "request_id": "01J..."
  }
}
```

### 1.2 交互准则

- 列表接口使用基于游标的分页机制（`limit` 默认 50，上限 200，配合 `cursor`）。
- 控制面接口入参均在路由层完成 Schema 严格校验，后端 SQL 严格使用参数化绑定。
- 管理 API 仅接受同源请求，依靠 Cloudflare Access 凭证鉴权。
- 全链路日志与响应头均注入基于 ULID 的 `X-Request-Id` 以供链路追踪。
- 敏感凭证（明文 Token、节点私钥、UUID 及完整请求体）禁止在持久化日志中留存。

## 2. 管理 API

管理路由前缀为 `/api/v1/admin`，由 Cloudflare Access 保护并结合数据库角色执行权限校验。

| 请求方法与路径 | 说明 | 权限要求 |
| --- | --- | --- |
| `GET /api/v1/admin/nodes` | 获取节点列表，支持游标分页 | viewer |
| `POST /api/v1/admin/nodes` | 创建节点，支持级联初始化首个 endpoint | admin |
| `GET /api/v1/admin/nodes/{nodeId}` | 获取指定节点详情与状态 | viewer |
| `PATCH /api/v1/admin/nodes/{nodeId}` | 更新节点名称、状态或心跳周期 | admin |
| `POST /api/v1/admin/nodes/{nodeId}/agent-token/rotate` | 轮换 Agent 认证 Token，返回一次性明文 | admin |
| `GET /api/v1/admin/node-enrollment-tokens` | 获取一次性节点注册 Token 列表 | viewer |
| `POST /api/v1/admin/node-enrollment-tokens` | 创建一次性节点注册 Token（默认 24 小时有效） | admin |
| `DELETE /api/v1/admin/node-enrollment-tokens/{tokenId}` | 作废未使用的一次性注册 Token | admin |
| `GET /api/v1/admin/nodes/{nodeId}/status` | 查询节点派生状态、健康状态与版本指标 | viewer |
| `GET /api/v1/admin/nodes/{nodeId}/clients` | 查询节点同步凭据列表（用于对齐验证） | viewer |
| `GET /api/v1/admin/nodes/{nodeId}/endpoints` | 获取节点 endpoint 列表 | viewer |
| `POST /api/v1/admin/nodes/{nodeId}/endpoints` | 为节点添加 endpoint | admin |
| `PATCH /api/v1/admin/nodes/{nodeId}/endpoints/{endpointId}` | 更新指定 endpoint 状态与连接参数 | admin |
| `DELETE /api/v1/admin/nodes/{nodeId}/endpoints/{endpointId}` | 停用或移除 endpoint | admin |
| `GET /api/v1/admin/profiles` | 获取订阅档案列表 | viewer |
| `POST /api/v1/admin/profiles` | 创建订阅档案（配置代理组、规则及筛选策略） | admin |
| `GET /api/v1/admin/profiles/{profileId}` | 获取订阅档案详情 | viewer |
| `PATCH /api/v1/admin/profiles/{profileId}` | 修改订阅档案规则或基础设置 | admin |
| `DELETE /api/v1/admin/profiles/{profileId}` | 移除订阅档案 | admin |
| `GET /api/v1/admin/profiles/{profileId}/preview` | 预览 Clash 文档渲染结果及节点筛选跳过原因 | viewer |
| `GET /api/v1/admin/subscriptions` | 获取订阅凭证列表 | viewer |
| `POST /api/v1/admin/subscriptions` | 创建订阅凭证，返回一次性明文 Token | admin |
| `POST /api/v1/admin/subscriptions/{subscriptionId}/rotate` | 轮换订阅 Token 并立即使旧凭据失效 | admin |
| `POST /api/v1/admin/subscriptions/{subscriptionId}/revoke` | 撤销订阅凭据 | admin |
| `GET /api/v1/admin/traffic/summary` | 聚合流量报表（支持站点、节点、用户维度） | viewer |
| `GET /api/v1/admin/subscribers` | 获取订阅用户列表及用量汇总 | viewer |
| `POST /api/v1/admin/subscribers` | 创建订阅用户并设定流量周期与到期时间 | admin |
| `GET /api/v1/admin/subscribers/{subscriberId}` | 获取订阅用户详细属性与周期用量 | viewer |
| `PATCH /api/v1/admin/subscribers/{subscriberId}` | 更新用户配额、到期时间或手动启停 | admin |
| `PUT /api/v1/admin/subscribers/{subscriberId}/nodes` | 全量更新用户的节点授权集合，管理入站凭据 | admin |
| `GET /api/v1/admin/nodes/{nodeId}/configs` | 获取节点历史配置版本列表 | viewer |
| `POST /api/v1/admin/nodes/{nodeId}/configs` | 创建并下发新的配置版本 | admin |
| `GET /api/v1/admin/nodes/{nodeId}/configs/{version}` | 查看配置版本详情及 diff 内容 | viewer |
| `POST /api/v1/admin/nodes/{nodeId}/configs/{version}/rollback` | 基于历史版本创建新版本进行回滚 | admin |

### 2.1 流量汇总与约束

- 聚合统计支持参数：`from`、`to`（Unix 秒，对齐小时桶）、`groupBy`（`site`、`node`、`subscriber`）以及关联过滤 ID。
- 查询跨度最大支持 31 天，必须显式携带时间区间以避免全表扫描。
- 用户状态变更接口（`PATCH /subscribers/{id}`）仅允许更新为 `active` 或 `disabled`；`limited` 与 `expired` 由系统自动计算派生。
- 管理员角色管理接口对最后一名活跃 `owner` 实施保护，尝试停用或降级时返回 `409`。

### 2.2 档案预览机制

`GET /api/v1/admin/profiles/{profileId}/preview` 端点复用正式订阅分发逻辑：
- 响应数据包含组装好的完整配置文档、命中包含的代理节点列表、被跳过的节点及其判定原因（如 `offline`、`unhealthy`、`disabled`、`not_selected`）。
- 预览文档中的敏感凭据替换为占位符。
- 无可用节点时返回包含空列表的数据，不抛出 `503` 异常。

## 3. Agent 通信 API

节点端 Agent 常规请求携带 `Authorization: Bearer <node_id>.<secret>` 标头；首次自动化初始化注册请求携带一次性注册 Token（`Authorization: Bearer <token_id>.<secret>`）。

### 3.0 节点自动注册

`POST /api/v1/agent/enroll`

节点端通过 `zako-agent init` 使用面板生成的一次性注册 Token 完成鉴权并自动创建节点与首个 `vless-reality` endpoint：

- 请求包含节点名称（`name`）、公网地址（`host`）、本地生成的 REALITY 公钥（`reality_public_key`）与 `reality_short_id`，以及可选端口与 SNI 覆盖项。
- 控制面校验一次性 Token 的有效性与哈希，原子标记为已使用后创建节点与默认订阅者凭据，返回 `node_id`、永久 `agent_token` 及最终生效的 endpoint 参数。

### 3.1 状态与流量上报

`POST /api/v1/agent/report`

上报载荷包含两部分内容：
1. 节点指标与心跳：上报时间、Agent 版本、Xray 版本、健康探针状态、已生效配置版本号（`applied_config_version`）、当前已应用凭据版本号（`users_ver`）以及可选的系统负载数据（CPU、内存、载荷与正常运行时间）。
2. 流量结算（可选）：单次上报可携带由 `report_id`、时间区间（`period_start` 与 `period_end`）、节点总量增量与用户维度增量构成的结算数据。

响应载荷包含处理确认与控制指令：
- `ack_report_id`：成功入账的报表 ID。
- `server_time`：服务端统一时钟戳。
- `heartbeat_interval_seconds` 与 `traffic_interval_seconds`：下发推荐的调度周期。
- `users_ver`：全局凭据版本号，用于通知 Agent 拉取最新用户名单。
- `desired_config_version`：目标配置版本号。
- `unknown_users`：未能匹配到有效订阅用户的记录数。

上报规范与边界处理：
- 心跳更新与流量结算解耦：即使流量数据遇到冲突，心跳状态依然正常落盘。
- 单个报表最大承载 40 个用户条目，载荷上限 64 KB。
- 结算区间跨度限制在 3600 秒内，且起止时间点必须归属于同一小时自然桶。
- 幂等性保障：以报表内容规范化 JSON 的 SHA-256 哈希值作为校验依据；同一 `report_id` 再次上报相同载荷直接返回确认，载荷不同则返回 `409 REPORT_CONFLICT`。

### 3.2 节点凭据拉取

`GET /api/v1/agent/users`

- 返回目标节点处于启用状态且订阅有效的所有客户端凭证列表（`xray_email` 与 `vless_uuid`）。
- 响应头包含代表凭据集合版本的 `ETag`。
- 支持 `If-None-Match` 条件请求：当本地凭据版本与远端匹配时，服务端直接响应 `304 Not Modified`，避免冗余数据传输与磁盘写入。

### 3.3 配置拉取与结果反馈

- `GET /api/v1/agent/config`：用于 Agent 获取期望版本的不可变配置定义（规范化 JSON 与 SHA-256 哈希）。当 Agent 已处于目标版本时响应 `204 No Content`。
- `POST /api/v1/agent/config/result`：Agent 在完成配置校验、原子替换与重启验证后，向控制面上报最终生效版本号、状态（`applied` 或 `failed`）以及结构化错误信息。

## 4. 订阅 API

订阅端点路径直接暴露于根路径下，由专用随机 Token 访问，不依赖管理面板会话。

- `GET /sub/{token}/clash.yaml`：生成适用于 Clash.Meta 的配置文档。
- `GET /sub/{token}/uri?encoding=base64`：生成经 Base64 编码的通用代理链接文本。
- `GET /sub/{token}/uri?encoding=plain`：生成明文换行分隔的通用代理链接。

状态码响应规范：

| 状态码 | 业务原因 |
| --- | --- |
| `200` | 正常响应订阅文档，附带 `subscription-userinfo` 头反映用量 |
| `401` | Token 不存在或已撤销 |
| `403` | 订阅已到期、所属用户被停用或本周期用量已达上限 |
| `503` | 用户凭证有效，但当前无符合分发条件的可用节点 |
| `400` | 请求了不支持的编码格式或参数异常 |
| `404` | 请求端点不存在 |
