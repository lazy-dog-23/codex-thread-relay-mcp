#!/usr/bin/env node

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { CodexAppServerSession } from "./app-server-client.js";
import { normalizeRelayError, relayError } from "./errors.js";
import {
  createThreadAction,
  dispatchAction,
  dispatchAsyncAction,
  dispatchDeliverAction,
  dispatchRecoverAction,
  dispatchStatusAction,
  listProjectsAction,
  listThreadsAction,
  sendWaitAction,
} from "./relay-service.js";

const CLI_COMMANDS = {
  relay_list_projects: {
    requiresSession: true,
    handler: (session) => listProjectsAction(session),
  },
  relay_list_threads: {
    requiresSession: true,
    handler: (session, params) => listThreadsAction(session, params),
  },
  relay_create_thread: {
    requiresSession: true,
    handler: (session, params) => createThreadAction(session, params),
  },
  relay_dispatch_async: {
    requiresSession: true,
    handler: (session, params) => dispatchAsyncAction(session, params),
  },
  relay_dispatch_status: {
    requiresSession: true,
    handler: (session, params) => dispatchStatusAction(session, params),
  },
  relay_dispatch_recover: {
    requiresSession: true,
    handler: (session, params) => dispatchRecoverAction(session, params),
  },
  relay_send_wait: {
    requiresSession: true,
    handler: (session, params) => sendWaitAction(session, params),
  },
  relay_dispatch: {
    requiresSession: true,
    handler: (session, params) => dispatchAction(session, params),
  },
  relay_dispatch_deliver: {
    requiresSession: true,
    handler: (session, params) => dispatchDeliverAction(session, params),
  },
};

const RESERVED_OPTIONS = new Set(["json", "help", "paramsFile", "paramsJson", "messageFile"]);

function toCamelCase(value) {
  return String(value)
    .replace(/^[^-]+-/, (segment) => segment)
    .replace(/-([a-z0-9])/gi, (_, character) => character.toUpperCase());
}

