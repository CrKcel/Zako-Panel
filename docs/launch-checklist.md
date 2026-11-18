# 上线检查表

按顺序逐项确认后再开放流量。命令细节见 [deployment.md](deployment.md)，Agent 分发见 [agent-distribution.md](agent-distribution.md)，密钥与权限规则见 [security.md](security.md)，额度与容量目标见 [operations.md](operations.md)。

## 1. 面板

- [ ] D1 数据库已创建，`wrangler.jsonc` 的 `database_id` 已替换为实际值。
- [ ] `npx wrangler d1 migrations apply zako-panel --remote` 执行成功。
- [ ] `npm run deploy` 完成；`https://<域名>/admin/` 返回管理界面。
- [ ] `assets.run_worker_first` 只包含 `/api/*` 与 `/sub/*`；SPA 深链接由静态资源直接返回，不经过 Worker。
- [ ] `_headers` 生效：CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；`/admin/assets/*` 为 immutable 缓存。
- [ ] `_redirects` 生效：`/` 302 到 `/admin/`，`/admin/assets/*` 重写到 `/assets/*`。
- [ ] `wrangler.downloads.jsonc` 的 route `332711.xyz/dl/*` 已随部署创建。
- [ ] `/dl/*` 由 Downloads Worker 处理，不落面板 SPA；面板 Worker 未因 Agent 发布而重新部署。
- [ ] `*/15 * * * *` 与 `17 3 * * *` 两个 Cron 已随部署注册。

## 2. Access 与身份

- [ ] Access 应用覆盖 `/admin/*` 与 `/api/v1/admin/*`。
- [ ] Access 策略排除 `/sub/*`、`/api/v1/agent/*` 与 `/dl/*`。
- [ ] `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ENVIRONMENT=production` 已设置。
- [ ] 部署变量中没有 `DEV_ADMIN_EMAIL`。
- [ ] `bootstrap` 创建的 owner 邮箱与 Access 身份一致，且在 `admin_users` 中为启用状态。
- [ ] 未携带 Access 凭据访问 `/api/v1/admin/nodes` 返回 `401`。

## 3. 初始化数据

- [ ] `npm run bootstrap -- --email <owner>` 已执行；订阅 token 只在输出中出现一次，已存入密码管理器。
- [ ] `bootstrap.sql` 已导入远端 D1，本地文件随后删除。
- [ ] `admin_users`、`subscription_profiles`、`subscribers`、`subscriptions`、`subscriber_usage` 各有一行。
- [ ] `meta` 中存在 `users_ver` 与 `default_subscriber_id`。

## 4. 节点与 REALITY

- [ ] `/dl/agent/version` 返回纯文本版本号；不存在路径返回 `404`，不返回 HTML 200。
- [ ] tarball 返回 `application/gzip`、`must-revalidate`、`ETag` 与 `Content-Disposition`。
- [ ] `curl -fsSL https://<域名>/dl/agent/install.sh | sudo bash -s` 在节点执行成功。
- [ ] `zako-agent --version` 与 `/dl/agent/version` 一致。
- [ ] `xray x25519` 输出的公钥已录入 endpoint 的 `public_key`。
- [ ] 随机 short id 与 `/etc/xray/config.json` 的 `shortIds` 一致；配置权限 `0640`、属组 `zako-agent`。
- [ ] `/etc/xray` 目录为 `root:zako-agent`、`0770`。
- [ ] `/etc/xray/reality.key` 权限 `0600`、属 `zako-agent`，且只存在于节点本地。
- [ ] `/etc/polkit-1/rules.d/50-zako-agent-xray.rules` 已安装，`zako-agent` 能执行 `systemctl restart xray.service`。
- [ ] `xray run -test -config /etc/xray/config.json` 通过。
- [ ] `/etc/zako-agent/token` 已写入面板签发的 Agent token，权限 `0600`、属 `zako-agent`。
- [ ] `/etc/zako-agent/config.yaml` 的 `control_plane_url`、`node_id`、`xray_api_address` 与节点实际监听一致；`xray_inbound_tag` 与配置中 VLESS 入站的 `tag` 一致。
- [ ] Agent 首次用户同步后 `/var/lib/zako-agent/users.json` 存在，权限 `0600`。
- [ ] Agent 首次用户同步后，`/etc/xray/config.json` 的 VLESS 入站 `clients` 与面板该节点的用户集合一致。
- [ ] StatsService 与 HandlerService 只监听 loopback，公网未暴露 `10085`。
- [ ] `systemctl start zako-agent` 后日志有成功上报，没有 `401`/`403`。

