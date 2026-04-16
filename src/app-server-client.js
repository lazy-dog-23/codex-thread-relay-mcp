import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1_000;

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(value, fallbackCommand) {
  if (!value) {
    return fallbackCommand.toLowerCase().includes("npx")
      ? [
          "-y",
          "@openai/codex@latest",
          "app-server",
          "-c",
          'approval_policy="never"',
          "-c",
          'service_tier="fast"',
          "-c",
          "mcp_servers.threadRelay.enabled=false",
        ]
      : [
          "app-server",
          "-c",
          'approval_policy="never"',
          "-c",
          'service_tier="fast"',
          "-c",
          "mcp_servers.threadRelay.enabled=false",
        ];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {}

  return String(value)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveDefaultCommand() {
  if (process.env.THREAD_RELAY_CODEX_COMMAND) {
    return process.env.THREAD_RELAY_CODEX_COMMAND;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const npmCodexCmd = path.join(appData, "npm", "codex.cmd");
    if (fs.existsSync(npmCodexCmd)) {
      return npmCodexCmd;
    }
    return "npx.cmd";
  }

  return "npx";
}

function createLauncherOptions() {
  const command = resolveDefaultCommand();
  const args = parseArgs(process.env.THREAD_RELAY_CODEX_ARGS, command);
  const codexHome =
    process.env.THREAD_RELAY_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");

  return {
    command,
    args,
    codexHome,
    requestTimeoutMs: parseInteger(
      process.env.THREAD_RELAY_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    pollIntervalMs: parseInteger(
      process.env.THREAD_RELAY_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    turnTimeoutMs: parseInteger(
      process.env.THREAD_RELAY_TURN_TIMEOUT_MS,
      DEFAULT_TURN_TIMEOUT_MS,
    ),
    debug: process.env.THREAD_RELAY_DEBUG === "1",
  };
}

function buildEnv(codexHome) {
  return {
    ...process.env,
    CODEX_HOME: codexHome,
  };
}

function shouldUseShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function makeError(message, extras = {}) {
  const error = new Error(message);
  Object.assign(error, extras);
  return error;
}

export class CodexAppServerSession {
  constructor(options = {}) {
    const defaults = createLauncherOptions();
    this.command = options.command ?? defaults.command;
    this.args = options.args ?? defaults.args;
    this.codexHome = options.codexHome ?? defaults.codexHome;
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaults.requestTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? defaults.pollIntervalMs;
    this.turnTimeoutMs = options.turnTimeoutMs ?? defaults.turnTimeoutMs;
    this.debug = options.debug ?? defaults.debug;

    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.stdoutReader = null;
    this.stderrReader = null;
    this.isInitialized = false;
    this.isClosed = false;
    this.turnStates = new Map();
  }

  async open() {
    if (this.proc) {
      return;
    }

    this.proc = spawn(this.command, this.args, {
      cwd: process.cwd(),
      env: buildEnv(this.codexHome),
      shell: shouldUseShell(this.command),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.once("error", (error) => {
      this.rejectAll(makeError(`Failed to start codex app-server: ${error.message}`, { cause: error }));
    });

    this.proc.once("exit", (code, signal) => {
      const detail =
        signal != null
          ? `signal ${signal}`
          : `code ${code ?? "unknown"}`;
      this.rejectAll(makeError(`codex app-server exited unexpectedly (${detail})`));
      this.isClosed = true;
    });

    this.stdoutReader = readline.createInterface({ input: this.proc.stdout });
    this.stdoutReader.on("line", (line) => this.handleStdoutLine(line));

    this.stderrReader = readline.createInterface({ input: this.proc.stderr });
    this.stderrReader.on("line", (line) => {
      if (this.debug && line.trim()) {
        process.stderr.write(`[thread-relay] app-server stderr: ${line}\n`);
      }
    });

    await this.initialize();
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: {
        name: "codex-thread-relay-mcp",
        version: "0.1.0",
      },
      capabilities: {},
    });
    this.notify("initialized", {});
    this.isInitialized = true;
  }

  async close() {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;

    if (this.stdoutReader) {
      this.stdoutReader.close();
    }
    if (this.stderrReader) {
      this.stderrReader.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }

    this.rejectAll(makeError("codex app-server session closed"));
  }

  notify(method, params = {}) {
    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.isClosed) {
      return Promise.reject(makeError("codex app-server session already closed"));
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeError(`Request timed out: ${method}`, { method, timeoutMs }));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
      });

      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(makeError(`Failed to write request ${method}: ${error.message}`, { cause: error }));
      }
    });
  }

  async listAllThreads(options = {}) {
    const threads = [];
    let cursor;

    while (true) {
      const response = await this.request("thread/list", {
        cursor,
        limit: options.limit ?? 200,
        archived: false,
      });
      const page = response?.result?.data ?? [];
      threads.push(...page);

      cursor = response?.result?.nextCursor;
      if (!cursor) {
        return threads;
      }
    }
  }

  async waitForTurn(threadId, turnId, timeoutMs = this.turnTimeoutMs) {
    const existing = this.ensureTurnState(turnId, threadId);
    if (existing.completedTurn && isTerminalTurn(existing.completedTurn)) {
      return this.materializeTurn(turnId);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        existing.waiters = existing.waiters.filter((waiter) => waiter !== waiterEntry);
        try {
          const response = await this.request(
            "thread/read",
            {
              threadId,
              includeTurns: true,
            },
            this.requestTimeoutMs,
          );
          const turns = response?.result?.thread?.turns ?? [];
          const turn = turns.find((item) => item.id === turnId);
          if (turn && isTerminalTurn(turn)) {
            resolve(turn);
            return;
          }
        } catch {}

        reject(
          makeError(`Timed out while waiting for thread ${threadId} turn ${turnId}`, {
            code: "timeout",
            threadId,
            turnId,
            timeoutMs,
          }),
        );
      }, timeoutMs);

      const waiterEntry = {
        resolve: () => {
          clearTimeout(timer);
          try {
            resolve(this.materializeTurn(turnId));
          } catch (error) {
            reject(error);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };

      existing.waiters.push(waiterEntry);
    });
  }

  write(payload) {
    if (!this.proc || !this.proc.stdin) {
      throw makeError("codex app-server stdin is unavailable");
    }

    const line = `${JSON.stringify(payload)}\n`;
    this.proc.stdin.write(line, "utf8");
  }

  handleStdoutLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      if (this.debug) {
        process.stderr.write(`[thread-relay] ignored non-json line: ${line}\n`);
      }
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          makeError(message.error.message || `App-server request failed: ${pending.method}`, {
            code: message.error.code,
            data: message.error.data,
            method: pending.method,
          }),
        );
        return;
      }

      pending.resolve(message);
      return;
    }

    this.handleNotification(message);

    if (this.debug && message.method) {
      process.stderr.write(
        `[thread-relay] notification ${message.method}: ${JSON.stringify(message.params ?? {})}\n`,
      );
    }
  }

  handleNotification(message) {
    const method = message.method;
    const params = message.params ?? {};

    if (method === "turn/started") {
      const turn = params.turn;
      if (turn?.id) {
        const state = this.ensureTurnState(turn.id, params.threadId);
        state.startedTurn = turn;
      }
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const turnId = params.turnId;
      const item = params.item;
      if (!turnId || !item?.id) {
        return;
      }

      const state = this.ensureTurnState(turnId, params.threadId);
      if (!state.itemOrder.includes(item.id)) {
        state.itemOrder.push(item.id);
      }
      state.itemsById.set(item.id, item);
      return;
    }

    if (method === "error") {
      const turnId = params.turnId;
      if (!turnId) {
        return;
      }

      const state = this.ensureTurnState(turnId, params.threadId);
      state.error = params.error ?? null;
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn;
      if (!turn?.id) {
        return;
      }

      const state = this.ensureTurnState(turn.id, params.threadId);
      state.completedTurn = turn;
      if (turn.error) {
        state.error = turn.error;
      }
      this.resolveTurnWaiters(turn.id);
    }
  }

  ensureTurnState(turnId, threadId = null) {
    let state = this.turnStates.get(turnId);
    if (!state) {
      state = {
        threadId,
        startedTurn: null,
        completedTurn: null,
        error: null,
        itemsById: new Map(),
        itemOrder: [],
        waiters: [],
      };
      this.turnStates.set(turnId, state);
    } else if (!state.threadId && threadId) {
      state.threadId = threadId;
    }
    return state;
  }

  materializeTurn(turnId) {
    const state = this.turnStates.get(turnId);
    if (!state) {
      throw makeError(`Unknown turn state: ${turnId}`);
    }

    const base = state.completedTurn || state.startedTurn;
    if (!base) {
      throw makeError(`Incomplete turn state: ${turnId}`);
    }

    return {
      ...base,
      error: state.error || base.error || null,
      items: state.itemOrder
        .map((itemId) => state.itemsById.get(itemId))
        .filter(Boolean),
    };
  }

  resolveTurnWaiters(turnId) {
    const state = this.turnStates.get(turnId);
    if (!state) {
      return;
    }

    const waiters = [...state.waiters];
    state.waiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function extractTurnReply(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const agentMessages = items.filter(
    (item) => item?.type === "agentMessage" && typeof item?.text === "string" && item.text.trim(),
  );
  const finalAnswers = agentMessages.filter((item) => item.phase === "final_answer");
  const primaryMessages = agentMessages.filter((item) => item.phase !== "commentary");
  const winner = finalAnswers.at(-1) || primaryMessages.at(-1) || agentMessages.at(-1);

  if (!winner) {
    return "";
  }

  return winner.text.trim();
}

export function getTurnStatus(turn) {
  if (typeof turn?.status === "string") {
    return turn.status;
  }

  return turn?.status?.type ?? "unknown";
}

export function isTerminalTurn(turn) {
  if (turn?.completedAt) {
    return true;
  }

  const status = getTurnStatus(turn);
  return !["queued", "running", "inProgress"].includes(status);
}

export function isSuccessfulTurn(turn) {
  return getTurnStatus(turn) === "completed" && !turn?.error;
}

export function buildEnvelope(message) {
  const controlSurfaceHint = buildControlSurfaceHint(message);
  return [
    "[Codex Thread Relay]",
    "This request was delegated from another local Codex thread.",
    "Treat the delegated request below exactly as the current user request in this repository.",
    "Follow the repo-local AGENTS.md, repo-local skills, and global skills that would have applied if the user typed it directly.",
    "Approval prompts may be disabled for this delegated thread. Act conservatively: no destructive or high-impact operations, no writes outside the target repo, no force push/history rewrite/bulk delete/deploy/credential mutation unless the user explicitly asked and the repo control surface still allows it.",
    "If the delegated request is a control-surface phrase such as `汇报当前情况`, `继续当前目标`, `处理下一个目标`, `用冲刺模式推进这个目标`, or `用巡航模式推进这个目标`, run the corresponding codex-autonomy flow from the repo root before answering.",
    "Do not answer control-surface status from memory, earlier doctor output, or stale blockers when a fresh codex-autonomy status/report command should be used.",
    ...(controlSurfaceHint ? ["", "Relay control-surface hint:", ...controlSurfaceHint] : []),
    "Complete the task in the current target thread and reply with only the final answer body that should be returned to the source thread.",
    "Do not explain relay mechanics or mention internal tooling unless the task itself requires it.",
    "",
    "Delegated request:",
    message,
  ].join("\n");
}

function buildControlSurfaceHint(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }

  if (text.includes("汇报当前情况")) {
    return [
      "- Run `codex-autonomy status` from the repo root before answering.",
      "- Only use `codex-autonomy report` when the delegated request explicitly asks for a detailed result summary.",
      "- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness, and treat unmanaged diffs as the effective blocker.",
      "- Quote `automation_state`, `ready_for_automation`, `next_automation_reason`, and `report_thread_id` directly from the latest CLI output.",
    ];
  }

  if (text.includes("继续当前目标") || text.includes("处理下一个目标")) {
    return [
      "- Run `codex-autonomy status` from the repo root before doing any work.",
      "- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop.",
      "- If `ready_for_automation=false`, return `next_automation_reason` and stop.",
      "- If `ready_for_automation=true`, continue only one bounded control-surface loop for the current goal.",
    ];
  }

  if (text.includes("用冲刺模式推进这个目标")) {
    return [
      "- Run `codex-autonomy status` from the repo root first.",
      "- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop.",
      "- If there is an active goal and it is not already in sprint mode, switch it to sprint mode before continuing.",
      "- Continue only one bounded sprint loop through the repo-local autonomy control surface.",
    ];
  }

  if (text.includes("用巡航模式推进这个目标")) {
    return [
      "- Run `codex-autonomy status` from the repo root first.",
      "- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop.",
      "- If there is an active goal and it is not already in cruise mode, switch it to cruise mode before continuing.",
      "- Keep the answer bounded to the current ready state unless the delegated request explicitly asks for immediate work.",
    ];
  }

  if (text.includes("确认提案")) {
    return [
      "- Identify the active `awaiting_confirmation` goal from `codex-autonomy status` or the repo control-plane files.",
      "- Run `codex-autonomy approve-proposal --goal-id <goalId>` before answering.",
    ];
  }

  return null;
}

export function normalizeTimeoutSeconds(value, fallbackSeconds) {
  if (value == null) {
    return fallbackSeconds;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw makeError("timeoutSec must be a positive number");
  }

  return Math.trunc(parsed);
}

export function epochishToIso(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  if (typeof value === "number") {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1_000;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  return null;
}
