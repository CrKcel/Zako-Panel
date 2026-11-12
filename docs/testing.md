# 测试策略

测试按 Worker、Go Agent、Web 与联调分层。运行命令见 [README](../README.md)，阶段验收标准见 [roadmap.md](roadmap.md)。

## 1. Worker

- 使用 Workers Vitest pool 与真实 D1 migration 执行集成测试。
- Clash YAML golden test，验证 mihomo/Clash.Meta 可解析。
- URI 编码、Base64、IPv6、空 short-id、特殊节点名。
- token 撤销/轮换、用户到期、额度、档案与授权交集、空节点 503。
- online/degraded/offline/disabled 状态与订阅过滤。
- 重复 `report_id`、同 ID 不同 payload、batch 回滚、跨小时切分、未知邮箱、迟到报表。
- 检查关键 SQL 的读取行数，禁止无界查询。
- Access JWT 签名、issuer、audience、过期、禁用管理员。

## 2. Go Agent

使用 fake StatsService 与 fake 命令执行器测试：

- 正常增量、零流量、计数器下降、Xray uptime 回退、缺失计数器。
- Agent 重启后的基线与 outbox 恢复；报表切分与 7 天淘汰。
- 断网补报、ACK 丢失、重复 ACK、409 处理、退避与 jitter。
- 用户集合拉取、持久化、热更新、重启后恢复、热更新失败回退。
- 配置 hash 错误、校验失败、rename 失败、重启失败、旧版恢复、旧结果迟到。
- 同版本重复应用、离线追赶、配置与用户同步并发。

## 3. Web 与联调

- TypeScript、`vue-tsc`、`go test ./...`、Go vet。
- Playwright 覆盖节点创建、订阅复制、流量展示、用户授权、配置发布。
- Debian 12/13 安装测试，真实 Xray 进程联调。
- 确认 StatsService/HandlerService 不监听公网，静态页面请求不进入 Worker。
- 24 小时容量测试：合成 100 节点/100 用户-节点组合/50 用户流量，核对请求数、D1 读写与 CPU。
