# Zako Panel 文档

文档按业务主题独立划分：`architecture.md` 阐述跨模块的目标、核心决策与系统边界，其余文件各自负责一个子系统或流程。

| 文档 | 核心内容 |
| --- | --- |
| [architecture.md](architecture.md) | 总体目标、核心决策、系统边界、模块职责与扩展方式 |
| [api.md](api.md) | 响应格式规范、管理 API、Agent 通信 API、订阅 API 与状态码 |
| [database.md](database.md) | D1 实体模型、流量聚合设计、索引策略与数据生命周期 |
| [traffic.md](traffic.md) | Xray 统计规范、Agent 增量采样、Worker 幂等入账与自然月周期 |
| [subscription.md](subscription.md) | 节点状态派生、订阅分发过滤规则、Clash 与 URI 格式规范及响应标头 |
| [agent.md](agent.md) | Agent 运行模型、运行时配置、用户凭据同步、远程配置管理与权限模型 |
| [security.md](security.md) | Access 身份鉴权、凭据与敏感数据防护、节点安全约束与分发安全边界 |
| [operations.md](operations.md) | 免费额度预算基线、开销测算模型、可观测性与系统自愈故障矩阵 |
| [deployment.md](deployment.md) | 控制面板部署、Downloads Worker 静态资产分发、节点一键安装与上线验证清单 |
| [testing.md](testing.md) | Worker、Agent、静态分发、前端及端到端容量测试策略 |

建议阅读顺序：`architecture` → `database` → `api` → 当前关注的子系统文档。
