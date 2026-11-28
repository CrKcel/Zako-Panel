# 部署指南与上线检查

整套系统部署包含三部分：**控制面板**（Cloudflare Worker + D1 + Web 静态页）、**Agent 下载分发**（独立 Downloads Worker）和**代理节点**（Debian 12/13 + Xray + Go Agent）。

---

## 1. 部署控制面板（Cloudflare）

### 1.1 检查 `wrangler.jsonc`

- 入口为 `apps/worker/src/index.ts`，静态资源目录指向 `apps/web/dist`（`single-page-application` 模式）。
- `assets.run_worker_first` 仅包含 `/api/*` 和 `/sub/*`，前端页面直接由边缘静态返回。
- 已配置两个定时触发器：`*/15 * * * *`（月度周期推进）和 `17 3 * * *`（每日清理过期数据）。
- 生产环境变量需配置 `ENVIRONMENT=production`、`ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD`。

> **Cloudflare Access 路径配置**：只保护 `/admin/*` 和 `/api/v1/admin/*`；**千万不要**把 `/sub/*`、`/api/v1/agent/*` 和 `/dl/*` 拦进 Access，否则客户端和节点会连不上。

### 1.2 创建数据库并部署

```bash
npx wrangler d1 create zako-panel
# 把控制台输出的 database_id 填进 wrangler.jsonc

npx wrangler d1 migrations apply zako-panel --remote
npm run deploy
```

### 1.3 导入初始数据

```bash
npm run bootstrap
npx wrangler d1 execute zako-panel --remote --file=bootstrap.sql
```

终端会打印一次默认订阅 Token，注意保存；导入完成后记得删掉本地生成的 `bootstrap.sql`。

---

## 2. 节点一键部署

节点支持 **Debian 12 / 13**，只需预先有 `curl`（或 `wget`）、`tar` 和 CA 证书。脚本会自动下载缺失的 Xray-core（支持 `--xray-mirror` 指定镜像）、生成缺失的 REALITY 私钥、创建低权限用户 `zako-agent` 并注册节点。

1. 在管理后台 **「节点列表」** 点击 **「一键部署节点」**，首次使用时生成全局注册 Token（可在多台节点重复使用，随时可轮换使旧 Token 失效）。
2. 在节点上执行后台生成的命令：

```bash
curl -fsSL https://332711.xyz/dl/agent/install.sh | sudo bash -s -- \
  --panel https://332711.xyz \
  --token <ENROLLMENT_TOKEN>
```

脚本会识别节点上已有的 Xray/V2Ray 配置（`/etc/xray/config.json`、`/usr/local/etc/xray/config.json`、`/etc/v2ray/config.json` 等）：VLESS + REALITY、VMess、Trojan、Shadowsocks 入站被接管为面板接入端点，其他协议的入站保持原样；没有配置时写入默认模板。接入端点由节点上报后自动创建，面板侧不需要填写协议参数。Hysteria2 不走 Xray，端点需要在节点详情页手工创建。一次注册最多上报 16 个接入端点，超出的入站在节点上继续提供代理但不受面板管理。

常用可选参数：`--name <节点名>`、`--host <公网IP或域名>`、`--xray-mirror <镜像地址>`。

执行完后，`xray.service` 和 `zako-agent.service` 会自动拉起，节点几十秒内就会在面板显示为 `online`，并在节点详情页看到自动创建的接入端点。

### 升级与卸载

- **升级 Agent**：
  - **远程自动更新**：调用 `POST /api/v1/admin/nodes/{nodeId}/agent-update`（传入 `target_version`），节点会在下次心跳收到 `self_update` 指令后自动从 `/dl/agent/` 下载校验、替换二进制并重启（失败自动回滚）。
  - **就地覆盖升级**：在已部署的节点上重跑不带 `--token` 的安装命令覆盖二进制并保留现有配置，然后重启服务即可：
    ```bash
    curl -fsSL https://332711.xyz/dl/agent/install.sh | sudo bash -s
    sudo systemctl restart zako-agent
    ```
- **卸载节点**：
  - **从面板远程卸载**：在后台节点列表或详情页点击 **「删除」**，默认会先将节点标记为「正在卸载」并在下次心跳下发 `uninstall` 指令，节点自动清理本机服务与文件后从面板删除（可选同时卸载 Xray-core）；若节点长期离线，可选择 **「强制删除」** 立即从面板移除。
  - **从节点主动卸载**：在节点上以 root 执行内置命令（会自动通知面板删除节点并清理本机）：
    ```bash
    sudo zako-agent uninstall          # 仅卸载 Agent（保留 Xray）
    sudo zako-agent uninstall --remove-xray  # 同时卸载 Xray-core 与 /etc/xray
    ```
    若二进制已损坏，也可使用安装包中的 `deploy/uninstall.sh`。

---

## 3. Agent 分发（Downloads Worker）

节点安装脚本和二进制包通过独立的静态 Downloads Worker 挂载在 `/dl/agent/*` 下，走边缘 CDN 缓存，不占用主面板 Worker 的请求额度：

- `/dl/agent/install.sh`：一键安装脚本
- `/dl/agent/SHA256SUMS`：脚本与压缩包的 SHA-256 校验清单
- `/dl/agent/version`：当前最新版本号
- `/dl/agent/zako-agent-linux-amd64.tar.gz` / `arm64.tar.gz`：静态编译归档

发布流程由 `agent-v*` Git 标签自动触发（`CGO_ENABLED=0` 交叉编译并生成 `SHA256SUMS`），通过 `wrangler deploy --config wrangler.downloads.jsonc` 发布；如果新版本有问题，可直接回滚：

```bash
npx wrangler rollback --config wrangler.downloads.jsonc
```

---

## 4. 上线前检查清单

**控制面与鉴权**
- [ ] D1 迁移执行完成，`bootstrap` 初始数据已导入
- [ ] 访问 `/admin/` 能正常跳到 Cloudflare Access 登录；未带凭证请求 `/api/v1/admin/nodes` 返回 `401`
- [ ] `/sub/*` 和 `/dl/*` 没有被 Access 拦截
- [ ] Cron Triggers（`*/15 * * * *` 与 `17 3 * * *`）已在 Cloudflare 后台激活

**节点与同步**
- [ ] 节点执行 `zako-agent --version` 与 `/dl/agent/version` 一致
- [ ] 面板上节点状态为 `online`
- [ ] 节点上线后，节点上 `/var/lib/zako-agent/users.json` 已出现有效用户的 `xray_email`
- [ ] `127.0.0.1:10085` 仅监听本地环回，不对外暴露

**订阅与计费闭环**
- [ ] 请求 `/sub/{token}/clash.yaml` 能拿到 YAML，响应头带有 `subscription-userinfo`
- [ ] 客户端导入能正常连通代理，等一个上报周期（默认 15 分钟）后后台流量图表有增长
- [ ] 停用用户或节点后，新订阅不再包含该节点，节点上也会移除对应用户凭据
