# 订阅生成与分发

控制面根据订阅档案规则、节点运行状态与用户授权凭据，动态生成适用于 Clash.Meta 的 YAML 配置或通用 URI 文本。API 路径定义详见 [api.md](api.md)，数据库存储结构详见 [database.md](database.md)，配额判定规则详见 [traffic.md](traffic.md)。

## 1. 节点状态派生与分发条件

系统采用无冗余持久化设计，节点展示状态与分发资格统一在查询时动态派生：

### 1.1 节点运行状态定义

| 状态 | 判定规则 | 说明 |
| --- | --- | --- |
| `disabled` | `nodes.enabled = 0` | 节点被管理员手动停用 |
| `offline` | 无心跳记录，或当前时间超出 `last_seen_at + 3 × heartbeat_interval_seconds` | 节点失去心跳连接 |
| `degraded` | 心跳保持新鲜，但 `xray_healthy = 0` 或 `stats_healthy = 0` | 节点通信正常，核心组件报告异常 |
| `online` | 心跳保持新鲜，且 `xray_healthy = 1` 与 `stats_healthy = 1` | 节点运行健康 |

### 1.2 节点分发过滤准则

只有同时满足下列所有条件的节点，才会装配至客户端订阅文档中：

- 节点与网络端点均处于启用状态（`nodes.enabled = 1` 且 `endpoints.enabled = 1`）。
- 节点心跳保持有效新鲜度。
- Xray 代理进程报告健康（`xray_healthy = 1`）。若仅统计接口异常（`stats_healthy = 0`），节点仍保留分发资格。
- 订阅用户状态处于 `active`，且在有效期内未超出流量配额。
- 用户在该节点持有有效的授权凭据（`node_clients.enabled = 1`）。
- 节点包含在目标档案的节点选择范围内（全选或列表白名单）。
- 当档案开启 `online_only` 时，节点必须满足心跳新鲜度；未开启时允许处于离线状态的节点进入配置。

当所有节点均被过滤导致分发集合为空时，端点返回 `503 SUBSCRIPTION_UNAVAILABLE`，禁止下发空配置。

## 2. 订阅请求处理流程

客户端发起订阅请求后，Worker 执行以下装配步骤：

1. 凭据检索：提取 URL 中的 Token 进行 SHA-256 哈希计算，检索匹配的订阅与用户记录。
2. 权限校验：确认订阅凭据未撤销且未到期，依序验证用户停用、到期与超额状态。
3. 批量聚合：单次批处理查询档案规则、关联节点集、用户授权集合以及当前计费周期的汇总用量。
4. 集合求交：将档案限定的节点与用户授权的节点集合求交集，剔除已停用、不健康或超时离线的端点。
5. 名称去重：为入选节点生成稳定唯一的标识符。单端点使用节点名，多端点组合“节点名-端点名”。
6. 文档序列化：按请求类型渲染为 Clash.Meta YAML 或通用 URI，不调用外部转换服务。

## 3. 订阅格式规范

### 3.1 Clash.Meta YAML 规范

- 协议支持：完整映射 VLESS + REALITY 协议字段（包括传输类型、流控 `xtls-rprx-vision`、REALITY 公钥与 short-id、客户端指纹）。
- 结构化注入：由档案中结构化存储的 `clash_base_json`、`proxy_groups_json` 与 `rules_json` 装配 proxies、proxy-groups 与 rules 配置块。
- 标识符防护：节点名称、策略组名称与规则指向做全局唯一性校验，避免同名冲突。

### 3.2 通用 URI 规范

- 标准链接：组装规范的 `vless://` 链接，主机、端口、UUID、公钥、流控与指纹等参数均由服务端记录填充。
- 格式编码：默认采用换行符分隔多个节点链接，并进行标准 Base64 编码输出；通过参数 `encoding=plain` 可输出明文连接串。

## 4. 响应标头与缓存规范

- 文档内容类型：Clash 响应声明 `Content-Type: application/yaml; charset=utf-8`；URI 响应声明 `Content-Type: text/plain; charset=utf-8`。
- 用量指示头：携带 `subscription-userinfo: upload=...; download=...; total=...; expire=...`，向客户端展示当期消耗量与配额上限（0 表示无限制）。
- 客户端更新周期：携带 `profile-update-interval: 6`（小时），指示推荐同步频率。
- 缓存控制：采用 `Cache-Control: private, no-store`，禁止边缘及共享代理节点持久化含有用户凭据的订阅文档。
