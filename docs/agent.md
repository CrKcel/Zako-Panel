# 节点 Agent 工作原理

Agent 是跑在节点（Debian 12/13）上的独立 Go 二进制，由 `systemd` 托管。它只做两件事：**向控制面报平安/报流量**，以及**按控制面的指令更新本地 Xray 用户和配置**。

安装和上线步骤见 [deployment.md](deployment.md)，流量采样细节见 [traffic.md](traffic.md)。

---

## 1. 运行原则

- **只出不进**：Agent 只主动向控制面发 HTTPS 请求，不在节点上开任何公网监听端口；和 Xray 的 gRPC 通信只走 `127.0.0.1`。
- **私钥不出节点**：REALITY 私钥在安装时生成并留在 `/etc/xray/reality.key`，控制面只存公钥，永远拿不到私钥。
- **本地有账本**：采样基线、未发出去的流量报表、当前版本号都存在 BoltDB（`/var/lib/zako-agent/state.db`），节点重启不会丢账。
- **能热更新就不重启**：增删用户优先走 Xray gRPC 热更新，不断掉现有代理连接；只有热更新失败或整份配置改了才重启 Xray。

---

## 2. 常用路径与配置项

主配置文件默认在 `/etc/zako-agent/config.yaml`：

| 配置项 | 作用 | 默认值 |
| --- | --- | --- |
| `control_plane_url` | 控制面域名 | 必填 |
| `node_id` | 节点 ID | 必填 |
| `agent_token_file` | 节点认证 Token 文件 | `/etc/zako-agent/token` |
| `state_path` | BoltDB 本地状态库 | `/var/lib/zako-agent/state.db` |
| `users_path` | 上次成功生效的用户快照 | `/var/lib/zako-agent/users.json` |
| `xray_config_path` | Xray 配置文件 | `/etc/xray/config.json` |
| `xray_binary_path` | Xray 可执行文件 | `/usr/local/bin/xray` |
| `reality_private_key_path` | 本地 REALITY 私钥 | `/etc/xray/reality.key` |
| `xray_api_address` | Xray gRPC 地址 | `127.0.0.1:10085` |
| `xray_inbound_tag` | 代理入站 Tag | `vless-reality` |
| `heartbeat_interval` | 心跳间隔（服务端可动态下发覆盖） | `5m` |
| `collector.sample_interval` | 采集 Xray 流量间隔 | `30s` |
| `collector.report_interval` | 上报流量间隔 | `15m` |

---

## 3. 用户名单怎么同步（热更新与回退）

1. **发现变化**：控制面每次修改用户授权、配额超限或到期，都会把全局版本号 `users_ver` 加 1。Agent 心跳时看到服务端返回的 `users_ver` 和自己手里不一样，就触发一次同步。
2. **省流拉取**：Agent 带上本地版本号作为 `If-None-Match` 请求 `GET /api/v1/agent/users`。如果版本其实没变，服务端直接返回 `304 Not Modified`。
3. **算差集并热更新**：对比新名单和本地 `users.json`，算出要新增、删除的用户（UUID 变了就先删后加），调用 Xray gRPC `HandlerService.AlterInbound`（`RemoveUser` / `AddUser`）动态修改，然后原子更新 `users.json` 和版本号。
4. **万一热更新失败（安全回退）**：
   如果 gRPC 调用失败，Agent 会自动切到“改文件 + 重启”模式：
   - 把新用户列表和本地私钥拼进完整的 Xray 配置；
   - 先跑 `xray run -test -config` 确认语法没问题；
   - 原子替换 `/etc/xray/config.json` 并执行 `systemctl restart xray.service`；
   - 检查 `StatsService` 是否健康；如果重启失败或健康检查没过，立刻还原旧配置再重启一次。

> 整个同步和改配置过程都受全局互斥锁保护，同步期间如果又来了新触发，会合并成一次后续执行，不会并发打架。

---

## 4. 远程下发 Xray 配置

除了增删用户，管理员还可以在面板给节点下发新的 Xray 全局配置版本（只包含网络、路由、策略等通用 JSON，不含私钥和用户）。

```mermaid
sequenceDiagram
    participant W as 控制面 Worker
    participant A as 节点 Agent
    participant X as Xray-core

    A->>W: 心跳上报 (applied_config_version)
    W-->>A: 返回 desired_config_version
    A->>W: GET /api/v1/agent/config
    W-->>A: 返回规范化 JSON + SHA-256 哈希
    A->>A: 校验哈希 → 注入本地私钥与当前用户
    A->>X: xray run -test 校验语法
    X-->>A: 校验通过
    A->>A: 备份旧配置并原子替换 config.json
    A->>X: 重启 Xray 并做健康检查
    A->>W: POST /api/v1/agent/config/result (applied / failed)
```

Agent 内部按以下状态流转：`IDLE → DOWNLOADING → VERIFYING → RENDERING → TESTING → APPLYING → OBSERVING → APPLIED / FAILED`：

- **防篡改**：下载完先比对 SHA-256 哈希，对不上直接中止，不会往 Xray 里塞。
- **防失联**：替换前会留一份已知健康的旧配置备份。不管是 `xray run -test` 报错、重启超时，还是重启后观察期健康检查失败，都会自动还原旧配置并把错误信息报回面板。
- **结果幂等**：同一版本无论成功还是失败，都会带着版本号上报；旧版本的延迟结果不会覆盖控制面较新的状态。

---

## 5. 节点权限隔离（最小特权）

Agent 不以 `root` 运行，而是用专用低权限用户 `zako-agent` 启动（`NoNewPrivileges=true`）：

- `/etc/xray` 目录属主为 `root:zako-agent`（权限 `0770`），允许 Agent 通过写临时文件 + rename 原子替换 `config.json`（`0640`）。
- 私钥 `/etc/xray/reality.key` 和用户快照 `/var/lib/zako-agent/users.json` 权限都是 `0600`，仅 `zako-agent` 可读。
- 重启 Xray 不靠 `sudo`，而是通过一条专用 polkit 规则（`/etc/polkit-1/rules.d/50-zako-agent-xray.rules`），只允许 `zako-agent` 执行 `systemctl restart xray.service`。
- 远程自卸载同样通过该 polkit 规则授权：收到控制面 `uninstall` 指令后，Agent 向 `/api/v1/agent/uninstall` 回传确认，再触发以 `root` 运行的 `zako-agent-uninstall.service` 完成系统目录、systemd 单元、polkit 规则与服务账号的清理。

> 节点上排查问题时，主要看 `journalctl -u zako-agent -f` 和 `journalctl -u xray -f`。
