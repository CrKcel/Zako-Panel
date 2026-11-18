# Agent 分发

Agent 二进制由独立的 assets-only Downloads Worker 提供，挂在面板域名的 `/dl/agent/*` 路径下。发布采用滚动方式：稳定 URL 始终指向当前版本，版本号用于构建与诊断，tag 用于回滚。节点安装与升级步骤见 [deployment.md](deployment.md)，下载安全边界见 [security.md](security.md)，资产额度与回滚见 [operations.md](operations.md)。

## 1. 分发模型

- Downloads Worker 名称 `zako-agent-downloads`，配置在 `wrangler.downloads.jsonc`。
- Worker 没有 `main`，只包含 `apps/downloads/dist` 下的静态资产；静态请求由 Cloudflare 直接返回，不计 Worker 请求与 CPU。
- 路由 `332711.xyz/dl/*` 指向 Downloads Worker。Cloudflare 按具体程度匹配 route，`/dl/*` 优先于面板 Worker 的 `/` 或 Custom Domain；面板 Worker 的 SPA fallback 与路由配置保持不变，Access 需排除 `/dl/*`。
- `assets.not_found_handling` 为 `none`，缺失路径返回空 body 的 404。
- 面板 Worker 不处理 `/dl/*`，Agent 发布也不会触发面板部署。

发布流水线见 [GitHub Actions](../.github/workflows/release-agent.yml)。tag 只用于构建与回滚，不进入下载 URL。

## 2. 资产与 URL

稳定 URL：

| URL | 内容 |
| --- | --- |
| `/dl/agent/install.sh` | 当前网络安装脚本 |
| `/dl/agent/SHA256SUMS` | 当前 `install.sh` 与两个 tarball 的 SHA-256 |
| `/dl/agent/version` | 当前版本号，纯文本 |
| `/dl/agent/zako-agent-linux-amd64.tar.gz` | amd64 安装包 |
| `/dl/agent/zako-agent-linux-arm64.tar.gz` | arm64 安装包 |

`apps/downloads/dist` 是生成目录，不提交到仓库：

```text
apps/downloads/dist/
  _headers
  dl/agent/install.sh
  dl/agent/SHA256SUMS
  dl/agent/version
  dl/agent/zako-agent-linux-amd64.tar.gz
  dl/agent/zako-agent-linux-arm64.tar.gz
```

tarball 使用稳定的顶层目录，安装脚本不需要解析版本路径：

```text
zako-agent/
  zako-agent
  install.sh
  config.example.yaml
  systemd/zako-agent.service
  polkit/50-zako-agent-xray.rules
  lib/reality-key.sh
  xray/config.example.json
  xray/render-config.py
  VERSION
```

`VERSION` 与二进制 `--version` 由发布 tag 注入。`/dl/agent/version` 与 tarball 内部 `VERSION` 必须一致；安装脚本会在运行安装逻辑前校验。

## 3. 发布

发布由 `agent-v*` tag 触发：

1. 在 `apps/agent` 执行 `go test ./...`。
2. 使用 `CGO_ENABLED=0` 交叉编译 `linux/amd64` 与 `linux/arm64`，`-ldflags "-X main.version=<version>"` 注入版本。
3. `deploy/package-release.sh` 生成稳定命名的 tarball。
4. `deploy/netinstall.sh` 渲染为当前安装脚本，写入 `AGENT_DOWNLOAD_BASE_URL`。
5. `deploy/stage-downloads.sh` 生成 `apps/downloads/dist`，写入 `version` 与 `SHA256SUMS`。
6. `wrangler deploy --config wrangler.downloads.jsonc` 部署 Downloads Worker。
7. 部署后检查 `/dl/agent/version`、缓存头与 404 行为。

首次发布前：

- 确认 `wrangler.downloads.jsonc` 的 route 为 `332711.xyz/dl/*`、zone 为 `332711.xyz`；换域名要同步改这两项并重发版本，安装脚本里的下载地址在发布时写入。
- 设置 GitHub secret `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit、Workers Routes:Edit、Zone:Read）与 `CLOUDFLARE_ACCOUNT_ID`。
- 设置 GitHub variable `AGENT_DOWNLOAD_BASE_URL=https://332711.xyz/dl/agent`。
- 确认 `/dl/*` 未进入 Cloudflare Access。

