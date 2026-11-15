# 节点 Agent

Agent 以单一 Go 二进制运行在 Debian 节点上，由 systemd 管理，通过出站 HTTPS 与 Worker 通信，通过 loopback gRPC 读取 Xray 统计并热更新用户。安装步骤见 [deployment.md](deployment.md)，采样与上报规则见 [traffic.md](traffic.md)，远程配置见 [config-delivery.md](config-delivery.md)。

当前交付为 P0：StatsService 采样、增量入账、outbox 与心跳/流量上报。用户集合同步与热更新属于 P1，远程配置属于 P2，均未实现。

## 1. 模块职责

| 模块 | 职责 |
| --- | --- |
| `config` | 读取少量 YAML/环境配置并校验 |
| `collector` | 定时读取 StatsService、计算增量 |
| `state` | BoltDB 基线、Xray uptime、outbox、用户集合与版本 |
| `reporter` | 心跳、流量重试、退避与 jitter |
| `syncer` | 用户集合拉取、持久化与热更新 |
| `sysinfo` | CPU、内存、负载、uptime |
| `xray` | gRPC 客户端、配置渲染/校验/应用 |
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
heartbeat_interval: 5m
collector:
  sample_interval: 30s
  report_interval: 15m
```

## 3. 进程模型

Agent 构建为 `CGO_ENABLED=0` 的 Linux amd64/arm64 静态二进制，由 systemd 管理；退出时先完成当前状态事务再结束。systemd 沙箱、写路径与命令限制见 [security.md](security.md)，安装步骤见 [deployment.md](deployment.md)。

## 4. 用户同步与热更新

### 4.1 版本与拉取

- `meta.users_ver` 是全局用户集合版本；新增、停用、删除授权、状态变化、凭据启停都会递增。
- 创建节点时在同一 batch 内为默认订阅用户创建 `node_clients`；P1 的授权接口为新增用户/节点补齐凭据。没有凭据的用户不会进入订阅。
- P0 没有用户同步，节点本地入站的 client 由管理员按 `GET /api/v1/admin/nodes/{nodeId}/clients` 的 `xray_email` 与 UUID 手工填写，步骤见 [deployment.md](deployment.md#21-p0-节点侧-xray-配置)。
- Agent 心跳/上报响应携带 `users_ver`；发现变化时调用 `GET /api/v1/agent/users`。
- 用户列表只包含该节点上 `node_clients.enabled=1` 且订阅用户 `status=active` 的凭据。
- Agent 使用 `If-None-Match` 避免重复传输；响应版本写入本地状态。

### 4.2 应用与持久化

- Agent 收到新用户集合后，先写临时 `users.json` 并 fsync，再原子 rename 到状态目录，权限 0600。
- 优先通过 `HandlerService.AlterInbound` 的 `AddUser` / `RemoveUser` 热更新。VLESS 需要构造 `AddUserOperation`，包含 `email`、`level=0` 与 `Account`；`Account` 必须带 `uuid` 与 `flow=xtls-rprx-vision`。
- 同时用当前静态配置、用户集合与本地 REALITY 私钥渲染完整 Xray 配置，原子写入磁盘。运行中的热更新与磁盘配置保持一致，重启后不丢失用户。
- 热更新失败时回退为“写入配置 + 重启”，重启后执行健康检查；失败则恢复上一份已知可用配置。
- Agent 启动时以磁盘上的完整配置为准，并再次核对 `users_ver`；发现落后立即拉取。

### 4.3 并发控制

- 用户同步与配置发布共用一把 Agent 内的互斥锁，避免同时修改配置。
- 配置应用期间到达的用户版本在应用完成后重新同步。
- 同一节点同时只允许一个 apply 操作；旧版本结果按版本号丢弃。

## 5. 远程配置

配置定义、版本递增、发布流程、应用状态机与回滚规则见 [config-delivery.md](config-delivery.md)。
