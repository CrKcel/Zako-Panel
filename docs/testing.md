# 测试策略

测试按 Worker、Go Agent、Agent 分发、Web 与联调分层。运行命令见 [README](../README.md)，阶段验收标准见 [roadmap.md](roadmap.md)。

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
- 节点凭据列表返回 Agent 同步所需的 `xray_email` 与 UUID。

订阅用户与用户同步：

- 创建、列表、详情与更新；邮箱重复返回 `409`；分页游标与 `node_count` 正确。
- 授权整体替换：新增节点创建 `node_clients`，移除的节点置 `enabled=0`，重新授权复用原 UUID 与 `xray_email`，授权集合未变化时不递增 `users_ver`。
- 状态派生：`disabled` 粘性、`expired`、`limited` 与 `active` 按优先级物化；创建时直接写入派生状态。
- 资格判定与放行原因来自同一谓词：非 `active` 的状态必定对应一个阻断原因，`active` 必定无阻断原因。
- Cron 候选 SQL 与派生规则对拍：候选集恰好覆盖“派生状态与存储值不一致”或“周期已结束”的订阅用户。
- `users_ver` 只在状态或授权实际变化时递增。
- 用户列表只返回本节点启用且订阅用户为 `active` 的凭据；`ETag` 与版本一致，`If-None-Match` 命中该标签或 `*` 时返回 `304` 且无 body，旧标签返回 `200`，版本推进后标签更新。
- 周期推进：跨过 `usage_cycle_end` 时重置 `subscriber_usage`、更新周期边界并重新派生状态；一次跨多月时持续推进到当前月；`*/15` 触发只做周期与状态处理，保留期清理留给 `17 3 * * *`。
- 管理员：列表、新增与更新；邮箱重复返回 `409`；移除最后一个启用的 `owner` 返回 `409`；`viewer` 与 `admin` 的角色边界在路由层生效。

## 2. Go Agent

测试使用临时 BoltDB、loopback gRPC fake StatsService、fake HandlerService 与 httptest 控制面，不依赖真实 Xray、root 或外网：

- 正常增量、零流量、计数器下降、Xray uptime 回退、缺失计数器、首次基线不回填。
- 小时边界切分、40 用户切分、节点流量排除 api inbound。
- Agent 重启后的基线与 outbox 恢复；报表 7 天淘汰；关闭报表时 `period_end` 被钳制到关闭时刻或小时边界。
- ACK 删除、ACK 丢失、409/413/422 丢弃、429 Retry-After、5xx/网络错误退避与心跳间隔不被推迟。
- 配置默认值、未知字段与非法地址；`xray_inbound_tag` 缺省为 `vless-reality`。

用户同步与热更新：

- 首次应用写入用户集合、渲染配置并推进 `users_version`；`304` 短路不再写盘。
- 差集应用：新增、删除与 UUID 变化（同邮箱的删除加新增）。
- 热更新失败回退为校验、原子替换、重启与健康检查；回退失败时 `users_version` 与 `users.json` 都不推进。
- 重试从磁盘 `users.json` 重新求差集并收敛；部分成功后再次同步不重复新增。
- `users.json` 与 `config.json` 不一致时走重启路径修复；重启后用户集合不丢失。
- `users.json` 权限为 0600；缺少静态配置时报告 `ErrNoConfig`。
- 配置渲染：只替换 VLESS 入站的 `clients`，保留静态字段，合入本地 REALITY 私钥，已有私钥不被覆盖，多个 VLESS 入站或缺少入站时报错。
- HandlerService 编码：`AlterInbound` 的 `AddUser` / `RemoveUser` protobuf 线格式与往返编解码，跳过未知字段，缺少 `uuid` 的账号被拒绝。

## 3. Web 与联调

- `vue-tsc` 与 `vite build` 校验类型与页面构建。
- CI 串行执行 `contracts:generate` 漂移检查、`typecheck`、`test`、`test:agent`、`test:downloads`、`format:check`、`build` 与 Worker 打包。
- 节点创建、一次性 token、订阅链接复制、档案编辑、订阅用户与管理员管理、流量展示需要浏览器联调。
- Debian 12/13 安装测试，真实 Xray 进程联调，确认 StatsService/HandlerService 不监听公网，并核对热更新后入站 `clients` 与面板用户集合一致。
- `npm run capacity` 在隔离的本地 D1 上合成 100 节点/100 用户-节点组合/50 用户/500 条规则，压测订阅与管理端点并校验响应形状；D1 行数与 CPU 以部署后面板数据为准。

## 4. Agent 分发

- `deploy/tests/package-release.sh` 校验 tarball 顶层目录、安装资产（含 polkit 规则）、`VERSION`、可执行位与敏感文件排除。
- `deploy/tests/stage-downloads.sh` 校验稳定文件集合、`SHA256SUMS`、`version`、tarball 内部 `VERSION` 一致性、`_headers` 与输出中的敏感文件；篡改版本后 staging 必须失败。
- `npm run test:downloads` 执行以上两个测试；CI 在 Worker 与 Agent 测试之后运行。
- 人工验收：
  - `/dl/agent/version` 返回纯文本，不是 SPA HTML。
  - tarball 返回 `application/gzip`、`must-revalidate`、`ETag` 与下载头；缺失路径返回 404。
  - Debian 12/13 amd64 与 arm64 节点执行安装命令，版本与 `/dl/agent/version` 一致。
  - 连续发布两个 tag，稳定 URL 内容更新；回滚 Downloads Worker 或重跑上一 tag 后恢复。
  - 篡改 tarball 后安装脚本退出，不执行 root 级安装。
  - 面板 Worker 部署不改变 `/dl/*` 内容。
