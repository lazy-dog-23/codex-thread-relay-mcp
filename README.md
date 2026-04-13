# codex-thread-relay-mcp

Windows Codex App thread relay MCP.

这个项目提供本地 Windows Codex App 的跨项目线程中继能力。当前版本保持原有 4 个工具兼容，并新增一个一跳编排工具 `relay_dispatch`，用于“选线程或建线程 + 发消息 + 等回复”的单次闭环。

## What It Talks To

- Windows Codex App state under `C:\Users\Administrator\.codex`
- A separate Windows Codex CLI app-server process
- Only projects already known and trusted by the Windows Codex App

WSL Codex CLI、cloud threads、archived threads、async callback 都不在这一版范围内。

For this machine, the spawned Windows Codex CLI app-server is started with `service_tier="fast"` so delegated turns do not fail on the local `Unsupported service_tier: flex` path.

## Tools

- `relay_list_projects()`
- `relay_list_threads({ projectId, query? })`
- `relay_create_thread({ projectId, name? })`
- `relay_send_wait({ threadId, message, timeoutSec? })`
- `relay_dispatch({ projectId, message, threadId?, threadName?, query?, createIfMissing?, timeoutSec? })`

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
- `target_busy`
- `app_server_unavailable`
- `turn_timeout`
- `reply_missing`
- `target_turn_failed`

MCP 响应会通过 `McpError` 的 `data.relayCode` 暴露这些错误码。

## Relay State

Relay-owned state is stored separately from `CODEX_HOME`:

- state: `C:\Users\Administrator\.codex-relay\state.json`
- per-thread lease: `C:\Users\Administrator\.codex-relay\locks\*.lease.json`

状态文件至少记录：

- remembered thread: `threadId` / `projectId` / `name` / `createdAt` / `lastUsedAt` / `lastTurnId`
- active dispatch lease: `threadId` / `projectId` / `leaseId` / `acquiredAt` / `expiresAt`

创建线程后但还没出现在 `thread/list` 里的空线程，仍然会通过 remembered thread 机制被 relay 选中。

## Local Setup

```powershell
cd C:\Users\Administrator\Desktop\Project\test\codex-thread-relay-mcp
npm install
```

默认使用共享 Windows home：

- `CODEX_HOME=C:\Users\Administrator\.codex`

Optional environment variables:

- `THREAD_RELAY_CODEX_HOME`
- `THREAD_RELAY_CODEX_COMMAND`
- `THREAD_RELAY_CODEX_ARGS`
- `THREAD_RELAY_HOME`
- `THREAD_RELAY_REQUEST_TIMEOUT_MS`
- `THREAD_RELAY_POLL_INTERVAL_MS`
- `THREAD_RELAY_TURN_TIMEOUT_MS`
- `THREAD_RELAY_DEBUG=1`

## Codex App Config

Add this MCP server entry to the Windows Codex config:

```toml
[mcp_servers.threadRelay]
type = "stdio"
command = "node"
args = ["C:\\Users\\Administrator\\Desktop\\Project\\test\\codex-thread-relay-mcp\\src\\index.js"]
required = false
startup_timeout_sec = 30
tool_timeout_sec = 900

[mcp_servers.threadRelay.env]
THREAD_RELAY_CODEX_HOME = "C:\\Users\\Administrator\\.codex"
```

## Validation

```powershell
npm run check
npm test
npm run smoke
npm run audit:official
```

- `check`: 语法检查
- `test`: `node:test` 单测，覆盖路径归一化、remembered thread、lease、dispatch 解析和超时错误路径
- `smoke`: 本地烟测，覆盖创建线程、首次发消息、复用已有线程、`relay_dispatch` create-and-send、busy/timeout 失败路径
- `audit:official`: 强制走 `https://registry.npmjs.org` 的依赖审计，避免镜像缺失 audit endpoint 时误判

## Example Flow

1. Call `relay_list_projects`
2. Pick a trusted target project
3. Call `relay_dispatch` for the shortest happy path
4. Fall back to `relay_list_threads` / `relay_create_thread` / `relay_send_wait` when you need finer control

## Scope Limits In This Version

- No WSL targets
- No cloud threads
- No archived threads
- No async callback into the source thread
- No daemonized long-lived app-server pool
