# codex-thread-relay-mcp

[中文说明](README.zh-CN.md)

`codex-thread-relay-mcp` lets one Codex App thread send work to another thread and get the result back, including across different projects or sessions.

This repository provides that bridge/recovery transport layer as an MCP server: trusted-project lookup, thread create/reuse, asynchronous dispatch, status queries, recovery, callback delivery, and short synchronous probes. It is not the primary same-thread autonomy control bus; official Codex thread automations should own that path when the bound thread can keep working in place.

## What It Talks To

- Windows Codex App state under `%USERPROFILE%\.codex`
- A separate Windows Codex CLI app-server process
- Projects that are already known and trusted by the Windows Codex App

Out of scope for this release:

- WSL Codex CLI
- cloud threads
- archived threads

The spawned Windows Codex CLI app-server uses `service_tier="fast"` so delegated turns keep working on Windows installs that reject the local `flex` path.

## Prerequisites

- Windows
- Node.js 22
- npm
- Git
- PowerShell 7
- A working Windows Codex App installation

## Installation

### Install dependencies

```powershell
cd <path-to-codex-thread-relay-mcp>
npm install
```

### Register the MCP server

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

Replace the example path values before using the config, then restart the Codex App.

## Upgrade

- Pull the latest repository changes and rerun `npm install`.
- Restart the Codex App after updating the MCP server code or config.
- Rerun `npm run check`, `npm test`, and `npm run smoke` before relying on the updated relay in live threads.

## Troubleshooting

- If the relay tools do not appear in Codex, check the MCP config path and restart the Codex App.
- If `smoke` fails early, confirm the Codex App is running and the target project is already trusted by the Windows Codex App.
- If async callback delivery stays `pending`, check whether the source thread is busy, then use `relay_dispatch_deliver` or `relay_dispatch_recover`.
- If `relay_send_wait` or synchronous `relay_dispatch` times out on a long target turn, the timeout now includes a `recoveryDispatchId` plus bridge advisory fields. Use `relay_dispatch_status` to inspect progress, `relay_dispatch_recover` to resume waiting explicitly, prefer `relay_dispatch_async` for long-running relay work, and prefer official thread automations for same-thread recurring autonomy loops.

## Recent Validation (2026-04-14)

Live thread-relay regression run on a trusted project/thread:

1. `dispatchId=<example-dispatch-a>`: `send_wait` timed out, `dispatch_status` completed, and returned `RELAY_TEST_MARKER=FRONTEND_RELAY_READONLY_OK`.
2. `dispatchId=<example-dispatch-b>`: another timeout, follow-up `dispatch_status` completed, returned `RELAY_FOLLOWUP_MARKER=POST_RECOVERY_THREAD_FREE_OK`.
3. Immediate sync send after recovery returned within 45 seconds with `RELAY_DIRECT_SYNC_MARKER=OK`.
4. `dispatchId=<example-dispatch-c>`: forced 1-second timeout, `relay_dispatch_recover` completed with `RELAY_RECOVER_PATH_MARKER=OK`.

Outcome: `timeout -> status`, `timeout -> recover`, and post-recovery sends are stable. Remaining variability is target-thread runtime duration; short `timeoutSec` values may still time out, but recovery paths close cleanly.

## Recent Validation (2026-04-16)

The recovery path was validated again on a real bound Windows Codex App thread:

1. A long bounded-loop operator request timed out in synchronous `relay_send_wait`, but still returned a recoverable dispatch id.
2. Follow-up `relay_dispatch_status` first reported `running`, then closed successfully as `succeeded` with the full final reply; the target thread completed its pending verify closeout and marked the active goal completed.
3. An immediate short follow-up send then succeeded within the normal sync window, confirming the thread was not left permanently busy.

