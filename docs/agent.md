# 节点 Agent

Agent 以单一 Go 二进制运行在 Debian 节点上，由 systemd 管理，通过出站 HTTPS 与 Worker 通信，通过 loopback gRPC 读取 Xray 统计并热更新用户。安装步骤见 [deployment.md](deployment.md)，二进制构建与下载分发见 [agent-distribution.md](agent-distribution.md)，采样与上报规则见 [traffic.md](traffic.md)，远程配置见 [config-delivery.md](config-delivery.md)。

## 1. 模块职责

| 模块 | 职责 |
| --- | --- |
| `config` | 读取少量 YAML/环境配置并校验 |
| `collector` | 采样循环、采样结构与健康标记 |
| `accounting` | 增量计算、小时切分、outbox 关闭与过期策略 |
| `state` | BoltDB 存储原语与不透明事务句柄；隔离 bbolt |
| `reporter` | 心跳、流量重试、退避与 jitter |
| `syncer` | 用户集合拉取、持久化与热更新 |
| `sysinfo` | CPU、内存、负载、uptime |
| `xraycore` | Stats/Handler gRPC 客户端与 protobuf 编解码 |
| `xrayconfig` | 配置渲染与 config.json 唯一写入点 |
| `xrayapply` | 校验、切换、重启、健康检查与回滚编排 |
| `atomicfile` | 同目录临时文件、fsync 与原子替换 |
| `cmd/zako-agent` | 依赖组装、signal 与优雅退出 |

## 2. 配置文件

默认路径 `/etc/zako-agent/config.yaml`，示例见 `apps/agent/config.example.yaml`：

```yaml
control_plane_url: https://panel.example.com
node_id: <node-id>
agent_token_file: /etc/zako-agent/token
state_path: /var/lib/zako-agent/state.db
users_path: /var/lib/zako-agent/users.json
xray_config_path: /etc/xray/config.json
xray_binary_path: /usr/local/bin/xray
reality_private_key_path: /etc/xray/reality.key
xray_api_address: 127.0.0.1:10085
xray_inbound_tag: vless-reality
heartbeat_interval: 5m
collector:
  sample_interval: 30s
  report_interval: 15m
```

`xray_inbound_tag` 可选，默认 `vless-reality`，与 `deploy/xray/config.example.json` 中 VLESS 入站的 `tag` 一致。HandlerService 按 tag 定位入站，改名后必须同步该字段，否则热更新失败并回退为重启路径。未知配置字段会被拒绝。

## 3. 进程模型

Agent 构建为 `CGO_ENABLED=0` 的 Linux amd64/arm64 静态二进制，由 systemd 以 `zako-agent` 用户、`NoNewPrivileges=true` 运行；退出时先完成当前状态事务再结束。写路径限制为 `/var/lib/zako-agent` 与 `/etc/xray`，重启授权见 §5，安装步骤见 [deployment.md](deployment.md)。

## 4. 用户同步与热更新

### 4.1 版本与拉取

- `meta.users_ver` 是全局用户集合版本；新增、停用、删除授权、状态变化、凭据启停都会递增。
- 创建节点时在同一 batch 内为默认订阅用户创建 `node_clients`；`PUT /subscribers/{subscriberId}/nodes` 为新增授权补齐凭据。没有凭据的用户不会进入订阅。
- Agent 本地保存两个版本键：`desired_users_version` 是 Worker 最近一次通告的值，只用于唤醒同步；`users_version` 是已完成本地落地的版本，只在整套写入成功后推进。
- 上报响应携带 `users_ver`，值写入 `desired_users_version` 并唤醒一次同步；上报请求中的 `users_ver` 是已应用的 `users_version`，因此失败的同步会在后续心跳中保持可见。
- 已应用版本大于 0 时，同步以它作为 `If-None-Match` 拉取 `GET /api/v1/agent/users`；版本未变时返回 `304` 且无 body，本轮不写盘。响应版本低于已应用版本时忽略。
- 用户列表只包含该节点上 `node_clients.enabled=1` 且订阅用户 `status=active` 的凭据。

