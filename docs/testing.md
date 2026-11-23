# 测试与验证

项目的自动化测试可以在**本地无外网、无真实 Xray、无需 root 权限**的情况下全部跑通。常用运行命令见 [README.md](../README.md#校验)。

---

## 1. Worker 测试（`apps/worker/test`）

在 Vitest Workers 池中运行，每个测试套件启动前都会自动执行真实的 D1 迁移脚本，主要验证：

- **订阅渲染**：Clash.Meta YAML 合法性、代理组/规则结构、五种协议的 Clash 代理项与 URI（`vless://`、`vmess://`、`trojan://`、`ss://`、`hysteria2://`）编码、IPv6 处理与协议参数失效时的跳过
- **权限与生命周期**：Token 轮换/撤销、到期与超额拦截、无可用节点返回 `503`、Cloudflare Access JWT 校验
- **节点状态**：`online` / `degraded` / `offline` / `disabled` 四种状态的派生逻辑
- **流量幂等与同步**：重复 `report_id` 幂等、载荷不一致报 `409`、跨小时拆分校验、`ETag` / `304` 协商
- **定时任务**：15 分钟周期推进与每日凌晨 1,000 行分批清理

---

## 2. Go Agent 测试（`apps/agent`）

使用内存临时数据库和环回 gRPC Mock 服务，覆盖：

- **采样与切分**：基线建立、增量计算、Xray 重启断层标记、跨自然小时拆包、单批 40 用户上限
- **队列与重试**：收到确认后删除、遇 `409` 淘汰、遇 `429` 或超时指数退避
- **热更新与回退**：用户集合差集计算（增/删/改）、`HandlerService` 编解码、热更新失败自动降级为配置校验 + 重启 + 回滚
- **跨语言契约**：用 `packages/contracts/fixtures` 验证 Go 结构体与 OpenAPI 载荷完全一致

---

## 3. 打包与静态分发测试

- `deploy/tests/package-release.sh`：检查发布压缩包里的二进制、systemd unit、polkit 规则、版本号注入，并确认没有把私钥等敏感文件打进去。
- `deploy/tests/stage-downloads.sh`：检查分发目录清单、`SHA256SUMS` 哈希一致性和静态响应头配置。

---

## 4. 前端构建与容量压测

- **类型与构建**：`npm run typecheck` 和 `npm run build` 验证 `vue-tsc` 与 Vite 打包无误。
- **容量基准（`npm run capacity`）**：在本地 D1 模拟 **100 节点、100 用户-节点组合、500 条分流规则** 的高负载场景，测量接口 p95 CPU 耗时和 D1 读写行数。
- **真机联调**：每次发版在 Debian 12 / 13 机器上实测一遍一键安装脚本、热更新和 `127.0.0.1` 环回监听边界。
