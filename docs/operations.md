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
- 保留 30% 余量；超过时优先把心跳/流量间隔提高到 600/1800 秒、缩短保留期或减少用户-节点组合。

## 4. 读取与存储

- 订阅请求一次 `batch` 读取约 20–50 行；100 次/天量级可忽略。
- 仪表盘读 `site_traffic_hourly` 24 行；节点详情按 `(node_id, bucket_start)` 读时间范围；用户详情按 `(subscriber_id, node_id, bucket_start)` 读。
- 流量查询最大 31 天，必须带时间范围；禁止全表扫描与 N+1。
- 按 90 天保留期估算：小时桶约 `24 × 90 × (节点数 + 用户-节点组合数 + 1)` 行；100 节点/100 组合约 43 万行，连同 30 天报表约 29 万行，单库低于 500 MB。
- 清理按主键或时间范围每批 1,000 行执行，避免单语句长时间写入。

## 5. CPU

- 订阅生成包含 YAML 序列化、URI 编码与 D1 等待；D1 等待不计 CPU，序列化计入。
- 上线前用 50/100 节点、500 条规则压测订阅端点；目标 p95 低于 5 ms，为 Access JWT、D1 与其他请求留余量。
- 超出时减少单次下发节点数、限制规则条数、在档案保存时预序列化静态片段，或升级 Paid。
- 不在 Worker 内做密码哈希、图片处理或大规模 JSON 转换。

## 6. 容量风险与验证

- **CPU 余量**：10 ms 限制下，YAML 序列化、Access JWT 与 D1 结果映射叠加后可能接近上限。用 50/100 节点、500 条规则压测订阅与管理端点，按 p95 留出 50% 余量。
- **Cache API 与 Access**：Access 前置的 Worker 当前无法使用 Cache API。订阅路径虽排除在 Access 之外，仍需在目标域名实测；未通过前不依赖缓存。
- **D1 batch 限制**：单次 batch 使用 8 条语句、每语句不超过 100 个绑定参数；上线前确认免费版 50 次子请求的计数方式，超出时进一步切分报表。
- **100 节点写入**：默认配置约 62% 写入额度，余量不足以再增加密集用户组合。超过 100 个活跃用户-节点组合时先提高流量间隔或缩短保留期。
- **P0 手工步骤**：P0 的 Xray 入站、默认用户与 REALITY 公钥必须出现在上线检查表中；P1 再收敛用户同步。

## 7. 可观测性

- Worker 日志记录 `request_id`、路由模板、状态码、错误码、耗时与 D1 `rows_read/rows_written`；不记录 token、订阅 URL、UUID 或请求体。
- Agent 结构化日志记录 `report_id`、节点 ID、配置版本、用户版本与重试次数；不记录 secret。
- 使用 Cloudflare 用量面板、D1 meta 与 GraphQL Analytics 观察额度；不把每次指标写回 D1。
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

## 9. 参考资料

以下额度与接口以部署时最新官方文档为准：

- [Cloudflare Workers Static Assets：路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Cloudflare Workers Static Assets：计费与限制](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Cloudflare Workers：限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1：价格与行计量](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1：batch 与事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Xray：Statistics](https://xtls.github.io/en/config/stats.html)
- [Xray：API 与 StatsService](https://xtls.github.io/en/config/api.html)
- [Xray-core：StatsService protobuf](https://github.com/XTLS/Xray-core/blob/main/app/stats/command/command.proto)
