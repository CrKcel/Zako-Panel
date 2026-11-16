# 测试策略

测试按 Worker、Go Agent、Web 与联调分层。运行命令见 [README](../README.md)，阶段验收标准见 [roadmap.md](roadmap.md)。

## 1. Worker

`apps/worker/test` 使用 Workers Vitest pool，并在每个测试文件前应用真实 D1 migration：

- Clash YAML 由 YAML 解析器重新解析，校验节点名、代理组与规则。
- URI 编码、Base64、IPv6、空 short-id、节点名去重。
- token 撤销/轮换、订阅到期、用户到期、额度、档案与授权交集、空节点 503。
- online/degraded/offline/disabled 状态与订阅过滤。
- 重复 `report_id`、同 ID 不同 payload、心跳先提交、跨小时拒绝、未知邮箱、版本钳制。
- 流量汇总的时间归一、最大范围、node/subscriber/site 聚合。
- 节点创建与默认订阅用户凭据、分页、名称冲突、档案校验、Cron 清理批次。
- 档案预览与真实下发的结构一致性、跳过原因、用户阻断原因、空节点预览不为 `503`。
- 新节点在首次心跳上报后即可进入默认订阅。
- 节点凭据列表返回 P0 手工配置所需的 `xray_email` 与 UUID。

## 2. Go Agent

测试使用临时 BoltDB、loopback gRPC fake StatsService 与 httptest 控制面，不依赖真实 Xray、root 或外网：

- 正常增量、零流量、计数器下降、Xray uptime 回退、缺失计数器、首次基线不回填。
- 小时边界切分、40 用户切分、节点流量排除 api inbound。
- Agent 重启后的基线与 outbox 恢复；报表 7 天淘汰；关闭报表时 `period_end` 被钳制到关闭时刻或小时边界。
- ACK 删除、ACK 丢失、409/413/422 丢弃、429 Retry-After、5xx/网络错误退避与心跳间隔不被推迟。
- 配置默认值、未知字段与非法地址。

## 3. Web 与联调

- `vue-tsc` 与 `vite build` 校验类型与页面构建。
- CI 串行执行 `contracts:generate` 漂移检查、`typecheck`、`test`、`test:agent`、`format:check`、`build` 与 Worker 打包。
- 节点创建、一次性 token、订阅链接复制、档案编辑、流量展示需要浏览器联调。
- Debian 12/13 安装测试，真实 Xray 进程联调，确认 StatsService/HandlerService 不监听公网。
- `npm run capacity` 在隔离的本地 D1 上合成 100 节点/100 用户-节点组合/50 用户/500 条规则，压测订阅与管理端点并校验响应形状；D1 行数与 CPU 以部署后面板数据为准。
