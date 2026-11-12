# Zako Panel

轻量代理节点管理面板。Cloudflare Worker 承担控制面，D1 保存数据，Vue SPA 提供管理界面，Debian 上的 Go Agent 负责采集 Xray 统计并上报心跳与流量。Worker 不转发代理流量，不执行 Xray，不主动连接节点。

## 能力

- 节点、endpoint 与订阅档案管理，P0 支持 VLESS + REALITY
- Clash.Meta YAML 与通用 URI 订阅，代理组与规则可配置
- Agent 心跳、Xray 统计采样、流量上报与按小时幂等入账
- 派生节点状态、站点/节点流量汇总与保留期清理

阶段划分与设计边界见 [docs/architecture.md](docs/architecture.md)，交付顺序见 [docs/roadmap.md](docs/roadmap.md)。

## 技术栈

- Worker：Hono、D1、Cloudflare Access JWT、Zod
- Web：Vue 3、Vite、Vue Router、Pinia、Element Plus、ECharts
- Agent：Go、BoltDB、systemd
- 契约：OpenAPI 3.1（`packages/contracts`），生成的类型供 Worker 与 Web 使用

## 目录

```text
apps/worker/        Cloudflare Worker：路由、服务、D1 仓储、中间件
apps/web/           Vue 3 管理界面，挂载在 /admin/
apps/agent/         Debian 节点 Agent（Go）
packages/contracts/ OpenAPI 契约、生成类型与跨语言 fixtures
migrations/         D1 迁移
deploy/             systemd unit 与安装脚本
scripts/            一次性初始化脚本
docs/               项目文档
```

## 快速开始

要求 Node.js 22+；构建 Agent 另需 Go 1.24+。

```bash
npm install
npm run db:migrate:local        # 本地 D1 建表
npm run bootstrap -- --email you@example.com   # 初始化 owner、默认档案与订阅
```

`bootstrap` 生成的 `bootstrap.sql` 需按输出提示导入 D1；订阅 token 只在终端输出一次。

修改 `packages/contracts/openapi.yaml` 后运行 `npm run contracts:generate` 重新生成类型。

本地启动 Worker 与 Web 开发服务器（两个终端）：

```bash
npm run dev                     # Wrangler，http://127.0.0.1:8787
npm run dev:web                 # Vite，http://127.0.0.1:5173/admin/
```

Vite 将 `/api` 与 `/sub` 代理到 Wrangler。本地 Access 配置写入 `.dev.vars`，参考 `.dev.vars.example`。

## 校验

```bash
npm run typecheck
npm test
npm run test:agent
npm run format:check
```

`npm run test:all` 先执行 Worker 测试再执行 Agent 测试；`npm run build` 校验类型并构建 Web 静态资源。

## 部署

面板与节点的完整步骤见 [docs/deployment.md](docs/deployment.md)。节点 Agent 的模块、配置与运行模型见 [docs/agent.md](docs/agent.md)。

## 文档

完整文档索引见 [docs/README.md](docs/README.md)。
