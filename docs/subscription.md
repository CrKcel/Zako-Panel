# 节点状态与订阅生成

客户端请求 `/sub/{token}/clash.yaml` 或 `/sub/{token}/uri` 时，控制面会实时检查用户权限、筛选可用节点，并把结果渲染成对应格式返回，全程不依赖外部订阅转换服务。

接口说明见 [api.md](api.md)，数据表见 [database.md](database.md)，配额与超额规则见 [traffic.md](traffic.md)。

---

## 1. 节点状态怎么算出来的

数据库里**不直接存节点是 `online` 还是 `offline`**，而是在查询节点或生成订阅时，根据 `nodes` 表里的最后心跳时间实时算出来（省掉定时扫表写库）。

判定顺序如下：

| 状态 | 判定条件 | 含义 |
| --- | --- | --- |
| `disabled` | `nodes.enabled = 0` | 管理员手动停用了这台节点 |
| `offline` | 从未收到心跳，或当前时间 > `last_seen_at + 3 × heartbeat_interval_seconds` | 连续超过 3 个心跳周期没联系（比如默认 5 分钟心跳，超过 15 分钟就算离线） |
| `degraded` | 心跳正常，但 `xray_healthy = 0` 或 `stats_healthy = 0` | 节点还活着，但 Xray 代理或统计接口异常 |
| `online` | 心跳正常，且 `xray_healthy = 1`、`stats_healthy = 1` | 一切正常 |

---

## 2. 哪些节点能放进订阅里

一个节点（及其下的 Endpoint）必须**同时满足**以下所有条件，才会出现在用户的订阅里：

1. **节点和 Endpoint 都没停用**（`nodes.enabled = 1` 且 `endpoints.enabled = 1`）。
2. **Xray 代理进程健康**（`xray_healthy = 1`）。注意：如果只是统计端口坏了（`stats_healthy = 0`，节点状态显示 `degraded`），代理本身还能通，所以依然会下发。
3. **心跳达标**（当订阅档案开启了 `online_only` 时，必须没超时离线；如果关闭了 `online_only`，允许把离线节点也放进去）。
4. **用户本身可用**（`subscribers.status = 'active'`，且订阅链接没被撤销或过期）。
5. **用户有该节点的权限**（`node_clients.enabled = 1`）。
6. **节点在档案的筛选范围内**（档案配置了“全部节点”或“指定节点列表”）。

> 如果过滤完一个可用节点都不剩，正式订阅接口会返回 `503 SUBSCRIPTION_UNAVAILABLE`，不会下发空配置把客户端覆盖掉。而管理后台的档案预览接口（`/preview`）则会正常返回空列表，并列出每个节点被跳过的原因（如 `offline`、`unhealthy`、`disabled`、`not_selected`）。

---

## 3. 支持的协议与凭据

每个 Endpoint 创建时确定协议，之后不可修改；参数按协议校验，存在 `endpoints.params_json` 里。

| 协议 | Clash `type` | URI | 节点侧 |
| --- | --- | --- | --- |
| `vless-reality` | `vless` | `vless://` | Agent 接管 Xray 入站 |
| `vmess` | `vmess` | `vmess://`（Base64 JSON） | Agent 接管 Xray 入站 |
| `trojan` | `trojan` | `trojan://` | Agent 接管 Xray 入站 |
| `shadowsocks` | `ss` | `ss://` | Agent 接管 Xray 入站 |
| `hysteria2` | `hysteria2` | `hysteria2://` | 非 Xray 协议，端点由管理员手工创建 |

**凭据模型**：一个“用户-节点”授权只生成一份凭据（`node_clients.vless_uuid`）。VLESS 和 VMess 把它当 UUID 下发，Trojan、Shadowsocks 和 Hysteria2 把它原样当密码下发，因此同一个用户在同一节点的所有协议共用这一个值，不需要额外的凭据表。

Hysteria2 不走 Xray，Agent 也不会把它写进节点配置：面板只负责把它渲染进订阅，节点上的 Hysteria2 服务需要管理员用同一份凭据（`node_clients.vless_uuid`）自行配置。

传输参数在 Clash 与 URI 里的字段名不同：gRPC 在 URI 中用 `serviceName` 和 `authority`（Clash 对应 `grpc-opts.grpc-service-name`），WebSocket 用 `path` 和 `host`。

协议适配器定义在 `apps/worker/src/protocols/`：每个协议一个文件，负责参数校验（Zod）、Clash 代理项和 URI 渲染，通过注册表统一接入。新增协议只需新增适配器并注册；需要 Agent 接管的协议还要同时加进 `AGENT_PROTOCOLS`。

---

## 4. 一次订阅请求的处理步骤

1. **识别订阅**：从 URL 取出 `{token}`，按唯一索引查 `subscriptions` 表。找不到或已撤销/过期 → 返回 `401` 或 `403`。
2. **检查用户**：确认对应 `subscriber` 没被停用、没过期、当月没超流量 → 不满足返回 `403`。
3. **批量取数据**：一次查出订阅档案（Profile）的模板规则、关联节点、用户授权节点以及当月已用流量。
4. **筛选与重名处理**：按第 2 节的条件过滤出最终 Endpoint 列表。如果一个节点只有一个 Endpoint，节点显示名直接用节点名；有多个 Endpoint，则拼接成 `节点名-端点名`，保证不重名。协议参数无法通过校验（比如历史数据不再满足新 schema）的 Endpoint 直接跳过。
5. **渲染输出**：
   - **Clash.Meta YAML**（`/clash.yaml`）：把筛选后的 Endpoint 按各自协议渲染成 `proxies`，再结合档案里存的 `clash_base_json`、`proxy_groups_json`、`rules_json` 拼成完整 YAML（所有敏感凭据会做唯一性校验）。
   - **通用 URI**（`/uri`）：按协议生成标准 URI（`vless://`、`vmess://`、`trojan://`、`ss://`、`hysteria2://`），换行拼接后默认做 Base64 编码；带 `?encoding=plain` 则直接返回明文。

---

## 5. 响应头约定

| 响应头 | 值 / 用途 |
| --- | --- |
| `Content-Type` | Clash 返回 `application/yaml; charset=utf-8`；URI 返回 `text/plain; charset=utf-8` |
| `subscription-userinfo` | `upload=...; download=...; total=...; expire=...`，让客户端直接显示已用流量、总配额（`0` 表示不限）和到期时间 |
| `profile-update-interval` | `6`，建议客户端每 6 小时自动更新一次订阅 |
| `Cache-Control` | `private, no-store`，禁止 CDN 或代理缓存带有用户凭据的订阅内容 |
