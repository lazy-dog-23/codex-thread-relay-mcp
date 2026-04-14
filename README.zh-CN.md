# codex-thread-relay-mcp

[English](README.md)

`codex-thread-relay-mcp` 的作用很直接：让一个 Codex App 线程把消息发到另一个线程，再把结果回传回来，支持跨项目、跨会话。

这个仓库提供的就是这层线程通信能力：trusted project 查询、线程创建/复用、同步 dispatch、异步 callback、状态查询和恢复。

## 它会和什么交互

- `%USERPROFILE%\.codex` 下的 Windows Codex App 状态
- 单独拉起的 Windows Codex CLI app-server 进程
- 仅限 Windows Codex App 已知且已 trusted 的项目

当前版本不覆盖：

- WSL Codex CLI
- cloud threads
- archived threads

拉起的 Windows Codex CLI app-server 固定使用 `service_tier="fast"`，避免 Windows 安装里本地 `flex` 路径被拒绝时 delegated turn 直接失败。

## 前置条件

- Windows
- Node.js 22
- npm
- Git
- PowerShell 7
- 可正常运行的 Windows Codex App

## 安装

### 安装依赖

```powershell
cd <path-to-codex-thread-relay-mcp>
npm install
```

### 注册 MCP server

把下面这段 MCP server 配置加到 Windows Codex config：

```toml
[mcp_servers.threadRelay]
type = "stdio"
command = "node"
args = ["<absolute-path-to-codex-thread-relay-mcp>\\src\\index.js"]
required = false
startup_timeout_sec = 30
tool_timeout_sec = 900

[mcp_servers.threadRelay.env]
THREAD_RELAY_CODEX_HOME = "<path-to-your-codex-home>"
```

把示例路径替换成你自己机器上的绝对路径，然后重启 Codex App。

## 升级

- 拉取最新仓库代码后重新执行 `npm install`。
- 更新 MCP server 代码或配置后，重启 Codex App。
- 在真实线程环境依赖更新后的 relay 之前，重新跑一遍 `npm run check`、`npm test` 和 `npm run smoke`。

## 常见问题

- 如果 Codex 里看不到 relay 工具，先检查 MCP 配置路径，再重启 Codex App。
- 如果 `smoke` 很早就失败，先确认 Codex App 正在运行，并且目标项目已经被 Windows Codex App 标记为 trusted。
- 如果 async callback 长时间停在 `pending`，先看源线程是否正忙，再使用 `relay_dispatch_deliver` 或 `relay_dispatch_recover`。
- 如果 `relay_send_wait` 或同步 `relay_dispatch` 在长回合上超时，现在错误里会带 `recoveryDispatchId`。可以先用 `relay_dispatch_status` 看后台进度，再用 `relay_dispatch_recover` 显式续等；长自治流程仍然优先用 `relay_dispatch_async`。

## 近期验证结论（2026-04-14）

在真实链路上做了 thread-relay 回归，结果如下：

1. `dispatchId=<example-dispatch-a>`：`send_wait` 超时后，`dispatch_status` 最终成功，拿到 `RELAY_TEST_MARKER=FRONTEND_RELAY_READONLY_OK`。
2. `dispatchId=<example-dispatch-b>`：再次超时后，后续 `dispatch_status` 成功，拿到 `RELAY_FOLLOWUP_MARKER=POST_RECOVERY_THREAD_FREE_OK`。
3. recover 后直接同步再发一条，45 秒窗口内成功回包，拿到 `RELAY_DIRECT_SYNC_MARKER=OK`。
4. `dispatchId=<example-dispatch-c>`：故意 1 秒超时后走 `relay_dispatch_recover`，最终成功，拿到 `RELAY_RECOVER_PATH_MARKER=OK`。

结论：`timeout -> status`、`timeout -> recover`、以及 recover 后续消息都已稳定跑通。剩余不稳定点来自目标线程本身的耗时波动，短 `timeoutSec` 仍可能超时，但不会再卡死，且可通过 status/recover 正常收口。

## 公开工具

- `relay_list_projects()`
- `relay_list_threads({ projectId, query? })`
- `relay_create_thread({ projectId, name? })`
- `relay_send_wait({ threadId, message, timeoutSec? })`
- `relay_dispatch({ projectId, message, threadId?, threadName?, query?, createIfMissing?, timeoutSec? })`
- `relay_dispatch_async({ projectId, message, threadId?, threadName?, query?, createIfMissing?, callbackThreadId?, timeoutSec? })`
- `relay_dispatch_status({ dispatchId })`
- `relay_dispatch_deliver({ dispatchId, callbackThreadId? })`
- `relay_dispatch_recover({ dispatchId?, projectId?, callbackThreadId?, limit? })`

