# 运维与容量

容量按 Workers 与 D1 免费额度规划，监控使用 Cloudflare 面板与 Analytics，不把指标写回 D1。数据保留期见 [database.md](database.md)。

## 1. 免费额度基线

以部署时官方文档为准，以下为当前基线：

| 项目 | Workers Free |
| --- | --- |
| 静态 Assets 请求 | 免费且不计 Worker 请求 |
| Worker 请求 | 100,000 次/天 |
| Worker CPU | 10 ms/次 |
| Worker 子请求 | 50/次 |
| D1 行读取 | 5,000,000 行/天 |
| D1 行写入 | 100,000 行/天 |
| D1 存储 | 5 GB/账户，单库 500 MB |
| Cron Triggers | 5/账户 |

### 1.1 Agent 下载资产

- Agent 二进制由独立 assets-only Downloads Worker 提供，静态资产请求免费且不计 Worker 请求与 CPU。
- 当前构建的 amd64 二进制约 18.45 MiB，arm64 约 17.28 MiB；tarball 压缩后约 10 MB。单文件低于 25 MiB，单个 Worker 版本的文件数远低于 20,000。
- 滚动发布只保留当前版本；`apps/downloads/dist` 约 21 MB，发布时整体上传。
- 稳定 URL 使用 `Cache-Control: public, max-age=0, must-revalidate` 与 ETag；不使用 immutable。
- 回滚使用 Downloads Worker 的 Cloudflare 版本回滚，或重跑上一个 `agent-v*` tag。细节见 [agent-distribution.md](agent-distribution.md)。

## 2. 请求预算

默认 300 秒上报一次，心跳与流量共用请求：

```text
Agent 请求/天 = 节点数 × (86400 / 300) = 节点数 × 288
总 Worker 请求/天 = Agent 请求 + 订阅请求 + 管理 API 请求 + Cron
```

100 节点约 28,800 次/天，占免费额度 29%；为订阅与管理请求留出余量。纯心跳请求不产生流量行。Cron 每天约 97 次调用，计入 Worker 请求但量级可忽略。

## 3. D1 写入预算

```text
心跳行写入/天 = 节点数 × 288
报表行写入/天 = 节点数 × (86400 / 流量间隔)
节点小时桶写入/天 = 节点数 × (86400 / 流量间隔)
站点小时桶写入/天 = 86400 / 流量间隔
用户小时桶写入/天 = 活跃用户-节点组合数 × (86400 / 流量间隔)
用户周期汇总写入/天 = 活跃订阅用户数 × (86400 / 流量间隔)
```

默认流量间隔 900 秒：

| 场景 | 心跳 | 报表 | 节点桶 | 站点桶 | 用户桶 | 周期汇总 | 合计 | 占额度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20 节点 / 50 用户-节点 / 50 用户 | 5,760 | 1,920 | 1,920 | 96 | 4,800 | 4,800 | 19,296 | 19% |
| 100 节点 / 100 用户-节点 / 50 用户 | 28,800 | 9,600 | 9,600 | 96 | 9,600 | 4,800 | 62,496 | 62% |

- 流量间隔改为 300 秒时，100 节点/100 用户-节点场景约 13 万行/天，超过免费额度。默认 900 秒是硬约束，不随节点数放大而放宽。
- 每次 upsert 只写 1 行；不用额外二级索引，`site_traffic_hourly` 代替全站时间索引。
- 报表行、小时桶与周期汇总在同一 batch 内原子提交；失败回滚不计入重复写入。
- 清理删除同样计入 D1 写入，按 1,000 行/批执行；保留期越长，清理写入越高。
- `npm run capacity` 用隔离的本地 D1 复现目标形状，输出种子行数与日写入预算；表内数字应与该命令输出一致。
- 周期推进的 Cron 每 15 分钟先用一条 SQL 选出可能过期的候选订阅用户，单轮上限 500 行，再只读取这些候选的周期用量；写入随周期推进与状态变化的用户数增长，稳态下接近 0。
- 保留 30% 余量；超过时优先把心跳/流量间隔提高到 600/1800 秒、缩短保留期或减少用户-节点组合。

## 4. 读取与存储

- 订阅请求一次 `batch` 读取约 20–50 行；100 次/天量级可忽略。
- 仪表盘读 `site_traffic_hourly` 24 行；节点详情按 `(node_id, bucket_start)` 读时间范围；用户详情按 `(subscriber_id, node_id, bucket_start)` 读。
- 流量查询最大 31 天，必须带时间范围；禁止全表扫描与 N+1。
- 按 90 天保留期估算：小时桶约 `24 × 90 × (节点数 + 用户-节点组合数 + 1)` 行；100 节点/100 组合约 43 万行，连同 30 天报表约 29 万行，单库低于 500 MB。
- 清理按主键或时间范围每批 1,000 行执行，避免单语句长时间写入。
- `*/15` Cron 每轮先筛选候选订阅用户（上限 500 行），只读取候选的周期用量；写入只发生在周期推进或状态变化时。

## 5. CPU

