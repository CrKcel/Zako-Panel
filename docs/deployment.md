# 部署

部署由面板（Cloudflare Worker + D1 + 静态资源）与节点（Debian + Xray + Go Agent）两部分组成。本地开发命令见 [README](../README.md)，Agent 运行模型见 [agent.md](agent.md)，安全策略见 [security.md](security.md)。

## 1. 面板

### 1.1 Wrangler 配置

`wrangler.jsonc` 的关键字段：

- `main` 指向 `apps/worker/src/index.ts`。
- `assets.directory` 指向 `apps/web/dist`，`not_found_handling` 为 `single-page-application`。
- `assets.run_worker_first` 只包含 `/api/*` 与 `/sub/*`；`/admin/*` 静态页面由 Assets 直接返回。
- `d1_databases` 把 `DB` 绑定到 `zako-panel`，`database_id` 使用创建 D1 时返回的值。
- `triggers.crons` 设置 `*/15 * * * *`（周期推进与状态检查）与 `17 3 * * *`（保留期清理）。
- `observability.enabled` 为 `true`。

### 1.2 环境变量与 Access

- 变量：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ENVIRONMENT`。
- `/admin/*` 与 `/api/v1/admin/*` 必须经过 Cloudflare Access。
- `/sub/*` 与 `/api/v1/agent/*` 必须排除在 Access 之外，由订阅 token 与 Agent token 各自鉴权。
- Access 身份仍需在 `admin_users` 中存在且启用。
- 静态安全头由 `apps/web/public/_headers` 提供：CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、受限 Permissions Policy；`/admin/assets/*` 使用 immutable 缓存。
- `apps/web/public/_redirects` 将 `/admin/assets/*` 重写到 `/assets/*`（Vite 的 `base` 为 `/admin/`），并将 `/` 302 到 `/admin/`。

### 1.3 首次部署

```bash
npx wrangler d1 create zako-panel        # 将返回的 database_id 写入 wrangler.jsonc
npx wrangler d1 migrations apply zako-panel --remote
npm run deploy
```

### 1.4 初始化数据

首次部署后执行初始化脚本，创建首个 `owner`、默认订阅档案、默认订阅用户、订阅记录与 `meta` 键（`users_ver`、`default_subscriber_id`）：

```bash
npm run bootstrap -- --email admin@example.com
npx wrangler d1 execute zako-panel --remote --file=bootstrap.sql
```

脚本把订阅 token 只在终端输出一次，生成的 SQL 只包含 token 哈希与 ID。`bootstrap.sql` 已被忽略，不应提交。生产环境不提供“空表首个登录者自动成为 owner”的运行时逻辑。

## 2. 节点安装

节点需要 Debian 12/13、已安装的 Xray 与 root 权限。安装脚本支持 amd64 与 arm64。

```bash
cd apps/agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/zako-agent-linux-amd64 ./cmd/zako-agent
cd ../..
sudo deploy/install.sh apps/agent/bin/zako-agent-linux-amd64
```

`install.sh` 完成以下操作：

- 安装二进制到 `/usr/local/bin/zako-agent`，创建 `zako-agent` 系统用户与组。
- 创建 `/etc/zako-agent` 与 `/var/lib/zako-agent`，权限 0700。
- 把 `apps/agent/config.example.yaml` 安装为 `/etc/zako-agent/config.yaml`（已存在时保留），并创建空的 `/etc/zako-agent/token`。
- 安装并 enable `zako-agent.service`，不启动服务。
- 若本机存在 Xray，执行 `xray x25519` 生成 REALITY 密钥对：私钥写入 `/etc/xray/reality.key`（0600，属 `zako-agent`），公钥打印到终端。

启动前：

1. 把面板签发的 Agent token 写入 `/etc/zako-agent/token`，保持属 `zako-agent`、权限 0600。
2. 编辑 `/etc/zako-agent/config.yaml`，至少设置 `control_plane_url` 与 `node_id`；`xray_api_address` 默认为 `127.0.0.1:10085`，需与 Xray API inbound 一致；其余路径与间隔按实际环境调整。
3. 把安装时打印的 REALITY 公钥录入对应 endpoint 的 `public_key`。

```bash
sudo systemctl start zako-agent
journalctl -u zako-agent -f
```

P0 的 Xray 入站与默认用户需要在节点本地准备，默认用户的 UUID 可从订阅 URI 获取，统计配置见 [traffic.md](traffic.md)。systemd 单元的写路径与命令限制见 [security.md](security.md)。