## 5. 订阅用户与管理员

- [ ] 在面板创建订阅用户并授权节点后，该用户的 `xray_email` 在下一次心跳后的同步中出现于节点入站 `clients`。
- [ ] 停用该用户后 `users_ver` 递增，其 `xray_email` 在下一次同步中从入站 `clients` 移除。
- [ ] 取消节点授权后，`/api/v1/admin/nodes/{nodeId}/clients` 不再返回启用记录，入站同步移除该用户。
- [ ] `PATCH /api/v1/admin/subscribers/{subscriberId}` 用 `limited` 或 `expired` 作为 `status` 时返回参数校验错误。
- [ ] `owner` 可新增与修改管理员；`admin` 与 `viewer` 调用管理员接口返回 `403`。
- [ ] 尝试停用或降级最后一个启用的 `owner` 返回 `409`。
- [ ] `GET /sub/{token}/clash.yaml` 的 `subscription-userinfo` 与面板展示的已用流量、额度一致。

## 6. 订阅与客户端

- [ ] 首次心跳后 `/api/v1/admin/nodes/{nodeId}/status` 返回 `online`。
- [ ] `/sub/{token}/clash.yaml` 返回 `200`，包含该节点且 `subscription-userinfo` 有值。
- [ ] Clash.Meta 导入配置后能建立连接并访问外网。
- [ ] `/sub/{token}/uri?encoding=base64` 可被目标客户端导入。
- [ ] 停用全部节点后订阅返回 `503`，不下发空配置。

## 7. 流量与幂等

- [ ] Agent 上报后节点流量进入小时桶，跨过小时边界后能在流量页看到。
- [ ] 同一 `report_id` 重复提交返回相同 ACK，流量不重复计数。
- [ ] 重启 Xray 后不产生负流量，`has_counter_gap` 与预期一致。
- [ ] 重装 Agent 后新报表继续入账。
- [ ] 重新执行安装命令后，配置、token、状态库、REALITY 私钥与 `users.json` 保留；服务已运行时提示重启。
- [ ] 回滚 Downloads Worker 或重跑上一个 `agent-v*` tag 后，稳定 URL 恢复上一版本。

## 8. 容量与观测

- [ ] `npm run capacity` 通过（100 节点、100 用户-节点组合、50 用户、500 条规则）。
- [ ] 部署后面板确认 Worker CPU、D1 行读取与行写入在免费额度内。
- [ ] 告警覆盖 Worker 请求与 CPU、D1 读写、节点离线、配置连续失败与 Cron 失败。
- [ ] Worker 与 Agent 日志中不含 token、订阅 URL、UUID 与请求体。
- [ ] Downloads Worker 单文件低于 25 MiB，版本文件数低于 20,000；静态请求未计入 Worker 请求。

## 9. 安全复核

- [ ] D1 中不存在 REALITY 私钥字段与明文 token。
- [ ] `/sub/*`、`/api/v1/agent/*` 与 `/dl/*` 已配置 WAF 限流。
- [ ] `/dl/*` 为公开只读，未经过 Access；产物中不含 token、私钥与状态文件。
- [ ] 节点防火墙只开放代理端口与受限 SSH。
- [ ] `bootstrap.sql`、`.dev.vars`、Agent 状态文件均未提交到仓库。
