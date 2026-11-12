# Zako Panel

轻量代理节点管理面板。Cloudflare Worker 承担控制面，D1 保存数据，Vue SPA 提供管理界面，Debian Go Agent 负责节点侧采集与配置。架构与数据模型见 [docs/architecture.md](docs/architecture.md)。

## 技术栈

- Worker：Hono、D1、Cloudflare Access JWT、Zod
- Web：Vue 3、Vite、Vue Router、Pinia、Element Plus、ECharts
- Agent：Go、BoltDB、systemd
- 契约：OpenAPI 3.1（`packages/contracts`），生成的类型供 Worker 与 Web 使用

## 目录

```text
apps/
├── worker/          Worker 路由、服务、仓储、中间件与工具
├── web/             Vue 管理界面（挂载在 /admin/）
└── agent/           Debian 节点 Agent
packages/contracts/  OpenAPI 契约、生成类型、跨语言 fixtures
migrations/          D1 迁移
deploy/              systemd unit 与安装脚本
docs/                架构文档
```

## 开发

要求 Node.js 22+、npm 11+。Agent 另需 Go 1.24+。

```bash
npm install
npm run contracts:generate      # openapi.yaml 变更后重新生成类型
npm run db:migrate:local        # 本地 D1 建表
npm run build                   # 构建 Web 静态资源到 apps/web/dist
```

本地运行 Worker 与 Web 开发服务器（两个终端）：

```bash
npm run dev                     # Wrangler，http://127.0.0.1:8787
npm run dev:web                 # Vite，http://127.0.0.1:5173/admin/
```

Vite 开发服务器将 `/api` 与 `/sub` 代理到 Wrangler。`/admin/*` 页面由静态资源返回，`/api/*` 与 `/sub/*` 优先进入 Worker。

本地 Access 配置写入 `.dev.vars`（参考 `.dev.vars.example`）。管理 API 校验 Cloudflare Access JWT 与 D1 中的管理员角色，生产环境不存在开发态旁路。

## 校验

```bash
npm run typecheck               # 全部 TypeScript workspace
npm test                        # Worker 单元测试（Workers Vitest）
npm run test:agent              # Go Agent 测试
npm run test:all                # 两者
npm run format:check
```

## 部署

```bash
npx wrangler d1 create zako-panel        # 将返回的 database_id 写入 wrangler.jsonc
npx wrangler d1 migrations apply zako-panel --remote
npm run deploy
```

同时配置 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 与 `ENVIRONMENT`，并为 `/admin/*`、`/api/v1/admin/*` 设置 Access 策略；`/sub/*` 与 `/api/v1/agent/*` 必须排除在 Access 之外。

## Agent

```bash
cd apps/agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/zako-agent-linux-amd64 ./cmd/zako-agent
cd ../..
sudo deploy/install.sh apps/agent/bin/zako-agent-linux-amd64
```

安装脚本创建 `zako-agent` 系统用户、`/etc/zako-agent` 与 `/var/lib/zako-agent`，安装 systemd unit 并 enable，但不启动服务。把面板签发的节点 token 写入 `/etc/zako-agent/token`，按 [config.example.yaml](apps/agent/config.example.yaml) 准备配置后再启动：

```bash
sudo systemctl start zako-agent
```

REALITY 私钥保存在节点本地 `/etc/xray/reality.key`；Worker 只保存公钥。