### 4.2 应用与持久化

- 期望用户集合与 `users.json` 求差集：新增邮箱经 `HandlerService.AlterInbound` 的 `AddUser` 热更新，删除邮箱经 `RemoveUser`。UUID 变化表现为一次删除加一次新增；删除先于新增，因为 Xray 拒绝同一 `email` 的重复账号。
- 热更新成功后先原子写 `users.json`（0600），渲染结果与磁盘 `config.json` 不同时再原子写入，最后推进 `users_version`。
- `config.json` 的所有替换路径（热更新、重启回退、回滚）都经 `xrayconfig.ConfigStore` 单点写入，原子替换、文件权限与目录创建只定义一次。
- `config.json` 以当前文件为模板，只替换 VLESS 入站的 `clients`，并合入本地 REALITY 私钥；其余字段（API inbound、routing、policy、REALITY 参数）原样保留。
- 热更新失败时回退为重启路径：`xray run -test` 校验渲染结果，原子替换配置，`systemctl restart xray.service`，再用 StatsService 的 `GetSysStats` 做健康检查。校验失败时不替换配置；重启或健康检查失败时恢复上一份配置并再次重启。这两种情况下 `users_version` 与 `users.json` 都不推进。
- 磁盘 `config.json` 与按当前用户集合渲染的结果不一致时，即使差集为空也走重启路径，让运行中的进程与磁盘配置收敛。
- 同步失败不阻塞上报；下一次触发从磁盘 `users.json` 重新求差集，已成功的新增不会重放。同步循环启动即执行一轮，之后由上报响应唤醒，并以 10 分钟兜底间隔重试。缺少静态配置时以 `ErrNoConfig` 跳过并记录。
- Agent 重启后以磁盘上的完整配置为准，落后于 Worker 时立即拉取。

### 4.3 并发控制

- 用户同步的整轮拉取、差集与应用在一把 Agent 内互斥锁内串行执行；当前由 syncer 持有该锁，一次只运行一个同步回合。P2 的配置应用复用该锁。
- 同步期间的多次触发合并为一次待处理触发，唤醒不丢失。

## 5. 节点权限

- `/etc/xray` 目录为 `root:zako-agent`、`0770`。Agent 通过同目录临时文件加 rename 替换 `config.json`，需要目录写权限；Xray 以 root 运行，组归属即可满足替换。
- `/etc/xray/config.json` 为 `0640`、属组 `zako-agent`；`/etc/xray/reality.key` 为 `0600`、属 `zako-agent`；`/var/lib/zako-agent/users.json` 为 `0600`。
- 重启能力来自安装脚本写入的 polkit 规则 `/etc/polkit-1/rules.d/50-zako-agent-xray.rules`：只对 `zako-agent` 用户、`xray.service` 与 `restart` 动作返回允许。Agent 不通过 shell，只执行固定命令 `systemctl restart xray.service` 与 `xray run -test -config`。

## 6. 远程配置

配置定义、版本递增、发布流程、应用状态机与回滚规则见 [config-delivery.md](config-delivery.md)。

## 7. 构建与分发

- 发布流水线由 `agent-v*` tag 触发，使用 Go 1.24 与 `CGO_ENABLED=0` 交叉编译 `linux/amd64` 与 `linux/arm64`，版本通过 `-ldflags "-X main.version=<version>"` 注入。
- 产物以稳定 URL 由独立 Downloads Worker 提供；版本号用于诊断，tag 用于回滚，不进入下载 URL。
- 节点安装与升级命令见 [agent-distribution.md](agent-distribution.md#5-安装与升级)，回滚见 [agent-distribution.md](agent-distribution.md#6-回滚)。
- 心跳中的 `agent_version` 来自同一构建注入值，用于面板展示与升级核对。
