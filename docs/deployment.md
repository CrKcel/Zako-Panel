# 部署

部署由面板（Cloudflare Worker + D1 + 静态资源）、Downloads Worker（Agent 二进制静态资产）与节点（Debian + Xray + Go Agent）三部分组成。本地开发命令见 [README](../README.md)，Agent 运行模型见 [agent.md](agent.md)，分发与安装细节见 [agent-distribution.md](agent-distribution.md)，安全策略见 [security.md](security.md)。

## 1. 面板

### 1.1 Wrangler 配置

`wrangler.jsonc` 的关键字段：

- `main` 指向 `apps/worker/src/index.ts`。
- `assets.directory` 指向 `apps/web/dist`，`not_found_handling` 为 `single-page-application`。
- `assets.run_worker_first` 只包含 `/api/*` 与 `/sub/*`；`/admin/*` 静态页面由 Assets 直接返回。
- `d1_databases` 把 `DB` 绑定到 `zako-panel`，`database_id` 使用创建 D1 时返回的值。
- `triggers.crons` 设置 `*/15 * * * *` 与 `17 3 * * *`。`*/15` 执行订阅用户周期推进与状态判定，`17 3 * * *` 执行保留期清理。
- `observability.enabled` 为 `true`。

### 1.2 环境变量与 Access

