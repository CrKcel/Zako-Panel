# 安全设计

安全边界依赖 Cloudflare Access、D1 中的角色记录和节点本地的密钥管理。Access 策略与节点密钥的部署步骤见 [deployment.md](deployment.md)，可观测性相关的脱敏要求见 [operations.md](operations.md)。

## 1. 管理员

- Cloudflare Access 保护 `/admin/*` 与 `/api/v1/admin/*`。
- Worker 使用 Access JWKS 验证 JWT 签名、issuer、audience、过期与生效时间；不信任可伪造的 email header。
- `admin_users` 决定角色与启用状态；禁用后即使 Access 身份有效也不能调用管理 API。
- 角色：`owner` 管理管理员与全部资源，`admin` 管理节点、订阅与配置，`viewer` 只读。
- Access 路径策略排除 `/sub/*` 与 `/api/v1/agent/*`。

## 2. Token 与敏感信息

- Agent 与订阅 token 至少 256-bit 随机数，使用 URL 安全编码。
- D1 只存 SHA-256；明文只在创建或轮换响应中出现一次，不落日志、分析事件或错误堆栈。
- Agent token 格式 `Bearer <node_id>.<secret>`；Worker 先按节点 ID 查询，再对 secret 做 SHA-256 与恒定时间比较。
- 轮换后更新节点上的 token 文件并重启 Agent；旧 token 立即失效。
- token、REALITY 私钥、Agent 状态文件与用户集合的权限为 0600。
- 订阅 URL 视为秘密，不写入第三方统计，不发送 Referer。
- REALITY 私钥只在节点本地保存；Worker 只保存公钥。
- VLESS UUID 是代理凭据，只出现在必要的订阅与配置响应中。

## 3. 节点与输入

- 防火墙只开放必要的 Xray 端口与受限 SSH；StatsService、HandlerService 仅 loopback。
- SQL 全部参数绑定；YAML 正规序列化；URI 正确百分号编码。
- 限制订阅节点数、规则大小、Agent 请求体与报表条目数；超限返回 `413`。
- WAF 对 `/sub/*` 与 `/api/v1/agent/*` 配置限流；失败请求不写高基数 D1 日志。
- Agent 通过 systemd 限制写路径，仅允许写 `/var/lib/zako-agent` 与 `/etc/xray`；Xray 校验与重启使用固定命令。
- 配置错误不能破坏最近已知可用版本；P2 不提供任意命令执行。
