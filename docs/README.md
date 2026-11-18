# Zako Panel 文档

文档按主题拆分，每篇只讲一件事。刚接触项目时建议先看 **上手与部署**，需要改代码或排查问题时再按需查 **原理与参考**。

## 上手与部署

| 文档 | 看这篇能了解什么 |
| --- | --- |
| [architecture.md](architecture.md) | **先看这里**：核心概念关系、整体架构、不做什么、代码分层与扩展方式 |
| [deployment.md](deployment.md) | 面板部署到 Cloudflare、Downloads Worker 分发、节点一键安装与上线检查清单 |
| [testing.md](testing.md) | 怎么跑 Worker、Agent、打包分发和容量压测 |

## 原理与参考

| 文档 | 看这篇能了解什么 |
| --- | --- |
| [database.md](database.md) | D1 表之间的关系、为什么拆出几张流量聚合表、数据保留与清理策略 |
| [api.md](api.md) | 接口统一响应格式、错误码、游标分页与三类端点的交互约定（具体字段见 `openapi.yaml`） |
| [agent.md](agent.md) | Agent 在节点上怎么跑：用户热更新、失败回退、远程改配置状态机与最小权限 |
| [traffic.md](traffic.md) | 流量是怎么从 Xray 采出来、按小时拆包、幂等写入 D1 并统计月度配额的 |
| [subscription.md](subscription.md) | 节点在线状态怎么算、哪些节点会放进订阅、Clash YAML 和 URI 怎么生成 |
| [security.md](security.md) | 管理员鉴权、Token 与私钥存放边界、节点隔离与防篡改机制 |
| [operations.md](operations.md) | Cloudflare 免费额度怎么算够不够用、日志看什么、常见故障怎么自愈 |