`relay_dispatch` 的解析顺序固定为：

1. `threadId`
2. `threadName` 精确命中
3. `query` 唯一命中
4. `createIfMissing=true` 时新建线程

## 错误模型

公开错误码统一收口为：

- `project_untrusted`
- `thread_not_found`
- `target_ambiguous`
- `dispatch_not_found`
- `callback_target_invalid`
- `target_busy`
- `app_server_unavailable`
- `turn_timeout`
- `reply_missing`
- `target_turn_failed`

MCP 响应会通过 `McpError` 的 `data.relayCode` 暴露这些错误码。

## 持久状态与 Lease

relay 自有状态独立存放，不和 `CODEX_HOME` 混在一起：

- state: `%USERPROFILE%\.codex-relay\state.json`
- per-thread lease: `%USERPROFILE%\.codex-relay\locks\*.lease.json`
- per-dispatch lease: `%USERPROFILE%\.codex-relay\locks\dispatch-*.lease.json`

状态文件至少记录：

- remembered thread: `threadId` / `projectId` / `name` / `createdAt` / `lastUsedAt` / `lastTurnId`
- active thread lease: `threadId` / `projectId` / `leaseId` / `acquiredAt` / `expiresAt` / `turnId` / `status`
- async dispatch record: `dispatchId` / `projectId` / `threadId` / `threadName` / `dispatchStatus` / `callbackThreadId` / `callbackStatus` / `turnId` / `callbackTurnId` / `replyText` / `errorCode` / `errorMessage` / `timingMs` / `createdAt` / `acceptedAt` / `updatedAt`

异步 dispatch 状态机：

- dispatch: `queued -> running -> succeeded | failed | timed_out`
- callback: `not_requested | pending | delivered | failed`

恢复策略：

- `relay_dispatch_status` 负责读 durable 状态并给出 `recoverySuggested`，必要时会把 thread lease 中恢复到的 `turnId` 暴露出来
- `relay_dispatch_deliver` 只重试 callback 投递
- `relay_dispatch_recover` 会在安全时恢复已有 turn、重试 `pending/failed` callback，或在没有活动 lease 且没有已记录 turnId 时重启 dispatch；不给 `dispatchId` 时会按 `projectId` 批量扫可恢复的 dispatch
- callback 回传消息固定带 envelope：`[Codex Relay Callback]` + `Event-Type: codex.relay.dispatch.completed.v1` + `BEGIN_CODEX_RELAY_CALLBACK_JSON` / `END_CODEX_RELAY_CALLBACK_JSON` 之间的机读 JSON

创建线程后但还没出现在 `thread/list` 里的空线程，仍然会通过 remembered thread 机制被 relay 选中。

默认使用共享 Windows home：

- `CODEX_HOME=%USERPROFILE%\.codex`

可选环境变量：

- `THREAD_RELAY_CODEX_HOME`
- `THREAD_RELAY_CODEX_COMMAND`
- `THREAD_RELAY_CODEX_ARGS`
- `THREAD_RELAY_HOME`
- `THREAD_RELAY_REQUEST_TIMEOUT_MS`
- `THREAD_RELAY_POLL_INTERVAL_MS`
- `THREAD_RELAY_TURN_TIMEOUT_MS`
- `THREAD_RELAY_DEBUG=1`
- `THREAD_RELAY_SOAK_CONCURRENCY`

## 验证

```powershell
npm run check
npm test
npm run smoke
npm run soak
npm run audit:official
```

- `check`: 运行时入口和脚本的语法检查
- `test`: `node:test` 单测，覆盖路径归一化、lease、dispatch 解析、异步回传和错误传播
- `smoke`: 本地 live 烟测，覆盖创建线程、首次发消息、复用已有线程和主要失败路径
- `soak`: 更长时间的 async callback 与恢复压力测试
- `audit:official`: 强制走官方 npm registry 做依赖审计

## 示例流程

1. 调用 `relay_list_projects`
2. 选择一个 trusted target project
3. 先用 `relay_dispatch` 走最短 happy path
4. 需要更细粒度控制时，再退回 `relay_list_threads` / `relay_create_thread` / `relay_send_wait`
5. 异步场景用 `relay_dispatch_status` 轮询；callback 投递或 worker 进度需要显式恢复时，使用 `relay_dispatch_recover`；不给 `dispatchId` 时可以按单个项目批量扫 stale dispatch

## 当前版本范围限制

- 不支持 WSL target
- 不支持 cloud threads
- 不支持 archived threads
- 不引入 daemon 化的长驻 app-server 池

## 许可证

本仓库使用 MIT License 发布。见 [LICENSE](LICENSE)。
