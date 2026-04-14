# codex-thread-relay-mcp

[English](README.md)

Windows Codex App thread relay MCP.

这个项目提供本地 Windows Codex App 的跨项目线程中继能力。当前版本保持原有 4 个工具兼容，并新增同步 `relay_dispatch`、异步 `relay_dispatch_async` / `relay_dispatch_status` / `relay_dispatch_deliver` / `relay_dispatch_recover`，覆盖一跳编排、异步回传、状态查询、批量恢复和异常扫尾。

## What It Talks To

- Windows Codex App state under `%USERPROFILE%\.codex`
- A separate Windows Codex CLI app-server process
- Only projects already known and trusted by the Windows Codex App

WSL Codex CLI、cloud threads、archived threads 仍不在这一版范围内。

The spawned Windows Codex CLI app-server is started with `service_tier="fast"` so delegated turns do not fail on Windows installs that still reject the local `flex` path.

## Tools

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

## Error Model

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

## Relay State

Relay-owned state is stored separately from `CODEX_HOME`:

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
- callback 回传消息现在带固定 envelope：`[Codex Relay Callback]` + `Event-Type: codex.relay.dispatch.completed.v1` + `BEGIN_CODEX_RELAY_CALLBACK_JSON` / `END_CODEX_RELAY_CALLBACK_JSON` 之间的机读 JSON

创建线程后但还没出现在 `thread/list` 里的空线程，仍然会通过 remembered thread 机制被 relay 选中。

## Local Setup

```powershell
cd <path-to-codex-thread-relay-mcp>
npm install
```

默认使用共享 Windows home：

- `CODEX_HOME=%USERPROFILE%\.codex`

Optional environment variables:

- `THREAD_RELAY_CODEX_HOME`
- `THREAD_RELAY_CODEX_COMMAND`
- `THREAD_RELAY_CODEX_ARGS`
- `THREAD_RELAY_HOME`
- `THREAD_RELAY_REQUEST_TIMEOUT_MS`
- `THREAD_RELAY_POLL_INTERVAL_MS`
- `THREAD_RELAY_TURN_TIMEOUT_MS`
- `THREAD_RELAY_DEBUG=1`
- `THREAD_RELAY_SOAK_CONCURRENCY`

## Codex App Config

Add this MCP server entry to the Windows Codex config:

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

Replace the example path values with the absolute paths on your own machine.

## Validation

```powershell
npm run check
npm test
npm run smoke
npm run soak
npm run audit:official
```

- `check`: 语法检查
- `test`: `node:test` 单测，覆盖路径归一化、remembered thread、lease、dispatch 解析和超时错误路径
- `smoke`: 本地烟测，覆盖创建线程、首次发消息、复用已有线程、`relay_dispatch` create-and-send、busy/timeout 失败路径
- `soak`: 更长时间的 live async callback 循环，覆盖 repeated async dispatch、并发 fan-out、强制 callback `pending`、批量 recover、状态查询稳定性
- `audit:official`: 强制走 `https://registry.npmjs.org` 的依赖审计，避免镜像缺失 audit endpoint 时误判

## Example Flow

1. Call `relay_list_projects`
2. Pick a trusted target project
3. Call `relay_dispatch` for the shortest happy path
4. Fall back to `relay_list_threads` / `relay_create_thread` / `relay_send_wait` when you need finer control
5. For async work, use `relay_dispatch_status` for polling and `relay_dispatch_recover` when callback delivery or worker progress needs explicit recovery; omit `dispatchId` to batch-sweep stale dispatches for one project

## Scope Limits In This Version

- No WSL targets
- No cloud threads
- No archived threads
- No daemonized long-lived app-server pool