- 订阅生成包含 YAML 序列化、URI 编码与 D1 等待；D1 等待不计 CPU，序列化计入。
- `npm run capacity` 按 100 节点、500 条规则测量订阅与管理端点的本地延迟分位（参数见 `npm run capacity -- --help`）；线上 CPU 时间以部署后面板数据为准，目标 p95 低于 5 ms，为 Access JWT、D1 与其他请求留余量。
- 超出时减少单次下发节点数、限制规则条数、在档案保存时预序列化静态片段，或升级 Paid。
- 不在 Worker 内做密码哈希、图片处理或大规模 JSON 转换。

## 6. 容量风险与验证

- **CPU 余量**：10 ms 限制下，YAML 序列化、Access JWT 与 D1 结果映射叠加后可能接近上限。用 `npm run capacity` 压测订阅与管理端点，按 p95 留出 50% 余量。
- **Cache API 与 Access**：Access 前置的 Worker 当前无法使用 Cache API。订阅路径虽排除在 Access 之外，仍需在目标域名实测；未通过前不依赖缓存。
- **D1 batch 限制**：单次 batch 使用 8 条语句、每语句不超过 100 个绑定参数；上线前确认免费版 50 次子请求的计数方式，超出时进一步切分报表。
- **100 节点写入**：默认配置约 62% 写入额度，余量不足以再增加密集用户组合。超过 100 个活跃用户-节点组合时先提高流量间隔或缩短保留期。
- **周期推进写入**：`*/15` Cron 每轮先用一条 SQL 选出候选订阅用户（上限 500 行），只读取这些候选的周期用量，只为需要推进周期或状态变化的用户写入；状态全部一致时该轮只有一次候选查询。集中大批停用或超额时写入会随状态变化数量上升。
- **节点侧同步**：管理员变更或 Cron 物化状态后递增 `users_ver`，Agent 在下一次心跳后拉取并收敛用户集合，默认 5 分钟内完成；Agent 以 `If-None-Match` 拉取，版本未变化时不产生请求体与写盘。热更新失败时 Agent 重启 `xray.service`，需要节点已安装 polkit 规则且 `/etc/xray` 保持 `root:zako-agent`、`0770`。
- **手工步骤**：入站模板、REALITY 公钥与 short id 的核对项见 [launch-checklist.md](launch-checklist.md)。

## 7. 可观测性

- Worker 日志记录 `request_id`、路由模板、状态码、错误码、耗时与 D1 `rows_read/rows_written`；不记录 token、订阅 URL、UUID 或请求体。
- Agent 结构化日志记录 `report_id`、节点 ID、配置版本、用户版本与重试次数；不记录 secret。
- 使用 Cloudflare 用量面板、D1 meta 与 GraphQL Analytics 观察额度；不把每次指标写回 D1。Agent 下载的请求与缓存状态在 Cloudflare 资产与访问日志中查看。
- 告警：Worker 请求/CPU 接近上限、D1 读写接近上限、节点离线、配置连续失败、Cron 失败。

## 8. 故障行为

| 故障 | 行为 |
| --- | --- |
| D1/Worker 故障 | Agent 保留 outbox 并退避；订阅返回 503；管理 UI 显示可重试错误 |
| Worker 免费额度耗尽 | 返回 429/1027；Agent 遵守 `Retry-After` 或加大退避，不丢本地数据 |
| 节点离线 | 已有配置继续工作；超过 3 个心跳周期后从订阅移除；D1 历史保留 |
| StatsService 故障 | 节点标记 `degraded`，仍可分发；流量可能少计，报表标记 gap |
| Xray 计数器归零 | 增量取当前值并标记 `has_counter_gap`，不产生负流量 |
| 配置校验失败 | 不替换当前配置，上报结构化错误；旧配置继续服务 |
| 重启失败 | 恢复最近已知可用配置并再次启动，保留错误详情 |
| Agent 状态丢失 | 重新拉取用户集合与配置；未 ACK 流量可能丢失，按 gap 记录 |
| `/dl/*` route 缺失或优先级错误 | 请求落到面板 SPA 返回 HTML；修正 Downloads Worker route |
| Downloads Worker 部署失败 | 线上保持上一个 Worker 版本，稳定 URL 不变 |
| 新 Agent 版本异常 | 回滚 Downloads Worker 或重跑上一 tag；已安装节点不自动变化 |
| 安装时跨版本读取 | 校验失败，安装脚本重新下载 `SHA256SUMS` 与 tarball 一次 |

## 9. 参考资料

以下额度与接口以部署时最新官方文档为准：

- [Cloudflare Workers Static Assets：路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Cloudflare Workers Static Assets：计费与限制](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Cloudflare Workers Static Assets：响应头](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Workers：路由](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Cloudflare Workers：限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1：价格与行计量](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1：batch 与事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Xray：Statistics](https://xtls.github.io/en/config/stats.html)
- [Xray：API 与 StatsService](https://xtls.github.io/en/config/api.html)
- [Xray-core：StatsService protobuf](https://github.com/XTLS/Xray-core/blob/main/app/stats/command/command.proto)
