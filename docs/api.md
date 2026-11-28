# API 规范与交互约定

所有接口的详细路径、请求体和响应字段以 **`packages/contracts/openapi.yaml`** 为准（TypeScript 类型由此生成，Go 端结构体通过跨语言测试对齐）。本篇只说明通用的交互约定和关键行为边界。

认证边界见 [security.md](security.md)，流量入账规则见 [traffic.md](traffic.md)，订阅生成逻辑见 [subscription.md](subscription.md)。

---

## 1. 统一响应与分页

### 响应信封

成功响应统一包在 `data` 里，错误响应统一包在 `error` 里，两者都带链路追踪用的 `request_id`（ULID，同时也会写在响应头 `X-Request-Id` 中）：

```json
// 成功
{ "data": {}, "meta": { "request_id": "01J..." } }

// 失败
{ "error": { "code": "NODE_NOT_FOUND", "message": "Node not found", "request_id": "01J..." } }
```

### 通用约定

- **游标分页**：列表接口使用 `cursor` + `limit`（默认 `50`，最大 `200`）。
- **参数校验**：入参在路由层用 Zod Schema 严格校验；SQL 查询全部使用参数化绑定。
- **日志脱敏**：明文 Token、私钥、UUID 和完整请求体绝不写入持久化日志。

---

## 2. 三类端点概览

### 2.1 管理 API（`/api/v1/admin/*`）

由 Cloudflare Access 保护，仅接受同源请求，通过 JWT 里的邮箱识别管理员身份（用于审计记录）。资源按功能拆分为：

- **节点与端点**：`/nodes`（含 `DELETE /nodes/{nodeId}` 优雅卸载或强制删除）、`/nodes/{nodeId}/endpoints`、`/nodes/{nodeId}/status`、`/nodes/{nodeId}/clients`
- **端点协议**：创建时用 `protocol` 指定协议（`vless-reality`、`vmess`、`trojan`、`shadowsocks`、`hysteria2`），参数按协议校验，不匹配返回 `422`；协议创建后不可修改，`PATCH` 只接受该协议的参数。
- **全局节点注册令牌**：`/node-enrollment-token`（`GET` 查询配置状态，`POST /node-enrollment-token/rotate` 生成或轮换，可跨节点重复使用）
- **节点配置版本**：`/nodes/{nodeId}/configs`（下发、查看 diff、基于历史版本生成新版本回滚）
- **订阅档案与预览**：`/profiles`（`DELETE` 先软删移入回收站）、`/profiles/{profileId}/preview`
- **订阅链接**：`/subscriptions`（创建、轮换、撤销；撤销后移入回收站）
- **订阅用户与授权**：`/subscribers`（停用后移入回收站）、`/subscribers/{subscriberId}/nodes`
- **回收站**：`/recycle-bin`（汇总停用用户、撤销订阅与删除档案，支持按类型过滤、手动恢复、单个永久删除与清空；保留期见 [database.md](database.md#4-数据保留与自动清理)）
- **流量统计**：`/traffic/summary`

**几个需要注意的规则：**

- **流量查询**：`/traffic/summary` 必须传 `from`、`to`（Unix 秒，对齐小时桶）和 `groupBy`（`site` / `node` / `subscriber`），跨度最多 **31 天**，防止全表扫描。
- **用户状态**：`PATCH /subscribers/{id}` 只能手动设为 `active` 或 `disabled`；`limited` 和 `expired` 由系统自动算出，不能手动覆盖（也不能在超额或过期状态下强行改回 `active`）。
- **档案预览**：`/profiles/{id}/preview` 复用正式订阅筛选逻辑，但敏感凭据会换成占位符；就算当前一个可用节点都没有，也返回 `200`（附带每个节点被跳过的原因），不会像正式订阅那样报 `503`。

---

### 2.2 Agent 通信 API（`/api/v1/agent/*`）

常规请求携带 `Authorization: Bearer <node_id>.<secret>`；首次节点注册携带面板注册令牌 `Authorization: Bearer <enrollment_token>`。

| 端点 | 用途 | 关键机制 |
| --- | --- | --- |
| `POST /agent/enroll` | 一键安装时自动注册节点 | 校验全局可复用注册 Token 哈希，按节点上报的接入端点创建节点与 Endpoint，返回该节点专属的永久 `agent_token` |
| `POST /agent/report` | 心跳 + 流量上报 | 心跳和流量解耦（流量冲突不影响心跳落盘）；单次最多 40 个用户条目、64 KB；报表不能跨自然小时；同 `report_id` 重试哈希一致则幂等确认，内容不同返回 `409 REPORT_CONFLICT` |
| `GET /agent/users` | 拉取当前节点有效用户 | 支持 `ETag` / `If-None-Match`，版本没变直接返回 `304 Not Modified` |
| `GET /agent/config` | 拉取目标 Xray 配置 | 返回规范化 JSON 与 SHA-256 哈希；已是目标版本则返回 `204 No Content` |
| `POST /agent/config/result` | 上报配置应用结果 | 汇报 `applied` 或 `failed` 及结构化错误信息 |
| `POST /agent/uninstall` | 节点卸载确认 / 主动注销 | 节点确认面板下发的 `uninstall` 指令或执行 `zako-agent uninstall` 时调用，从控制面删除节点记录 |

---

### 2.3 订阅 API（`/sub/{token}/*`）

直接暴露在根路径下，靠路径里的随机 Token 访问，不走 Cloudflare Access：

- `GET /sub/{token}/clash.yaml`：返回 Clash.Meta YAML 配置
- `GET /sub/{token}/uri?encoding=base64`（默认）或 `?encoding=plain`：返回各协议标准 URI（`vless://`、`vmess://`、`trojan://`、`ss://`、`hysteria2://`）列表

| 状态码 | 含义 |
| --- | --- |
| `200` | 正常返回配置，附带 `subscription-userinfo` 用量头 |
| `400` | 不支持的 `encoding` 等参数错误 |
| `401` | Token 不存在或已被撤销 |
| `403` | 订阅已过期、用户被停用或当月流量已用完 |
| `503` | 账户和订阅都有效，但当前没有符合条件（在线且健康）的可用节点 |
