# 系统部署、分发与上线验证

系统部署包含三个独立组成部分：控制面板（Cloudflare Worker + D1 + Web 静态资产）、分发节点（静态资产 Downloads Worker）与节点端服务（Debian + Xray + Go Agent）。架构边界详见 [architecture.md](architecture.md)，安全策略详见 [security.md](security.md)。

## 1. 控制面板部署

### 1.1 配置准备

控制面通过 `wrangler.jsonc` 进行定义：
- 入口文件配置为 `apps/worker/src/index.ts`。
- 前端静态资产目录指向 `apps/web/dist`，单页应用路由未找到策略设为 `single-page-application`。
- 仅将 `/api/*` 与 `/sub/*` 规则加入 `assets.run_worker_first`，前端路由直接由边缘直接响应。
- 绑定 D1 数据库资源 `zako-panel` 并填写真实 `database_id`。
- 声明两个定时触发器：`*/15 * * * *`（执行周期推进与状态判定）与 `17 3 * * *`（每日执行保留期物理清理）。

环境变量与访问控制要求：
- 生产环境配置 `ENVIRONMENT=production`，以及 Cloudflare Access 相关配置项 `ACCESS_TEAM_DOMAIN` 与 `ACCESS_AUD`。
- Cloudflare Access 保护路径设定为 `/admin/*` 与 `/api/v1/admin/*`。
- 订阅端点（`/sub/*`）、Agent 端点（`/api/v1/agent/*`）及分发端点（`/dl/*`）必须排除在 Access 拦截范围之外。

### 1.2 部署与初始化流程

执行数据库创建、迁移及应用部署：

```bash
npx wrangler d1 create zako-panel
# 将控制台输出的 database_id 填入 wrangler.jsonc
npx wrangler d1 migrations apply zako-panel --remote
npm run deploy
```

部署完成后运行系统初始化脚本，创建首任超级管理员（`owner`）、默认订阅档案与基础元数据：

```bash
npm run bootstrap -- --email admin@example.com
npx wrangler d1 execute zako-panel --remote --file=bootstrap.sql
```

终端将打印订阅 Token 明文一次，请妥善保存。生成的 `bootstrap.sql` 随后应及时清理。

## 2. Agent 分发与 Downloads Worker

Agent 安装包采用独立轻量化的 Downloads Worker 托管在 `/dl/agent/*` 路径下，通过稳定 URL 实现滚动版本分发。

### 2.1 分发资产与端点规划

稳定分发端点清单：
- `/dl/agent/install.sh`：一键网络安装引导脚本。
- `/dl/agent/SHA256SUMS`：安装脚本与安装包的 SHA-256 哈希校验清单。
- `/dl/agent/version`：当前稳定发布版本号纯文本。
- `/dl/agent/zako-agent-linux-amd64.tar.gz`：适用于 x86_64 架构的安装归档。
- `/dl/agent/zako-agent-linux-arm64.tar.gz`：适用于 aarch64 架构的安装归档。

### 2.2 发布流水线与版本管理

1. 由代码仓库 `agent-v*` 格式的 Git 标签触发自动化发布流水线。
2. 流水线执行跨平台静态交叉编译（`CGO_ENABLED=0`，目标 `linux/amd64` 与 `linux/arm64`），注入版本号并打包示例模板、服务单元及 polkit 规则。
3. 生成 `SHA256SUMS` 校验清单并更新静态分发目录。
4. 使用 `wrangler deploy --config wrangler.downloads.jsonc` 发布 Downloads Worker。
5. 缓存控制：所有稳定文件声明 `Cache-Control: public, max-age=0, must-revalidate` 与 `ETag`，确保版本更新即刻生效。
6. 回滚操作：在新版本出现异常时，可通过 Cloudflare 控制台或运行 `npx wrangler rollback --config wrangler.downloads.jsonc` 快速回退分发版本。

## 3. 节点安装与配置维护

节点运行环境支持 Debian 12 与 Debian 13，需预先安装 Xray-core、`curl`、`tar` 与 CA 证书。

### 3.1 一键网络安装

在节点执行以下命令完成安装：

```bash
curl -fsSL https://332711.xyz/dl/agent/install.sh | sudo bash -s
```

安装脚本自动完成以下配置：
- 安装可执行文件至 `/usr/local/bin/zako-agent`，创建低权限系统用户与用户组 `zako-agent`。
- 创建目录 `/etc/zako-agent` 与 `/var/lib/zako-agent`（权限 `0700`）。
- 部署 systemd 单元 `zako-agent.service` 与 polkit 权限规则 `/etc/polkit-1/rules.d/50-zako-agent-xray.rules`。
- 设置 `/etc/xray` 目录属组为 `zako-agent` 且权限为 `0770`，以满足配置原子替换要求。
- 自动生成 REALITY 私钥保存至 `/etc/xray/reality.key`（权限 `0600`），并在终端输出公钥。
- 自动渲染 `/etc/xray/config.json` 写入私钥与随机 short-id。

### 3.2 节点初始化与服务启动

1. 在控制面板创建节点，获取一次性 Agent Bearer Token。
2. 将 Token 写入节点 `/etc/zako-agent/token`，属主设为 `zako-agent`，权限设为 `0600`。
3. 编辑 `/etc/zako-agent/config.yaml`，填入 `control_plane_url` 与 `node_id`。
4. 将安装时输出的 REALITY 公钥与 short-id 录入控制面板对应节点的 endpoint 配置中。
5. 启动服务并观察日志：

```bash
sudo systemctl start zako-agent
journalctl -u zako-agent -f
```

节点升级直接重新执行一键安装命令，随后执行 `sudo systemctl restart zako-agent`。

## 4. 上线验证清单

在将服务正式提供给用户使用前，按照以下清单逐项验证：

### 4.1 控制面与身份验证

- [ ] D1 迁移执行完整，`bootstrap` 初始数据导入完成。
- [ ] 访问管理界面（`/admin/`）正常重定向至 Cloudflare Access 登录认证。
- [ ] 未经 Access 认证访问管理 API（`/api/v1/admin/nodes`）返回 `401 Unauthorized`。
- [ ] 订阅端点（`/sub/*`）与分发端点（`/dl/*`）未受 Access 拦截阻断。
- [ ] 定时触发器（每 15 分钟与每日）注册成功。

### 4.2 节点通信与凭据同步

- [ ] 节点一键安装脚本执行成功，`zako-agent --version` 与远端分发版本一致。
- [ ] Agent 启动后正常完成心跳上报，控制面板节点状态显示为 `online`。
- [ ] 在控制面板为用户授权节点后，Agent 用户同步循环成功更新 `/var/lib/zako-agent/users.json`。
- [ ] Xray 运行配置中已包含该用户的 `xray_email`，StatsService 仅监听 `127.0.0.1:10085`。

### 4.3 订阅生成与流量闭环

- [ ] 请求 Clash 订阅端点（`/sub/{token}/clash.yaml`）成功获取包含可用节点的 YAML 文档。
- [ ] 响应标头 `subscription-userinfo` 包含正确的用量与到期时间指标。
- [ ] 客户端导入订阅配置后能够成功建立代理连接。
- [ ] 客户端产生流量后，等待一个结算周期，控制面板与流量图表显示用量正常递增。
- [ ] 停用节点或用户停用后，下一次订阅请求与节点入站同步均及时阻断失效凭据。
