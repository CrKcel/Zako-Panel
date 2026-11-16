# Zako Panel 文档

文档按主题拆分：`architecture.md` 记录跨模块的目标、决策与边界，其余文件各自负责一个子系统或流程。

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 目标与范围、阶段划分、核心决策、总体架构、模块边界、扩展方式 |
| [api.md](api.md) | 响应格式、管理 API、Agent API、订阅 API 与状态码 |
| [database.md](database.md) | D1 表结构、索引、迁移约定、保留与清理 |
| [traffic.md](traffic.md) | Xray 统计配置、Agent 采样、幂等入账、额度与周期 |
| [subscription.md](subscription.md) | 节点状态与分发条件、订阅查询、Clash 与 URI 生成、响应头 |
| [agent.md](agent.md) | Agent 模块、配置文件、进程模型、用户同步与热更新 |
| [config-delivery.md](config-delivery.md) | 配置定义与版本、发布流程、应用状态机与回滚 |
| [security.md](security.md) | 管理员认证、token、节点与输入约束 |
| [operations.md](operations.md) | 免费额度预算、可观测性、故障行为 |
| [deployment.md](deployment.md) | 面板部署、Access 配置、节点安装与初始化 |
| [launch-checklist.md](launch-checklist.md) | P0 上线检查表：面板、Access、节点、订阅、流量、容量与安全 |
| [testing.md](testing.md) | Worker、Agent、Web 与联调测试范围 |
| [roadmap.md](roadmap.md) | P0–P2 交付顺序与验收标准 |

建议阅读顺序：`architecture` → `database` → `api` → 当前工作涉及的子系统文档。
