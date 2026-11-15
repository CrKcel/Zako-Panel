# 部署

部署由面板（Cloudflare Worker + D1 + 静态资源）与节点（Debian + Xray + Go Agent）两部分组成。本地开发命令见 [README](../README.md)，Agent 运行模型见 [agent.md](agent.md)，安全策略见 [security.md](security.md)。

## 1. 面板

### 1.1 Wrangler 配置

`wrangler.jsonc` 的关键字段：

- `main` 指向 `apps/worker/src/index.ts`。
- `assets.directory` 指向 `apps/web/dist`，`not_found_handling` 为 `single-page-application`。
- `assets.run_worker_first` 只包含 `/api/*` 与 `/sub/*`；`/admin/*` 静态页面由 Assets 直接返回。
- `d1_databases` 把 `DB` 绑定到 `zako-panel`，`database_id` 使用创建 D1 时返回的值。
- `triggers.crons` 设置 `*/15 * * * *` 与 `17 3 * * *`。当前只有后者执行保留期清理；`*/15` 在 P1 承接周期推进与状态检查，当前仅记录触发时间。
- `observability.enabled` 为 `true`。

### 1.2 环境变量与 Access

- 变量：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ENVIRONMENT`。
- `ENVIRONMENT=development` 与 `DEV_ADMIN_EMAIL` 只用于本地开发，不写入部署变量。
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
- 同一分支内用 `deploy/xray/config.example.json` 渲染 `/etc/xray/config.json`，写入私钥与随机 short id（0640，属组 `zako-agent`）；该步骤需要 `python3`，缺失时脚本给出警告并跳过。

启动前：

1. 把面板签发的 Agent token 写入 `/etc/zako-agent/token`，保持属 `zako-agent`、权限 0600。
2. 编辑 `/etc/zako-agent/config.yaml`，至少设置 `control_plane_url` 与 `node_id`；`xray_api_address` 默认为 `127.0.0.1:10085`，需与 Xray API inbound 一致；其余路径与间隔按实际环境调整。
3. 把安装时打印的 REALITY 公钥录入对应 endpoint 的 `public_key`。

```bash
sudo systemctl start zako-agent
journalctl -u zako-agent -f
```

### 2.1 P0 节点侧 Xray 配置

P0 不远程下发配置，节点使用安装脚本生成的静态配置：

1. 安装脚本在生成 REALITY 私钥后，用 `deploy/xray/config.example.json` 渲染 `/etc/xray/config.json`，写入私钥与新生成的 short id，权限 `0640`、属组 `zako-agent`。
2. 脚本打印 REALITY 公钥与 short id。公钥填入 endpoint 的 `public_key`，short id 填入 `short_id`。
3. 在面板的节点详情页“用户凭据”中复制 `xray_email` 与 `UUID`，替换模板中的对应占位项。`xray_email` 必须与 Xray 入站 client 的 `email` 完全一致，否则用户流量只计入节点与站点汇总，用户维度记为未知。
4. 校验并启动 Xray：

```bash
xray run -test -config /etc/xray/config.json
systemctl restart xray
```

模板中的 API inbound、stats 与 policy 与 [traffic.md](traffic.md) 的统计要求一致，不要删除。systemd 单元的写路径与命令限制见 [security.md](security.md)。P1 起用户集合由 Agent 同步，本节的手工步骤随之移除。

默认档案（`bootstrap` 生成的档案）`online_only = 1`，而节点状态由心跳派生。因此新建节点在 Agent 首次上报前按离线处理，订阅返回 `503`；Agent 启动后的首次心跳（默认 5 分钟内）即恢复下发。需要提前验证配置时，可在档案中关闭在线过滤，或用档案预览查看渲染结果。
