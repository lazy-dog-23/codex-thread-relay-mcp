# codex-thread-relay-mcp

[English](README.md)

Windows Codex App 线程 relay MCP。

这个项目提供本地 Windows Codex App 的跨项目线程中继能力。当前版本保持原有 4 个工具兼容，并新增同步 `relay_dispatch`、异步 `relay_dispatch_async` / `relay_dispatch_status` / `relay_dispatch_deliver` / `relay_dispatch_recover`，覆盖一跳编排、异步回传、状态查询、批量恢复和异常扫尾。

## 它会和什么交互

- `%USERPROFILE%\.codex` 下的 Windows Codex App 状态
- 单独拉起的 Windows Codex CLI app-server 进程
- 仅限 Windows Codex App 已知且已 trusted 的项目

当前版本不覆盖：

- WSL Codex CLI
- cloud threads
- archived threads

拉起的 Windows Codex CLI app-server 固定使用 `service_tier="fast"`，避免 Windows 安装里本地 `flex` 路径被拒绝时 delegated turn 直接失败。

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

## 本地安装

```powershell
cd <path-to-codex-thread-relay-mcp>
npm install
```

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

## Codex App 配置

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

把示例路径替换成你自己机器上的绝对路径。

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
