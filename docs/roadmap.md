# 分阶段交付

阶段能力范围见 [architecture.md](architecture.md)，测试范围见 [testing.md](testing.md)。本文件记录每个阶段的实施顺序与验收标准。

## 1. P0：可用订阅与流量闭环

实施顺序：

1. 整理 Monorepo、Wrangler Assets 路由、Worker/Vue 构建。
2. 建立 D1 migrations、Hono 模块、统一错误格式、请求 ID 与 OpenAPI。
3. 接入 Cloudflare Access，完成 owner 引导、节点/endpoint、档案、订阅与默认用户。
4. 实现 VLESS REALITY 数据模型、Clash.Meta/URI 生成与规则分发，token 全哈希，并提供档案预览与节点凭据读取入口。
5. 实现 Agent 心跳、StatsService 采样、BoltDB outbox、单端点上报与流量幂等入账。
6. 实现总览、节点、订阅档案、订阅与流量页面。
7. 建立容量与安全检查：订阅 CPU、D1 读写、重复上报、空节点。
8. 建立 Agent 静态资产分发：Downloads Worker、滚动发布、网络安装与回滚。

验收：

- Clash.Meta 能导入配置并连接真实 VLESS REALITY 节点。
- 创建节点时为默认订阅用户生成凭据，订阅可立即下发。
- URI 与 Base64 能被目标客户端解析。
- 节点心跳、派生状态与小时流量正确展示。
- 重复上报不重复计数；Xray 重启不产生负流量；Agent 重装后新报表正常入账。
- 静态页面与 SPA 路由不调用 Worker；管理 API 未通过 Access 时返回 401。
- 无可用节点时返回 503，不下发空配置。
- 节点通过面板域名一条命令安装当前 Agent；稳定 URL 更新后 `/dl/agent/version` 与二进制版本一致。
- 下载缺失路径返回 404，静态请求不计 Worker 请求；回滚 Downloads Worker 后稳定 URL 恢复上一版本。

## 2. P1：多用户、授权与同步

实施顺序：

1. 开放订阅用户、额度、周期与到期管理。
2. 实现 `PUT /subscribers/{subscriberId}/nodes` 与 `node_clients` 创建/停用，回填已有授权。
3. 实现 `users_ver`、Agent 用户列表拉取、磁盘持久化与 `AlterInbound` 热更新。
4. 实现 15 分钟状态/额度 Cron、周期推进、`subscription-userinfo` 与用户流量页面。
5. 接入管理员角色与角色边界；增加系统指标展示。
6. 验证热更新后重启、撤销用户、超额用户与失败回退。

验收：

- 用户只能获得被授权节点，不能通过修改 URL 获取他人订阅。
- token 撤销与轮换生效；管理员角色边界有效。
- 额度和到期判断正确，流量汇总与小时桶一致。
- 停用/到期/超额用户在一个 Cron 周期内从节点用户集合移除；已建立连接可能继续存在，此限制在 UI 与文档中明确。
- Agent 重启后用户集合与配置不丢失。

## 3. P2：远程配置

实施顺序：

1. 实现配置定义渲染、不可变版本、diff 与发布。
2. 实现 Agent 拉取、hash 校验、私钥与用户合入、测试与原子应用。
3. 实现结果上报、失败恢复与历史版本创建式回滚。
4. 完成 Debian 12/13 故障注入与真实 Xray 联调。
5. 验证配置与用户同步并发、离线追赶与旧结果丢弃。

验收：

- 非法配置不会替换当前可用配置。
- 重启失败会恢复旧配置并展示结构化错误。
- 离线 Agent 恢复后直接应用最新 desired 版本。
- 重复应用与结果上报保持幂等。
- REALITY 私钥不离开节点；D1 中不存在私钥字段。
