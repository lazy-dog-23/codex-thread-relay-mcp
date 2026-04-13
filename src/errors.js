import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const RELAY_TO_MCP_CODE = {
  project_untrusted: ErrorCode.InvalidParams,
  thread_not_found: ErrorCode.InvalidParams,
  target_ambiguous: ErrorCode.InvalidParams,
  target_busy: ErrorCode.InvalidRequest,
  app_server_unavailable: ErrorCode.InternalError,
  turn_timeout: ErrorCode.RequestTimeout,
  reply_missing: ErrorCode.InternalError,
  target_turn_failed: ErrorCode.InternalError,
  internal_error: ErrorCode.InternalError,
};

export class RelayError extends Error {
  constructor(relayCode, message, details = {}) {
    super(message);
    this.name = "RelayError";
    this.relayCode = relayCode;
    this.details = details;
  }
}

export function relayError(relayCode, message, details = {}) {
  return new RelayError(relayCode, message, details);
}

export function isRelayError(error) {
  return error instanceof RelayError;
}

export function toMcpError(error) {
  if (error instanceof McpError) {
    return error;
  }

  const normalized = normalizeRelayError(error);
  return new McpError(
    RELAY_TO_MCP_CODE[normalized.relayCode] ?? ErrorCode.InternalError,
    `[${normalized.relayCode}] ${normalized.message}`,
    {
      relayCode: normalized.relayCode,
      ...normalized.details,
    },
  );
}

export function normalizeRelayError(error) {
  if (error instanceof RelayError) {
    return error;
  }

  if (error instanceof McpError) {
    return relayError("internal_error", error.message, {
      mcpCode: error.code,
      data: error.data,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();

  if (trimmed.startsWith("Unknown or untrusted project:")) {
    return relayError("project_untrusted", trimmed, { cause: trimmed });
  }

  if (trimmed.startsWith("Thread not found:")) {
    return relayError("thread_not_found", trimmed, { cause: trimmed });
  }

  if (trimmed.startsWith("target_busy:")) {
    return relayError("target_busy", trimmed.slice("target_busy:".length).trim(), {
      cause: trimmed,
    });
  }

  if (trimmed.startsWith("Target turn failed:")) {
    return relayError("target_turn_failed", trimmed, { cause: trimmed });
  }

  if (trimmed.includes("failed to load rollout")) {
    return relayError("target_turn_failed", trimmed, { cause: trimmed });
  }

  if (trimmed.includes("Target thread completed but returned no final text")) {
    return relayError("reply_missing", trimmed, { cause: trimmed });
  }

  if (
    trimmed.includes("Failed to start codex app-server")
    || trimmed.includes("codex app-server exited unexpectedly")
    || trimmed.includes("codex app-server session")
    || trimmed.includes("Request timed out: initialize")
  ) {
    return relayError("app_server_unavailable", trimmed, { cause: trimmed });
  }

  if (
    trimmed.includes("Timed out while waiting for thread")
    || (error && typeof error === "object" && error.code === "timeout")
  ) {
    return relayError("turn_timeout", trimmed, { cause: trimmed });
  }

  return relayError("internal_error", trimmed || "Unknown relay failure", {
    cause: trimmed || "unknown",
  });
}