- 变量：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ENVIRONMENT`。
- `ENVIRONMENT=development` 与 `DEV_ADMIN_EMAIL` 只用于本地开发，不写入部署变量。
- `/admin/*` 与 `/api/v1/admin/*` 必须经过 Cloudflare Access。
- `/sub/*`、`/api/v1/agent/*` 与 `/dl/*` 必须排除在 Access 之外，由订阅 token、Agent token 与公开静态资产各自处理。
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

## 2. Agent 下载 Worker

Agent 二进制由独立 assets-only Downloads Worker 在 `332711.xyz/dl/agent/*` 下分发。产物、缓存与回滚规则见 [agent-distribution.md](agent-distribution.md)。

### 2.1 路由与部署

1. 确认 `wrangler.downloads.jsonc` 的 route 为 `332711.xyz/dl/*`、zone 为 `332711.xyz`；换域名要同步改这两项并重发版本。
2. 确认 `/dl/*` 未进入 Access（见 1.2）。
3. 配置 GitHub repository variable `AGENT_DOWNLOAD_BASE_URL=https://332711.xyz/dl/agent`。
4. 配置 GitHub secrets `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。token 需要 Workers Scripts:Edit、Workers Routes:Edit 与 Zone:Read。
5. 推送 `agent-v*` tag 触发 `Release agent` 流水线；流水线构建、校验、生成静态资产并部署 Downloads Worker。已生成 `apps/downloads/dist` 时，也可以用 `npm run deploy:downloads` 手工部署。

首次发布会创建 Worker 与 route。面板 Worker 不需要重新部署。

### 2.2 发布验证

```bash
curl -fsS https://332711.xyz/dl/agent/version
curl -fsSI https://332711.xyz/dl/agent/zako-agent-linux-amd64.tar.gz
curl -s -o /dev/null -w '%{http_code}\n' https://332711.xyz/dl/agent/missing.tar.gz
```

返回 HTML 200 表示 `/dl/*` 落到了面板 SPA，需要检查 route 或 Access 排除。

## 3. 节点安装

节点需要 Debian 12/13、已安装的 Xray、root 权限，以及 `curl` 或 `wget`。安装脚本支持 amd64 与 arm64。

### 3.1 网络安装

```bash
curl -fsSL https://332711.xyz/dl/agent/install.sh | sudo bash -s
```

脚本下载当前稳定版本，校验 SHA-256，解压后执行 tarball 内的 `install.sh`。`install.sh` 完成以下操作：

- 安装二进制到 `/usr/local/bin/zako-agent`，创建 `zako-agent` 系统用户与组。
- 创建 `/etc/zako-agent` 与 `/var/lib/zako-agent`，权限 0700。
- 把 `config.example.yaml` 安装为 `/etc/zako-agent/config.yaml`（已存在时保留），并创建空的 `/etc/zako-agent/token`。
- 安装并 enable `zako-agent.service`，不启动服务；服务已运行时提示重启。
- 安装 polkit 规则 `/etc/polkit-1/rules.d/50-zako-agent-xray.rules`，只允许 `zako-agent` 重启 `xray.service`。
- 若已安装 Xray，把 `/etc/xray` 设为 `root:zako-agent`、`0770`，使 Agent 能原子替换 `config.json`。
- 若已安装 Xray，执行 `xray x25519` 生成 REALITY 密钥对：私钥写入 `/etc/xray/reality.key`（0600，属 `zako-agent`），公钥打印到终端。
- 若已安装 Xray，用 `deploy/xray/config.example.json` 渲染 `/etc/xray/config.json`，写入私钥与随机 short id（0640，属组 `zako-agent`）；该步骤需要 `python3`，缺失时脚本给出警告并跳过。

启动前：

1. 把面板签发的 Agent token 写入 `/etc/zako-agent/token`，保持属 `zako-agent`、权限 0600。
2. 编辑 `/etc/zako-agent/config.yaml`，至少设置 `control_plane_url` 与 `node_id`；`xray_api_address` 默认为 `127.0.0.1:10085`，需与 Xray API inbound 一致；其余路径与间隔按实际环境调整。
3. 把安装时打印的 REALITY 公钥录入对应 endpoint 的 `public_key`。

```bash
sudo systemctl start zako-agent
journalctl -u zako-agent -f
```

升级执行同一命令，然后 `systemctl restart zako-agent`。回滚见 [agent-distribution.md](agent-distribution.md#6-回滚)。

### 3.2 本地构建安装

在仓库内开发和离线安装：

```bash
cd apps/agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/zako-agent-linux-amd64 ./cmd/zako-agent
cd ../..
sudo deploy/install.sh apps/agent/bin/zako-agent-linux-amd64
```

`install.sh` 也会在脚本目录查找 `zako-agent`，因此可以从解压后的发布包直接执行。

### 3.3 节点侧 Xray 配置

节点使用安装脚本生成的静态入站模板，客户端由 Agent 首次用户同步写入：

1. 安装脚本在生成 REALITY 私钥后，用 `deploy/xray/config.example.json` 渲染 `/etc/xray/config.json`，写入私钥与新生成的 short id，权限 `0640`、属组 `zako-agent`。模板中的 `clients` 是占位项，由 Agent 覆盖。
2. 脚本打印 REALITY 公钥与 short id。公钥填入 endpoint 的 `public_key`，short id 填入 `short_id`。
3. 在面板创建节点并在该节点上授权订阅用户后，Agent 在下一次同步（启动时或心跳触发）按 `node_clients` 渲染 `clients` 并热更新运行中的入站。`xray_email` 必须与入站 client 的 `email` 完全一致，否则用户流量只计入节点与站点汇总，用户维度记为未知。
4. 校验并启动 Xray：

```bash
xray run -test -config /etc/xray/config.json
systemctl restart xray
```

模板中的 API inbound、stats 与 policy 与 [traffic.md](traffic.md) 的统计要求一致，不要删除。Agent 以当前文件为模板，只替换 VLESS 入站的 `clients` 并合入本地 REALITY 私钥，其余字段保持不变。polkit 规则与 `/etc/xray` 权限由安装脚本设置，systemd 单元的写路径与命令限制见 [security.md](security.md)。

默认档案（`bootstrap` 生成的档案）`online_only = 1`，而节点状态由心跳派生。因此新建节点在 Agent 首次上报前按离线处理，订阅返回 `503`；Agent 启动后的首次心跳（默认 5 分钟内）即恢复下发。需要提前验证配置时，可在档案中关闭在线过滤，或用档案预览查看渲染结果。

## 4. 上线

部署与节点安装完成后，逐项执行 [launch-checklist.md](launch-checklist.md)。容量验证用 `npm run capacity`，见 [operations.md](operations.md#6-容量风险与验证)。