function coerceValue(key, value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (["timeoutSec", "limit"].includes(key) && /^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return value;
}

function usageText(commands = CLI_COMMANDS) {
  return [
    "Usage:",
    "  node src/cli.js <command> [--json] [--params-file <file>] [--params-json <json>] [--message-file <file>] [command flags]",
    "",
    "Decision guide:",
    "  1. Same bound thread recurring work -> official Codex thread automation, not relay.",
    "  2. Cross-thread, cross-project, or external wake-ups -> relay_dispatch_async -> relay_dispatch_status -> relay_dispatch_recover.",
    "  3. Short synchronous probe only -> relay_send_wait or relay_dispatch.",
    "",
    "Commands:",
    ...Object.keys(commands).map((name) => `  - ${name}`),
    "",
    "Examples:",
    "  node src/cli.js relay_list_projects --json",
    "  node src/cli.js relay_dispatch_async --project-id <project-id> --thread-id <thread-id> --message-file .\\prompt.md --timeout-sec 300 --json",
    "  node src/cli.js relay_dispatch_status --dispatch-id <dispatch-id> --json",
    "  node src/cli.js relay_dispatch_recover --dispatch-id <dispatch-id> --json",
    "  node src/cli.js relay_send_wait --thread-id <thread-id> --message-file .\\probe.md --timeout-sec 45 --json",
    "",
    "JSON advisory fields:",
    "  usageRole, recommendedSurface, recommendedPattern, whenToUse, whenNotToUse, selectionRule, nextActionSummary",
  ].join("\n");
}

export function parseCliArgs(argv) {
  const args = Array.from(argv ?? []);
  const first = args[0];
  if (!first || first === "--help" || first === "-h") {
    return {
      help: true,
      commandName: null,
      outputJson: false,
      params: {},
      paramsFile: null,
      paramsJson: null,
      messageFile: null,
    };
  }

  const commandName = args.shift();
  const params = {};
  let outputJson = false;
  let help = false;
  let paramsFile = null;
  let paramsJson = null;
  let messageFile = null;

  while (args.length > 0) {
    const current = args.shift();
    if (!current.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${current}`);
    }

    const eqIndex = current.indexOf("=");
    const optionToken = eqIndex >= 0 ? current.slice(0, eqIndex) : current;
    const attachedValue = eqIndex >= 0 ? current.slice(eqIndex + 1) : undefined;
    const optionName = toCamelCase(optionToken.slice(2));
    const nextValue =
      attachedValue !== undefined
        ? attachedValue
        : args[0] && !args[0].startsWith("--")
          ? args.shift()
          : "true";

    if (optionName === "help") {
      help = true;
      continue;
    }
    if (optionName === "json") {
      outputJson = nextValue !== "false";
      continue;
    }
    if (optionName === "paramsFile") {
      paramsFile = nextValue;
      continue;
    }
    if (optionName === "paramsJson") {
      paramsJson = nextValue;
      continue;
    }
    if (optionName === "messageFile") {
      messageFile = nextValue;
      continue;
    }

    params[optionName] = coerceValue(optionName, nextValue);
  }

  return {
    help,
    commandName,
    outputJson,
    params,
    paramsFile,
    paramsJson,
    messageFile,
  };
}

export async function loadCliParams(parsed) {
  let loaded = {};

  if (parsed.paramsJson) {
    loaded = {
      ...loaded,
      ...JSON.parse(parsed.paramsJson),
    };
  }

  if (parsed.paramsFile) {
    const raw = await fs.readFile(parsed.paramsFile, "utf8");
    loaded = {
      ...loaded,
      ...JSON.parse(raw),
    };
  }

  if (parsed.messageFile) {
    loaded.message = await fs.readFile(parsed.messageFile, "utf8");
  }

  return {
    ...loaded,
    ...Object.fromEntries(
      Object.entries(parsed.params).filter(([key]) => !RESERVED_OPTIONS.has(key)),
    ),
  };
}

export async function runCliCommand(commandName, params, options = {}) {
  const commands = options.commands ?? CLI_COMMANDS;
  const command = commands[commandName];
  if (!command) {
    throw relayError("invalid_command", `Unknown relay CLI command: ${commandName}`, {
      commandName,
      supportedCommands: Object.keys(commands),
    });
  }

  let session = null;
  try {
    if (command.requiresSession) {
      const sessionFactory = options.sessionFactory ?? (() => new CodexAppServerSession());
      session = sessionFactory();
      await session.open();
    }

    return await command.handler(session, params);
  } finally {
    if (session) {
      await session.close();
    }
  }
}

function writeOutput(stream, text) {
  stream.write(`${text}\n`);
}

function buildErrorPayload(commandName, error) {
  const normalized = normalizeRelayError(error);
  return {
    ok: false,
    command: commandName,
    relayCode: normalized.relayCode,
    message: normalized.message,
    details: normalized.details,
  };
}

function buildSuccessPayload(commandName, result) {
  return {
    ok: true,
    command: commandName,
    text: result.text,
    payload: result.payload,
  };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed;

  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    writeOutput(stderr, error instanceof Error ? error.message : String(error));
    writeOutput(stderr, usageText(options.commands));
    return 1;
  }

  if (parsed.help) {
    writeOutput(stdout, usageText(options.commands));
    return 0;
  }

  try {
    const params = await loadCliParams(parsed);
    const result = await runCliCommand(parsed.commandName, params, options);
    if (parsed.outputJson) {
      writeOutput(stdout, JSON.stringify(buildSuccessPayload(parsed.commandName, result), null, 2));
    } else {
      writeOutput(stdout, result.text);
    }
    return 0;
  } catch (error) {
    const payload = buildErrorPayload(parsed.commandName, error);
    if (parsed.outputJson) {
      writeOutput(stdout, JSON.stringify(payload, null, 2));
    } else {
      writeOutput(stderr, `[${payload.relayCode}] ${payload.message}`);
    }
    return 1;
  }
}

const directRunArg = process.argv[1];
const isDirectRun = directRunArg
  ? import.meta.url === pathToFileURL(directRunArg).href
  : false;

if (isDirectRun) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
