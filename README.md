# Zako Panel

轻量级代理节点管理面板：Cloudflare Worker + D1 做控制面，Vue 3 做管理后台，Debian 上的 Go Agent 负责管 Xray 用户和上报流量。Worker 本身不转发代理流量，不运行 Xray，也不主动连节点。

## 核心能力

- 节点、接入端点（Endpoint）与订阅档案管理，支持 VLESS + REALITY、VMess、Trojan、Shadowsocks 与 Hysteria2
- 订阅用户、月度流量配额、有效期与按节点授权
- 自动生成 Clash.Meta YAML 与通用 URI 订阅链接，支持自定义代理组和分流规则
- 节点 Agent 定时心跳、Xray 流量采样与按小时幂等入账
- 节点用户列表热更新（通过 Xray gRPC 增量增删，失败时自动回退到安全重启）
- 节点一键安装脚本自动接管已有 Xray 配置（VLESS + REALITY、VMess、Trojan、Shadowsocks 入站纳入管理，其余入站保持原样，无配置时写入默认模板），以及 Agent 二进制滚动分发（独立 Downloads Worker）

## 技术栈

- **控制面 Worker**：Hono、Cloudflare D1、Cloudflare Access JWT、Zod
- **管理后台 Web**：Vue 3、Vite、Vue Router、Element Plus、ECharts
- **节点 Agent**：Go、BoltDB、systemd
- **接口契约**：OpenAPI 3.1（`packages/contracts/openapi.yaml`），自动生成 Worker 与 Web 的 TypeScript 类型

## 目录

```text
apps/worker/        Cloudflare Worker：routes / services / repositories / protocols / renderers
apps/web/           Vue 3 管理后台，挂载在 /admin/
apps/agent/         Debian 节点 Agent（Go）
apps/downloads/     Agent 安装包与脚本的静态分发配置
packages/contracts/ OpenAPI 契约、生成的 TS 类型与跨语言测试 fixtures
migrations/         D1 数据库迁移脚本
deploy/             systemd unit、节点安装脚本与发布打包脚本
scripts/            本地初始化与容量压测脚本
docs/               项目文档
```

## 快速开始

环境要求：Node.js 22+；如果要编译或测试 Go Agent，另需 Go 1.24+。

### 1. 安装依赖并初始化本地数据库

```bash
npm install
npm run db:migrate:local
```

### 2. 配置本地开发鉴权

管理接口默认要求 Cloudflare Access JWT，本地没有 Access 网关时直接请求会返回 `401`。复制一份本地环境变量文件：

```bash
cp .dev.vars.example .dev.vars
```

在 `.dev.vars` 中设置 `ENVIRONMENT=development` 和 `DEV_ADMIN_EMAIL=<任意邮箱>`，Worker 就会在本地开发模式下用这个邮箱直接通过鉴权（线上部署务必保持 `ENVIRONMENT=production` 且不要设置 `DEV_ADMIN_EMAIL`）。

### 3. （可选）生成初始测试数据

如果想快速体验订阅功能，可以生成并导入一份默认数据（包含默认订阅档案、默认用户和一条订阅链接）：

```bash
npm run bootstrap
npx wrangler d1 execute zako-panel --local --file=bootstrap.sql
```

> 订阅 Token 只在终端打印这一次，注意保存；导入后可删掉 `bootstrap.sql`。

### 4. 启动开发服务器

开两个终端分别启动后端和前端：

```bash
npm run dev       # Worker（Wrangler），默认 http://127.0.0.1:8787
npm run dev:web   # Web（Vite），默认 http://127.0.0.1:5173/admin/
```

Vite 会自动把 `/api` 和 `/sub` 请求代理到 Wrangler。

> 如果修改了 `packages/contracts/openapi.yaml`，记得运行 `npm run contracts:generate` 重新生成类型。

## 校验

提交或发布前运行以下检查：

```bash
npm run typecheck
npm test
npm run test:agent
npm run test:downloads
npm run format:check
```

也可以直接运行 `npm run test:all` 依次执行 Worker、Agent 与 downloads 测试，用 `npm run build` 检查类型并构建前端静态资源。

## 部署

面板上线与节点快速部署的完整步骤见 [docs/deployment.md](docs/deployment.md)。节点一键部署命令（在后台 **「节点列表 -> 一键部署节点」** 生成一次性 Token）：

```bash
curl -fsSL https://332711.xyz/dl/agent/install.sh | sudo bash -s -- \
  --panel https://332711.xyz \
  --token <ONE_TIME_ENROLLMENT_TOKEN>
```

## 文档

完整文档目录与阅读指南见 [docs/README.md](docs/README.md)。
