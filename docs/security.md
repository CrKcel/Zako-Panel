# 安全模型与敏感数据边界

项目的安全设计围绕一个核心目标：**即使控制面数据库或某一台节点被攻破，影响也尽量被锁死在最小范围**。

---

## 1. 管理员访问控制

- **网关拦截**：管理后台（`/admin/*`）和管理接口（`/api/v1/admin/*`）全部放在 Cloudflare Access 后面。
- **JWT 验签**：Worker 通过 Cloudflare Access 的 JWKS 公钥端点校验 JWT 的签名、颁发者（`ACCESS_TEAM_DOMAIN`）、受众（`ACCESS_AUD`）和有效期，不信任任何未验签的请求头。
- **简化身份**：面板侧不再维护独立管理员表或细粒度角色，通过 Access 认证的邮箱直接作为管理员身份记录进审计日志。
- **路径放行**：订阅（`/sub/*`）、Agent 上报（`/api/v1/agent/*`）和静态安装包下载（`/dl/*`）必须排除在 Access 拦截之外，它们各自用独立 Token 或静态策略鉴权。

---

## 2. 密钥、Token 与私钥存放边界

| 敏感数据 | 存放在哪 | 安全措施 |
| --- | --- | --- |
| REALITY 私钥 | **只在节点本地**（`/etc/xray/reality.key`，权限 `0600`） | 永远不上传控制面；控制面只存公钥和 `short_id` |
| Agent Token / 注册 Token / 订阅 Token | **D1 只存 SHA-256 哈希** | 至少 256 位随机熵，明文只在创建或轮换响应里返回一次 |
| VLESS UUID | D1 `node_clients` 表 + 节点 `users.json` | 只在订阅下发、节点授权和节点同步时出现；档案预览全部替换成占位符 |
| 请求日志 | Worker / Agent 日志 | 严禁打印 Token、订阅 URL、UUID 和完整请求体 |

> **防时序攻击**：Agent 常规 Token 格式为 `Bearer <node_id>.<secret>`。服务端先按 `node_id` 查出节点，再对 `secret` 算 SHA-256 并做常数时间比对。

---

## 3. 节点与分发隔离

- **节点最小网络面**：节点防火墙只需放行代理端口和管理员 SSH；Xray 的 `StatsService` 和 `HandlerService` 严格绑定在 `127.0.0.1`，不暴露到公网。
- **Agent 非 root 运行**：以专用系统用户 `zako-agent` 运行并开启 `NoNewPrivileges=true`，仅通过一条限定服务名的 polkit 规则重启 `xray.service`。
- **禁止远程执行 Shell**：控制面只能下发结构化 Xray 配置 JSON，没有任意命令执行通道；请求体也会限制大小（如单次上报上限 64 KB、最多 40 个用户条目），超限直接返回 `413`。
- **Downloads Worker 隔离**：安装脚本与二进制分发跑在独立的纯静态 Worker 上，不绑数据库、不跑业务逻辑；安装脚本执行前强制校验同源 `SHA256SUMS`，对不上立即中止。