发布命令：

```bash
git tag agent-v0.1.0
git push origin agent-v0.1.0
```

## 4. 缓存与 404

`apps/downloads/public/_headers` 随资产部署：

- 所有稳定文件：`Cache-Control: public, max-age=0, must-revalidate` 与 `X-Content-Type-Options: nosniff`。
- 安装脚本、版本文件与校验文件显式设置文本类型；tarball 设置 `application/gzip` 与 `Content-Disposition: attachment`。
- 不使用 immutable 缓存。Cloudflare 的静态资产 ETag 支持条件请求：内容未变返回 304，发布后返回新内容。
- 缺失文件由 `not_found_handling: none` 返回 404，不会落到面板 SPA。

滚动发布期间，如果安装脚本在下载 `SHA256SUMS` 与 tarball 之间遇到部署切换，校验会失败。安装脚本会重新下载两者一次；第二次失败时退出，不执行安装逻辑。

## 5. 安装与升级

节点需要 Debian 12/13、root、`curl` 或 `wget`、`tar`、`coreutils` 与 CA 证书。

```bash
curl -fsSL https://332711.xyz/dl/agent/install.sh | sudo bash -s
```

需要检查脚本时：

```bash
curl -fsSLo /tmp/zako-agent-install.sh https://332711.xyz/dl/agent/install.sh
less /tmp/zako-agent-install.sh
sudo bash /tmp/zako-agent-install.sh
```

安装脚本完成以下工作：

- 检测 `amd64`/`arm64`，不支持时直接退出。
- 下载当前 `version`、`SHA256SUMS` 与 tarball，校验 SHA-256。
- 解压并核对 tarball `VERSION` 与二进制 `--version`。
- 执行 tarball 内的 `install.sh`，复用现有的服务用户、目录、systemd unit、polkit 规则、REALITY 密钥与 Xray 模板逻辑。
- 保留已有的 `/etc/zako-agent/config.yaml`、`/etc/zako-agent/token`、`/var/lib/zako-agent/state.db` 与 `/etc/xray/reality.key`。
- 安装并 enable 服务，不自动启动；服务已运行时提示 `systemctl restart zako-agent`，未运行时提示 `systemctl start zako-agent`。

升级使用同一命令。当前版本由 `/dl/agent/version` 提供，安装脚本会在开始前打印。

## 6. 回滚

发布失败或新版本异常时，回滚 Downloads Worker 到上一个部署：

```bash
npx wrangler rollback --config wrangler.downloads.jsonc
```

也可以在 Cloudflare 控制台选择上一个 Worker 版本。回滚恢复上一个稳定 URL 内容，面板 Worker 不受影响。

另一种方式是用上一个 tag 重新运行 `Release agent` 流水线，重新构建并覆盖稳定资产。下载 URL 不提供版本固定参数，节点始终安装当前稳定版本。

## 7. 验证

```bash
curl -fsS https://332711.xyz/dl/agent/version
curl -fsSI https://332711.xyz/dl/agent/zako-agent-linux-amd64.tar.gz
curl -fsSI https://332711.xyz/dl/agent/install.sh
curl -s -o /dev/null -w '%{http_code}\n' https://332711.xyz/dl/agent/missing.tar.gz
```

预期：

- `version` 返回纯文本版本号。
- tarball 返回 `200`、`application/gzip`、`Content-Disposition: attachment`、`ETag` 与 `must-revalidate`。
- `install.sh` 返回 `text/x-shellscript`。
- 缺失路径返回 `404`。
- 路径返回 HTML 且状态为 `200` 时，`/dl/*` 路由未生效或 Access 正在拦截，按 [deployment.md](deployment.md) 检查 route 与 Access 排除。

## 参考

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static Assets 默认响应头与 `_headers`](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Workers Routes 匹配与优先级](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Workers 限制：静态资产文件数与单文件大小](https://developers.cloudflare.com/workers/platform/limits/)
