# codex-thread-relay-mcp

[中文说明](README.zh-CN.md)

`codex-thread-relay-mcp` is a Windows-first MCP server for relaying work across trusted Codex App threads and projects. It keeps the original four relay tools compatible, adds one-shot synchronous dispatch, and adds durable asynchronous dispatch with callback delivery and recovery.

## What It Talks To

- Windows Codex App state under `%USERPROFILE%\.codex`
- A separate Windows Codex CLI app-server process
- Projects that are already known and trusted by the Windows Codex App

Out of scope for this release:

- WSL Codex CLI
- cloud threads
- archived threads

The spawned Windows Codex CLI app-server uses `service_tier="fast"` so delegated turns keep working on Windows installs that reject the local `flex` path.

## Public Tools

- `relay_list_projects()`
- `relay_list_threads({ projectId, query? })`
- `relay_create_thread({ projectId, name? })`
- `relay_send_wait({ threadId, message, timeoutSec? })`
- `relay_dispatch({ projectId, message, threadId?, threadName?, query?, createIfMissing?, timeoutSec? })`
- `relay_dispatch_async({ projectId, message, threadId?, threadName?, query?, createIfMissing?, callbackThreadId?, timeoutSec? })`
- `relay_dispatch_status({ dispatchId })`
- `relay_dispatch_deliver({ dispatchId, callbackThreadId? })`
- `relay_dispatch_recover({ dispatchId?, projectId?, callbackThreadId?, limit? })`

Dispatch resolution order is fixed:

1. `threadId`
2. exact `threadName`
3. unique `query` match
4. create a new thread when `createIfMissing=true`

## Error Model

Public relay error codes:

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

MCP responses surface them through `McpError.data.relayCode`.

## Durable State and Leases

Relay-owned state is stored outside `CODEX_HOME`:

- state: `%USERPROFILE%\.codex-relay\state.json`
- per-thread lease: `%USERPROFILE%\.codex-relay\locks\*.lease.json`
- per-dispatch lease: `%USERPROFILE%\.codex-relay\locks\dispatch-*.lease.json`

Tracked records include:

- remembered thread metadata
- active thread leases
- async dispatch records
- callback status and retry state
- reply text, turn ids, timings, and failure metadata

Async dispatch state machine:

- dispatch: `queued -> running -> succeeded | failed | timed_out`
- callback: `not_requested | pending | delivered | failed`

Recovery surfaces:

- `relay_dispatch_status` reads the durable record and can suggest recovery
- `relay_dispatch_deliver` retries callback delivery only
- `relay_dispatch_recover` resumes safe in-flight work, retries pending callbacks, or restarts a dispatch when that is the only safe option

Callback messages use the fixed envelope:

- `[Codex Relay Callback]`
- `Event-Type: codex.relay.dispatch.completed.v1`
- `BEGIN_CODEX_RELAY_CALLBACK_JSON`
- `END_CODEX_RELAY_CALLBACK_JSON`

Empty threads that were created but have not yet appeared in `thread/list` are still reachable through remembered-thread state.

## Local Setup

```powershell
cd <path-to-codex-thread-relay-mcp>
npm install
```

Default shared Windows home:

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

Replace the example path values before using the config.

## Verification

```powershell
npm run check
npm test
npm run smoke
npm run soak
npm run audit:official
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

- `check`: syntax checks for the runtime entrypoints and scripts
- `test`: `node:test` coverage for path normalization, leases, dispatch resolution, async delivery, and error propagation
- `smoke`: live local smoke coverage for create/send/reuse and primary failure paths
- `soak`: longer async callback and recovery pressure runs
- `audit:official`: dependency audit against the official npm registry

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

## License

This repository is released under the MIT License. See [LICENSE](LICENSE).
