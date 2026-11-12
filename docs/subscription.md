# 订阅生成

订阅端点把档案配置、节点授权与流量数据组合成 Clash.Meta YAML 或通用 URI。请求路径与状态码见 [api.md](api.md)，表结构见 [database.md](database.md)，流量阈值语义见 [traffic.md](traffic.md)。

## 1. 节点状态与分发条件

不持久化冗余 `online` 字段，查询时统一派生：

| 状态 | 条件 |
| --- | --- |
| `disabled` | `nodes.enabled = 0` |
| `offline` | 从未心跳，或当前时间晚于 `last_seen_at + 3 × heartbeat_interval_seconds` |
| `degraded` | 心跳新鲜，但 `xray_healthy = 0` 或 `stats_healthy = 0` |
| `online` | 心跳新鲜且两者健康 |

分发条件与展示状态略有区别：

- `nodes.enabled = 1`，至少一个 `endpoints.enabled = 1`。
- 心跳新鲜。
- `xray_healthy = 1`；`stats_healthy = 0` 仍可分发，避免统计故障导致节点全部消失。
- 订阅用户状态为 `active`，且在有效期内、未超额。
- `node_clients.enabled = 1`。
- 档案为 `selected` 时，节点在 `profile_nodes` 中。
- `online_only = 1` 时按上述新鲜度过滤；`online_only = 0` 时允许离线节点进入配置。

没有任何可分发节点时返回 `503`，不下发空配置。

停用节点或 endpoint 只改变控制面分发；运行中的 Xray 由 P2 配置发布或管理员在节点本地操作收敛。

## 2. 查询顺序

1. 对 URL token 做 SHA-256，以唯一索引查询订阅与订阅用户。
2. 校验订阅撤销、订阅到期、用户状态与到期。
3. 一次 `batch` 读取：档案、`profile_nodes`、`node_clients`、节点、启用的 endpoints、`subscriber_usage`。
4. 若 `subscriber_usage.cycle_start` 早于订阅用户当前周期，按 0 处理；再校验额度。
5. 取档案节点集合与用户授权集合的交集。
6. 过滤停用节点、停用 endpoint、离线节点（`online_only`）与不健康 Xray。
7. 生成稳定且唯一的节点名称；单 endpoint 使用节点名，多 endpoint 使用“节点名-endpoint 名”。
8. 序列化 Clash YAML 或 URI，不调用外部转换服务。

查询使用 JOIN 与批量 `IN`，不逐节点查询。

## 3. Clash.Meta YAML

```yaml
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
proxies:
  - name: Tokyo-01
    type: vless
    server: 203.0.113.10
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
    network: tcp
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: www.example.com
    reality-opts:
      public-key: <reality-public-key>
      short-id: <short-id>
    client-fingerprint: chrome
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - AUTO
      - Tokyo-01
  - name: AUTO
    type: url-test
    proxies:
      - Tokyo-01
    url: https://www.gstatic.com/generate_204
    interval: 300
rules:
  - MATCH,PROXY
```

- 所有字符串通过 YAML 库序列化；规则作为结构化数组校验。
- 节点名、代理组名与规则中的名称做唯一性检查。
- 不强制覆盖客户端 DNS、外部控制器或 `allow-lan`；档案可显式配置基础字段。
- 档案存储 `clash_base_json`、`proxy_groups_json`、`rules_json`，不接受未校验的任意 YAML 片段。

## 4. 通用 URI

```text
vless://UUID@203.0.113.10:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=PUBLIC_KEY&sid=SHORT_ID&type=tcp#Tokyo-01
```

- UUID、主机、端口来自服务端记录，不从查询参数接收。
- query 与 fragment 使用 UTF-8 百分号编码；IPv6 字面量使用方括号。
- 空 `short-id` 不输出无意义参数。
- 多节点以换行分隔，默认使用标准 Base64 编码完整 UTF-8 文本。
- `encoding=plain` 仅用于兼容与调试。

## 5. 响应头与缓存

- Clash：`Content-Type: application/yaml; charset=utf-8`。
- URI：`Content-Type: text/plain; charset=utf-8`。
- `profile-update-interval: 6`（小时）。
- `subscription-userinfo: upload=...; download=...; total=...; expire=...`；`total=0` 表示不限量，`expire=0` 表示永不过期。
- `Content-Disposition` 使用固定扩展名的安全文件名。
- `Cache-Control: private, no-store`，避免含凭据内容被共享缓存保存。
- Cache API 只作为压测后的可选优化。Access 前置的 Worker 当前无法使用 Cache API；订阅路径虽排除在 Access 之外，仍需实测后再启用。
