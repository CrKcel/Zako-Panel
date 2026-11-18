# Zako Panel 系统架构

Zako Panel 由控制面（Cloudflare Worker + D1）、管理界面（Vue SPA）与节点侧 Go Agent 组成。Worker 不转发代理流量，不执行 Xray，不主动连接节点。

本文件描述跨模块的目标、决策与边界。项目定位与开发命令见 [README](../README.md)；子系统细节见 [api.md](api.md)、[database.md](database.md)、[traffic.md](traffic.md)、[subscription.md](subscription.md)、[agent.md](agent.md)、[security.md](security.md) 与 [deployment.md](deployment.md)。

## 1. 目标与边界

### 1.1 系统约束

- 代理协议支持 VLESS + REALITY，传输协议为 TCP，流控为 `xtls-rprx-vision`。
- Xray 基础配置由安装流程生成，客户端凭据由 Agent 根据版本号拉取并热更新。
- 节点状态由 Agent 上报的心跳时间动态派生，控制面不主动轮询节点。
- 运行成本优先以 Cloudflare 免费额度为基准，鉴权、流量幂等和配置校验机制保持完整。
- 流量额度与有效期实施软限制：超额或到期后停止下发新订阅并将凭据从节点入站中移除，保持已建立连接直至自然结束。
- 控制面使用 Cloudflare Worker 与 D1，未引入外部消息队列或第三方控制服务。
- Agent 二进制与安装脚本由独立静态资产 Downloads Worker 分发，面板 Worker 专注控制面业务。

### 1.2 系统边界

系统范围不包含多租户计费结算、自动支付、外部订阅转换、WebSocket 长连接、实时硬限速、历史二进制分发、任意远程 Shell 执行以及分钟级原始流量留存。

### 1.3 规模指标

| 指标 | 设计目标 | 预算上限 |
| --- | --- | --- |
| 节点数 | 20 | 100 |
| 订阅用户数 | 50 | 50 |
| 活跃用户-节点组合数 | 50 | 100 |
| 单节点活跃用户上限 | 20 | 20 |
| 流量保留 | 90 天小时桶 / 30 天报表记录 | 同左 |
| 心跳间隔 | 300 秒 | 60–900 秒 |
| 流量上报间隔 | 900 秒 | 300–3600 秒 |

系统容量主要取决于“活跃用户-节点组合数”。当规模超出上限时，通过调整上报间隔与保留周期适配预算，或升级 Workers 付费计划。

## 2. 核心架构决策

| 决策 | 方案 | 理由 |
| --- | --- | --- |
| 工程结构 | Monorepo | Worker、Web、Agent 与 API 契约统一版本管理 |
| Worker 架构 | Hono + 分层模式 | 轻量运行时，路由、服务与仓储职责清晰隔离 |
| 数据访问 | D1 预编译语句 + 事务批处理 | 确定性 SQL，严格控制参数绑定与单次行读写 |
| API 契约 | OpenAPI 3.1 | 单一真实源生成 TypeScript 类型，Go 端通过契约测试对齐 |
| 前端架构 | Vue 3 + Vite + Vue Router | 静态单页应用，无服务端渲染资源消耗 |
| UI 框架 | Element Plus + ECharts | 提供开箱即用的管理表格、表单与流量可视化 |
| 管理端认证 | Cloudflare Access JWT + D1 角色 | 避免在 Worker CPU 额度内进行耗时密码哈希计算 |
| Agent 认证 | 独立高熵 Bearer Token | 单节点可单独撤销，控制面仅持久化 SHA-256 哈希 |
| Agent 分发 | 独立静态 Downloads Worker | 静态下载走 CDN 边缘分发，无 Worker 运行时费用消耗 |
| 节点模型 | `nodes` 表关联 `endpoints` 表 | 入站与网络参数解耦，支持多端点扩展 |
| Agent 上报 | 单端点合并心跳与流量 | 降低请求频次，合并提交确保状态与用量原子更新 |
| 流量幂等 | 客户端 `report_id` + 载荷哈希 | 网络重试或重复提交均保证账单精确入账 |
| 流量存储 | 小时聚合桶 + 站点桶 + 周期汇总 | 兼顾图表聚合查询效率与常数时间额度判断 |
| 凭据同步 | 全局版本号 `users_ver` + 差集热更新 | 变更时增量生效，无需频繁重启代理核心 |
| 配置下发 | 不可变配置定义 + SHA-256 校验 | 私钥保留在节点本地，配置错误自动保留有效备份 |
| 状态检测 | 基于最近心跳时间动态派生 | 避免定时扫表修改状态字段，降低数据库写入压力 |

路由层仅将 `/api/*` 与 `/sub/*` 映射至 Worker 逻辑，静态资源与 `/dl/*` 分发均由 Cloudflare 边缘静态直接承载。

