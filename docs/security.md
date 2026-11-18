# 安全设计

安全边界依赖 Cloudflare Access、D1 中的角色记录和节点本地的密钥管理。Access 策略与节点密钥的部署步骤见 [deployment.md](deployment.md)，Agent 下载分发见 [agent-distribution.md](agent-distribution.md)，可观测性相关的脱敏要求见 [operations.md](operations.md)。

## 1. 管理员

- Cloudflare Access 保护 `/admin/*` 与 `/api/v1/admin/*`。
- Worker 使用 Access JWKS 验证 JWT 签名、issuer、audience、过期与生效时间；不信任可伪造的 email header。
- `admin_users` 决定角色与启用状态；禁用后即使 Access 身份有效也不能调用管理 API。
- 角色：`owner` 管理管理员与全部资源，`admin` 管理节点、订阅与配置，`viewer` 只读。
- Access 路径策略排除 `/sub/*`、`/api/v1/agent/*` 与 `/dl/*`。
- 本地开发没有 Access 代理：仅当同时设置 `ENVIRONMENT=development` 与 `DEV_ADMIN_EMAIL` 时，未携带 Access JWT 的管理请求按该邮箱鉴权；携带 JWT 的请求仍走 JWKS 校验。部署变量不得包含这两项。

## 2. Token 与敏感信息

- Agent 与订阅 token 至少 256-bit 随机数，使用 URL 安全编码。
- D1 只存 SHA-256；明文只在创建或轮换响应中出现一次，不落日志、分析事件或错误堆栈。
- Agent token 格式 `Bearer <node_id>.<secret>`；Worker 先按节点 ID 查询，再对 secret 做 SHA-256 与恒定时间比较。
- 轮换后更新节点上的 token 文件并重启 Agent；旧 token 立即失效。
- token、REALITY 私钥、Agent 状态文件与用户集合的权限为 0600。
- 订阅 URL 视为秘密，不写入第三方统计，不发送 Referer。
- REALITY 私钥只在节点本地保存；Worker 只保存公钥。
- VLESS UUID 是代理凭据，只出现在订阅响应、节点凭据接口与节点本地配置中。节点凭据接口经 Access 鉴权并要求 `viewer` 及以上角色；档案预览使用占位 UUID，不返回真实凭据。

## 3. 节点与输入

- 防火墙只开放必要的 Xray 端口与受限 SSH；StatsService、HandlerService 仅 loopback。
- SQL 全部参数绑定；YAML 正规序列化；URI 正确百分号编码。
- 限制订阅节点数、规则大小、Agent 请求体与报表条目数；超限返回 `413`。
- WAF 对 `/sub/*`、`/api/v1/agent/*` 与 `/dl/*` 配置限流；失败请求不写高基数 D1 日志。
- Agent 通过 systemd 限制写路径，仅允许写 `/var/lib/zako-agent` 与 `/etc/xray`；Xray 校验与重启使用固定命令。
- 配置错误不能破坏最近已知可用版本；P2 不提供任意命令执行。

### 3.1 Agent 运行权限

- Agent 以 `zako-agent` 系统用户运行，systemd 单元保持 `NoNewPrivileges=true`，不授予 capability，也不需要 root。
- 重启权限来自 polkit 规则 `/etc/polkit-1/rules.d/50-zako-agent-xray.rules`：仅当发起用户为 `zako-agent`、目标单元为 `xray.service`、动作为 `restart` 时返回允许；其他单元与 `stop` 等动作不受该规则授权。
- `/etc/xray` 目录为 `root:zako-agent`、`0770`。Agent 以同目录临时文件加 rename 替换 `config.json`，因此需要目录写权限而非文件写权限。
- `/etc/xray/config.json` 为 `0640`、属组 `zako-agent`；`/etc/xray/reality.key` 与 `/etc/zako-agent/token` 为 `0600`；用户集合文件 `/var/lib/zako-agent/users.json` 为 `0600`。
- 安装脚本负责创建目录权限与 polkit 规则，权限被手工改动后热更新回退路径会失败。

## 4. Agent 分发

- `/dl/*` 公开只读，不经过 Access。Agent 二进制不包含 token、私钥或面板地址；节点接入控制面仍依赖本地 Agent token 与配置。
- Downloads Worker 为 assets-only，没有 Worker 脚本与 D1 binding；静态资产由 Cloudflare 直接返回。
- 发布产物只包含二进制、示例配置、systemd unit、安装脚本、polkit 规则与 Xray 模板。打包测试检查 `token`、`state.db`、`reality.key` 与 `.dev.vars` 不在归档中。
- 稳定下载 URL 使用 `Cache-Control: public, max-age=0, must-revalidate` 与 ETag；不使用 immutable。
- `/dl/*` 配置 WAF 限流；下载日志不包含凭据。
- 发布 tag 不可移动；回滚使用 Downloads Worker 的 Cloudflare 版本回滚，或重跑上一个 tag。
- 网络安装脚本以 root 执行，首次安装前应下载并检查脚本；校验依赖 HTTPS 与同源的 `SHA256SUMS`。