That makes the recovery claim more concrete: on a real thread, `long turn -> send_wait timeout -> dispatch_status success -> follow-up send succeeds` is now proven. The remaining unverified piece in this session is only the system-level `Task Scheduler` wake-up layer; the delegated environment used for this run could not register Windows scheduled tasks or spawn a fresh app-server from the runner.

## Recent Validation (2026-04-17)

The next live check separated the relay recovery layer from the official thread-automation runtime on the same bound thread:

1. First, relay was used to ask the bound thread to create its own same-thread heartbeat. That setup turn closed as `target_turn_failed / interrupted` and did not create an automation.
2. To remove relay from the equation, a temporary heartbeat `bilimusic2-official-hb-live-test-20260417-1430` was then created directly in the app against the same bound thread.
3. The heartbeat became `ACTIVE`; the automation TOML and SQLite row existed, and `last_run_at` / `next_run_at` advanced.
4. But the target thread produced no new turn, `automation_runs` remained `0`, and the test marker never appeared in the thread.

Outcome: the relay bridge/recovery layer is now good enough to serve as the operational fallback, but the official heartbeat runtime on this Windows machine still reproduces the “time advances without a real dispatch” failure mode.

## Public Tools

- `relay_list_projects()`
- `relay_list_threads({ projectId, query? })`
- `relay_create_thread({ projectId, name? })`
- `relay_dispatch_async({ projectId, message, threadId?, threadName?, query?, createIfMissing?, callbackThreadId?, timeoutSec? })`
- `relay_dispatch_status({ dispatchId })`
- `relay_dispatch_recover({ dispatchId?, projectId?, callbackThreadId?, limit? })`
- `relay_send_wait({ threadId, message, timeoutSec? })`
- `relay_dispatch({ projectId, message, threadId?, threadName?, query?, createIfMissing?, timeoutSec? })`
- `relay_dispatch_deliver({ dispatchId, callbackThreadId? })`

Dispatch resolution order is fixed:

1. `threadId`
2. exact `threadName`
3. unique `query` match
4. create a new thread when `createIfMissing=true`

## CLI For Schedulers And Scripts

The relay now also exposes a direct CLI entrypoint for non-interactive runners such as Windows Task Scheduler:

```powershell
node src/cli.js relay_list_projects --json
node src/cli.js relay_dispatch_async --project-id <project-id> --thread-id <thread-id> --message-file .\prompt.md --timeout-sec 300 --json
node src/cli.js relay_dispatch_status --dispatch-id <dispatch-id> --json
node src/cli.js relay_dispatch_recover --dispatch-id <dispatch-id> --json
node src/cli.js relay_send_wait --thread-id <thread-id> --message-file .\probe.md --timeout-sec 45 --json
```

CLI behavior:

- uses the same durable dispatch, lease, busy, timeout, and recovery semantics as the MCP tools
- returns machine-readable JSON with `ok`, `command`, `payload`, and relay error metadata when `--json` is set
- accepts long prompts through `--message-file`
- does not depend on an LLM turn to call MCP tools on its behalf

This is the supported fallback building block for `Task Scheduler -> relay -> bound thread` chains. When the work stays on one already-bound project thread, official Codex thread automations remain the architecture-first surface, but on this machine's current live validation they are not yet stable enough to replace the relay fallback.

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

1. If the work can stay on the same bound thread, use official Codex thread automations instead of relay.
2. Call `relay_list_projects`
3. Pick a trusted target project
4. Use `relay_dispatch_async` as the default relay path for long-running delegated work.
5. Use `relay_dispatch_status` for polling and `relay_dispatch_recover` when callback delivery or worker progress needs explicit recovery; omit `dispatchId` to batch-sweep stale dispatches for one project.
6. Keep `relay_send_wait` or synchronous `relay_dispatch` for short probes and short sync replies.

## Scope Limits In This Version

- No WSL targets
- No cloud threads
- No archived threads
- No daemonized long-lived app-server pool

## License

This repository is released under the MIT License. See [LICENSE](LICENSE).