## 3. 总体架构

```mermaid
flowchart LR
    Browser[管理浏览器] -->|静态页面| Assets[Workers Static Assets]
    Browser -->|管理 API| Worker[Cloudflare Worker]
    Client[订阅客户端] -->|Clash YAML / URI| Worker
    NodeAdmin[节点管理员] -->|curl /dl/agent/*| Downloads[Downloads Worker]
    Worker --> D1[(Cloudflare D1)]
    Agent[Debian Go Agent] -->|心跳 / 流量 / 配置结果 HTTPS| Worker
    Agent -->|用户列表 / 配置定义| Worker
    Agent -->|loopback gRPC| Xray[Xray-core]
    Agent -->|校验 / 原子替换 / 重启| Xray
    Xray --> Users[代理用户]
```

### 3.1 边界与职责划分

- Worker 负责控制面业务编排，不承担代理流量转发，不保存用户代理会话，不调用 Xray 可执行文件。
- Agent 仅发起向控制面的出站 HTTPS 请求，不对公网暴露管理或 RPC 监听端口；gRPC 服务仅监听环回地址。
- Web 管理界面为纯静态前端，敏感凭据仅在创建或轮换操作响应中展示一次。
- D1 存储控制面全局数据；Agent 本地数据库存储计数器基线、待发送报表与凭据状态。
- REALITY 私钥仅留存在节点本地；控制面仅保存公钥与入站配置定义。
- Downloads Worker 仅托管分发静态文件，不连接数据库，不运行业务逻辑。

## 4. 模块职责

顶层目录与应用入口详见 [README](../README.md#目录)。

### 4.1 Worker 分层

- `routes`：负责 HTTP 参数解析、状态码映射与响应格式装配。
- `services`：承载业务规则，包括订阅节点筛选、配置映射、版本递增与流量汇总。
- `repositories`：执行 D1 SQL、批量操作、结果集映射与读写限制。
- `protocols`：协议校验与配置转换适配器，通过注册表统一管理。
- `renderers`：Clash.Meta YAML 配置与通用 URI 订阅文本生成。
- `middleware`：提供 Access JWT 校验、Agent Token 验证、RBAC 鉴权与错误包装。
- `lib`：通用辅助函数，涵盖哈希、随机凭据、ULID 生成、周期计算与状态判定。

API 路径统一采用 `/api/v1` 前缀；订阅端点为 `/sub/{token}`；Agent 通信端点为 `/api/v1/agent`。

### 4.2 Web 应用

| 模块 | 核心内容 |
| --- | --- |
| 仪表盘 | 节点运行状态统计、全站流量指标、系统异常警报 |
| 节点管理 | 节点基础信息编辑、公网连接参数、系统负载指标、Token 轮换 |
| 节点详情 | 运行状态诊断、网络与硬件指标、流量统计、端点管理与配置历史 |
| 订阅档案 | 节点筛选策略、基础配置项、分流规则组装与预览 |
| 订阅管理 | 订阅令牌下发、链接复制、格式切换、撤销与轮换 |
| 流量分析 | 时间跨度筛选、多维度（全站 / 节点 / 用户）用量聚合与趋势图 |
| 用户管理 | 流量配额设定、重置周期、有效期维护、节点授权矩阵 |
| 管理员 | Cloudflare Access 身份绑定、角色分配与启用维护 |

前端架构划分：
- `domain/`：纯函数业务逻辑（流量单位换算、时间窗口切分、状态描述判定），脱离框架依赖。
- `composables/`：通用逻辑抽象（异步资源加载、操作提交状态、对话框生命周期、条件轮询）。
- `components/`：业务通用组件（端点配置表单、节点授权选择器、流量指标面板）。
- 管理凭据使用只读同源 Cookie 鉴权，订阅 Token 与 Agent Token 均不持久化于本地存储。

### 4.3 Downloads Worker

- 由 `wrangler.downloads.jsonc` 独立配置，仅挂载静态资产目录与 `/dl/*` 路由规则。
- 资产打包生成固定命名的发布包、安装脚本及校验签名，通过稳定 URL 提供滚动分发。
- 静态请求由边缘缓存直接响应，不计入 Worker 请求与计算时间。

## 5. 系统扩展

- 协议扩展：新增 `ProtocolAdapter` 实现参数校验及 Clash / URI 生成规则，在注册表中声明即可生效。
- 订阅格式扩展：复用已过滤的节点 DTO，增加对应的 Renderer 实现。
- 指标扩展：心跳结构支持选填字段，控制面通过独立服务消化新指标。
- 管理功能扩展：按分层规范补充管理路由、业务服务、D1 迁移脚本与前端视图。
