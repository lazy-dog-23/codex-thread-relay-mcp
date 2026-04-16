import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { buildEnvelope, epochishToIso, extractTurnReply, isSuccessfulTurn, normalizeTimeoutSeconds } from "./app-server-client.js";
import { normalizeRelayError, relayError } from "./errors.js";
import {
  filterThreadsForProject,
  findThreadById,
  getTrustedProjects,
  normalizeWindowsPathKey,
  requireTrustedProject,
} from "./project-registry.js";
import {
  acquireDispatchLease,
  acquireThreadLease,
  createDispatchRecord,
  forgetCreatedThread,
  getActiveDispatchLease,
  getActiveThreadLease,
  getDispatchRecord,
  listDispatchRecords,
  listRememberedThreads,
  relayStatePath,
  releaseDispatchLease,
  releaseThreadLease,
  rememberCreatedThread,
  updateDispatchRecord,
  updateThreadLease,
} from "./state-store.js";

const DEFAULT_DISPATCH_NAME_PREFIX = "relay dispatch";
const DEFAULT_CALLBACK_TIMEOUT_SEC = 90;
const DISPATCH_WORKER_LEASE_MS = 15 * 60 * 1_000;
const DEFAULT_RECOVER_BATCH_LIMIT = 20;
const CALLBACK_EVENT_PREFIX = "[Codex Relay Callback]";
const CALLBACK_EVENT_TYPE = "codex.relay.dispatch.completed.v1";
const CALLBACK_EVENT_JSON_START = "BEGIN_CODEX_RELAY_CALLBACK_JSON";
const CALLBACK_EVENT_JSON_END = "END_CODEX_RELAY_CALLBACK_JSON";
const CALLBACK_PENDING_RETRY_DELAYS_MS = [3_000, 7_000, 15_000];

function isTransientRolloutLoadFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("failed to load rollout") && message.includes("is empty");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatProjectsText(projects) {
  if (projects.length === 0) {
    return "No trusted Windows Codex App projects were found.";
  }

  return [
    `Found ${projects.length} trusted project(s).`,
    ...projects.map((project) => `- ${project.name}: ${project.path}`),
  ].join("\n");
}

function formatThreadsText(project, threads) {
  if (threads.length === 0) {
    return `No matching threads were found in ${project.name}.`;
  }

  return [
    `Found ${threads.length} thread(s) in ${project.name}.`,
    ...threads.map((thread) => {
      const remembered = thread.remembered ? "yes" : "no";
      const lastUsedAt = thread.lastUsedAt ?? "unknown";
      return `- ${thread.name} [${thread.threadId}] status=${thread.status} remembered=${remembered} lastActivityAt=${thread.lastActivityAt ?? "unknown"} lastUsedAt=${lastUsedAt}`;
    }),
  ].join("\n");
}

function formatCreateThreadText(payload) {
  return [
    `Created thread ${payload.threadId} in ${payload.projectName}.`,
    `Name: ${payload.threadName}`,
    `Relay state: ${payload.statePath}`,
    payload.warning ? `Warning: ${payload.warning}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTurnResultText(payload) {
  return [
    `Received reply from thread ${payload.threadId} (${payload.resolution}).`,
    payload.replyText,
  ].join("\n");
}

function formatAsyncDispatchAcceptedText(payload) {
  return [
    `Accepted async relay dispatch ${payload.dispatchId}.`,
    `Target thread: ${payload.threadName} [${payload.threadId}] (${payload.resolution}).`,
    `Callback requested: ${payload.callbackRequested ? "yes" : "no"}.`,
    `Relay state: ${payload.statePath}`,
  ].join("\n");
}

function formatDispatchStatusText(payload) {
  return [
    `Dispatch ${payload.dispatchId}: ${payload.dispatchStatus}.`,
    `Callback: ${payload.callbackStatus}.`,
    `Target thread: ${payload.threadName} [${payload.threadId}].`,
    payload.recoverySuggested ? `Recovery: ${payload.recoverySuggested}.` : null,
    payload.replyText ? `Reply: ${payload.replyText}` : null,
    payload.errorCode ? `Error: [${payload.errorCode}] ${payload.errorMessage}` : null,
    payload.warning ? `Warning: ${payload.warning}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatActiveBusyDispatchText(payload) {
  return [
    `Target thread ${payload.threadName} [${payload.threadId}] is still busy with relay dispatch ${payload.dispatchId}; the new message was not delivered.`,
    payload.turnId ? `Active turn: ${payload.turnId}.` : null,
    `Dispatch ${payload.dispatchId}: ${payload.dispatchStatus}.`,
    payload.recoverySuggested ? `Recovery: ${payload.recoverySuggested}.` : null,
    payload.replyText ? `Reply: ${payload.replyText}` : null,
    payload.errorCode ? `Error: [${payload.errorCode}] ${payload.errorMessage}` : null,
    payload.warning ? `Warning: ${payload.warning}` : null,
    `Relay state: ${payload.statePath}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDeliverStatusText(payload) {
  return [
    `Dispatch ${payload.dispatchId} callback status: ${payload.callbackStatus}.`,
    payload.callbackThreadId ? `Callback thread: ${payload.callbackThreadId}.` : "Callback thread: not requested.",
    payload.replyText ? `Reply: ${payload.replyText}` : null,
    payload.errorCode ? `Dispatch error: [${payload.errorCode}] ${payload.errorMessage}` : null,
    payload.callbackErrorCode ? `Callback error: [${payload.callbackErrorCode}] ${payload.callbackErrorMessage}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRecoverStatusText(payload) {
  return [
    `Dispatch ${payload.dispatchId} recovery action: ${payload.recoveryAction ?? "none"}.`,
    `Dispatch status: ${payload.dispatchStatus}.`,
    `Callback: ${payload.callbackStatus}.`,
    payload.replyText ? `Reply: ${payload.replyText}` : null,
    payload.errorCode ? `Error: [${payload.errorCode}] ${payload.errorMessage}` : null,
    payload.callbackErrorCode ? `Callback error: [${payload.callbackErrorCode}] ${payload.callbackErrorMessage}` : null,
    payload.warning ? `Warning: ${payload.warning}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRecoverBatchText(payload) {
  if (!Array.isArray(payload.recovered) || payload.recovered.length === 0) {
    return [
      `Recovered 0 dispatch(es) from ${payload.scannedCount} scanned.`,
      payload.projectId ? `Project: ${payload.projectId}` : null,
      `Relay state: ${payload.statePath}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `Recovered ${payload.recovered.length} dispatch(es) from ${payload.scannedCount} scanned.`,
    payload.projectId ? `Project: ${payload.projectId}` : null,
    ...payload.recovered.map((item) =>
      `- ${item.dispatchId}: ${item.recoveryAction ?? "none"} -> ${item.dispatchStatus} / ${item.callbackStatus}`,
    ),
    `Relay state: ${payload.statePath}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function requireTrustedProjectSafe(projects, projectId) {
  try {
    return requireTrustedProject(projects, projectId);
  } catch {
    throw relayError("project_untrusted", `Unknown or untrusted project: ${projectId}`, {
      projectId,
    });
  }
}

function isTargetBusy(thread) {
  const type = typeof thread?.status === "string"
    ? thread.status
    : thread?.status?.type ?? "unknown";
  return ["running", "inProgress", "busy"].includes(type);
}

function threadSortKey(thread) {
  return String(thread.lastActivityAt || thread.lastUsedAt || thread.createdAt || "");
}

function buildMatchPreview(threads) {
  return threads.slice(0, 5).map((thread) => ({
    threadId: thread.threadId,
    name: thread.name,
  }));
}

function makeDispatchThreadName(threadName) {
  if (typeof threadName === "string" && threadName.trim().length > 0) {
    return threadName.trim();
  }

  return `${DEFAULT_DISPATCH_NAME_PREFIX} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function filterThreadRows(threads, query) {
  const text = String(query ?? "").trim().toLowerCase();
  if (!text) {
    return threads;
  }

  return threads.filter((thread) => {
    const haystack = [
      thread.threadId,
      thread.name,
      thread.status,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(text);
  });
}

function mergeThreadLists(primaryThreads, rememberedThreads, rememberedRecords) {
  const rememberedById = new Map(rememberedRecords.map((record) => [record.threadId, record]));
  const merged = new Map();

  for (const thread of primaryThreads) {
    const remembered = rememberedById.get(thread.threadId);
    merged.set(thread.threadId, {
      ...thread,
      remembered: Boolean(remembered),
      createdAt: remembered?.createdAt ?? null,
      lastUsedAt: remembered?.lastUsedAt ?? null,
      lastTurnId: remembered?.lastTurnId ?? null,
    });
  }

  for (const thread of rememberedThreads) {
    const existing = merged.get(thread.threadId);
    if (existing) {
      merged.set(thread.threadId, {
        ...existing,
        remembered: true,
        lastUsedAt: thread.lastUsedAt ?? existing.lastUsedAt ?? null,
        lastTurnId: thread.lastTurnId ?? existing.lastTurnId ?? null,
        createdAt: thread.createdAt ?? existing.createdAt ?? null,
      });
      continue;
    }

    merged.set(thread.threadId, thread);
  }

  return [...merged.values()].sort((left, right) => threadSortKey(right).localeCompare(threadSortKey(left)));
}

async function inspectDispatchRuntime(record) {
  const [dispatchLease, threadLease] = await Promise.all([
    getActiveDispatchLease(record.dispatchId),
    getActiveThreadLease(record.threadId),
  ]);
  const dispatchLeaseActive = Boolean(dispatchLease);
  const threadLeaseActive = Boolean(threadLease);
  const threadLeaseTurnId = threadLease?.turnId ?? null;
  const effectiveTurnId = record.turnId ?? threadLeaseTurnId;
  let recoverySuggested = null;
  let warning = null;

  if ((record.dispatchStatus === "queued" || record.dispatchStatus === "running") && dispatchLeaseActive) {
    recoverySuggested = "wait_worker";
    warning = "A relay worker is still active for this dispatch.";
  } else if ((record.dispatchStatus === "queued" || record.dispatchStatus === "running") && effectiveTurnId) {
    recoverySuggested = "resume_turn_wait";
    warning = record.turnId
      ? "An existing target turn id is recorded and can be resumed without replaying the message."
      : "The target turn id was recovered from the active thread lease and can be resumed without replaying the message.";
  } else if ((record.dispatchStatus === "queued" || record.dispatchStatus === "running") && threadLeaseActive) {
    recoverySuggested = "wait_thread_lease_expiry";
    warning = "The target thread still has an active lease but no recorded turn id, so replay is not safe yet.";
  } else if (record.dispatchStatus === "queued" || record.dispatchStatus === "running") {
    recoverySuggested = "restart_dispatch";
    warning = "No active worker or thread lease remains; the dispatch can be restarted safely.";
  } else if (record.dispatchStatus === "timed_out" && effectiveTurnId && !dispatchLeaseActive) {
    recoverySuggested = "resume_timed_out_turn";
    warning = record.turnId
      ? "The target turn timed out locally but still has a recorded turn id that can be resumed."
      : "The target turn timed out locally and its turn id was recovered from the active thread lease.";
  } else if (record.callbackThreadId && record.callbackStatus === "pending") {
    recoverySuggested = "deliver_callback";
    warning = "Callback delivery is pending and can be retried.";
  } else if (record.callbackThreadId && record.callbackStatus === "failed") {
    recoverySuggested = "retry_callback";
    warning = "Callback delivery failed and can be retried explicitly.";
  }

  return {
    dispatchLeaseActive,
    threadLeaseActive,
    threadLeaseTurnId,
    effectiveTurnId,
    recoverySuggested,
    warning,
  };
}

function buildDispatchStatusPayload(record, runtime = {}) {
  return {
    dispatchId: record.dispatchId,
    dispatchStatus: record.dispatchStatus,
    callbackStatus: record.callbackStatus,
    callbackThreadId: record.callbackThreadId,
    threadId: record.threadId,
    threadName: record.threadName,
    projectId: record.projectId,
    created: record.created,
    resolution: record.resolution,
    turnId: runtime.effectiveTurnId ?? record.turnId,
    recordedTurnId: record.turnId ?? undefined,
    threadLeaseTurnId: runtime.threadLeaseTurnId ?? undefined,
    replyText: record.replyText ?? undefined,
    errorCode: record.errorCode ?? undefined,
    errorMessage: record.errorMessage ?? undefined,
    callbackErrorCode: record.callbackErrorCode ?? undefined,
    callbackErrorMessage: record.callbackErrorMessage ?? undefined,
    timingMs: record.timingMs ?? undefined,
    acceptedAt: record.acceptedAt,
    updatedAt: record.updatedAt,
    dispatchLeaseActive: runtime.dispatchLeaseActive ?? false,
    threadLeaseActive: runtime.threadLeaseActive ?? false,
    recoverySuggested: runtime.recoverySuggested ?? undefined,
    warning: runtime.warning ?? undefined,
    statePath: relayStatePath(),
  };
}

function buildCallbackEventPayload(record) {
  return {
    eventType: CALLBACK_EVENT_TYPE,
    dispatchId: record.dispatchId,
    status: record.dispatchStatus,
    callbackStatus: record.callbackStatus,
    callbackThreadId: record.callbackThreadId,
    targetProjectId: record.projectId,
    targetThreadId: record.threadId,
    targetThreadName: record.threadName,
    turnId: record.turnId,
    resolution: record.resolution,
    replyText: record.replyText,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    timingMs: record.timingMs,
  };
}

function buildCallbackMessage(record) {
  const payload = buildCallbackEventPayload(record);
  const payloadText = JSON.stringify(payload, null, 2);
  return [
    CALLBACK_EVENT_PREFIX,
    `Event-Type: ${CALLBACK_EVENT_TYPE}`,
    "This is an async relay completion event delivered back to the operator thread.",
    "Treat it as status/report delivery only, not as a new autonomy goal, proposal, or sprint continuation request.",
    "Do not change report_thread_id or create new goals because of this event alone.",
    "",
    "Machine payload:",
    CALLBACK_EVENT_JSON_START,
    payloadText,
    CALLBACK_EVENT_JSON_END,
    "",
    "Operator task:",
    "- Summarize the dispatch result in this thread.",
    "- If status is succeeded, use replyText as the delegated result.",
    "- If status is failed or timed_out, report the concrete error and stop.",
  ].join("\n");
}

function callbackTimeoutSeconds(record, session) {
  const sessionDefault = Math.ceil(session.turnTimeoutMs / 1000);
  const desired = record?.timeoutSec ?? sessionDefault;
  return Math.max(15, Math.min(DEFAULT_CALLBACK_TIMEOUT_SEC, desired));
}

function recordedTurnTimeoutSeconds(record, session) {
  const sessionDefault = Math.ceil(session.turnTimeoutMs / 1000);
  const desired = normalizeTimeoutSeconds(record?.timeoutSec, sessionDefault);
  return Math.max(sessionDefault, desired);
}

function mergeWarningText(...parts) {
  const merged = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean);
  return merged.length > 0 ? merged.join(" | ") : null;
}

async function annotateActiveThreadLeaseError(error) {
  const normalized = normalizeRelayError(error);
  if (normalized.relayCode !== "target_busy") {
    return normalized;
  }

  const activeLease = normalized.details?.activeLease;
  const activeDispatchId = typeof activeLease?.dispatchId === "string" && activeLease.dispatchId.trim().length > 0
    ? activeLease.dispatchId.trim()
    : null;
  if (!activeDispatchId) {
    return normalized;
  }

  const activeRecord = await getDispatchRecord(activeDispatchId);
  const activeDispatchStatus = activeRecord?.dispatchStatus ?? "running";
  const activeTurnId = activeLease?.turnId ?? activeRecord?.turnId ?? null;
  normalized.details = {
    ...normalized.details,
    activeDispatchId,
    activeDispatchStatus,
    activeTurnId,
    recoverySuggested: "Use relay_dispatch_status or relay_dispatch_recover with the active dispatch id.",
  };
  normalized.message = `Thread ${activeLease.threadId ?? normalized.details?.threadId ?? "unknown"} already has an active relay dispatch lease from dispatch ${activeDispatchId} (${activeDispatchStatus}${activeTurnId ? `, turn ${activeTurnId}` : ""}). Use relay_dispatch_status or relay_dispatch_recover before sending another message.`;
  return normalized;
}

async function buildActiveBusyDispatchResult(error) {
  const normalized = await annotateActiveThreadLeaseError(error);
  const activeDispatchId = typeof normalized.details?.activeDispatchId === "string" && normalized.details.activeDispatchId.trim().length > 0
    ? normalized.details.activeDispatchId.trim()
    : null;
  if (!activeDispatchId) {
    return null;
  }

  const record = await getDispatchRecord(activeDispatchId);
  if (!record) {
    return null;
  }

  const payload = buildDispatchStatusPayload(record, await inspectDispatchRuntime(record));
  return {
    text: formatActiveBusyDispatchText(payload),
    payload: {
      ...payload,
      busy: true,
      newMessageDelivered: false,
    },
  };
}

function workerScriptPath() {
  return fileURLToPath(new URL("./relay-async-worker.js", import.meta.url));
}

function scheduleAsyncDispatchWorker(dispatchId) {
  const child = spawn(
    process.execPath,
    [workerScriptPath(), dispatchId],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
      },
    },
  );
  child.unref();
}

function isTerminalDispatchStatus(status) {
  return ["succeeded", "failed", "timed_out"].includes(status);
}

function normalizeDispatchTerminalError(error) {
  const normalized = normalizeRelayError(error);
  const dispatchStatus = normalized.relayCode === "turn_timeout" ? "timed_out" : "failed";
  return {
    dispatchStatus,
    errorCode: normalized.relayCode,
    errorMessage: normalized.message,
    details: normalized.details ?? {},
  };
}

async function startSyncTimeoutRecoveryDispatch({
  project,
  thread,
  message,
  timeoutSec,
  resolution,
  created,
  warning,
  startedAt,
  turnId,
  timeoutMessage,
  scheduleRecoveryWorker = scheduleAsyncDispatchWorker,
}) {
  const acceptedAt = new Date(startedAt).toISOString();
  const dispatchId = randomUUID();
  let record = await createDispatchRecord({
    dispatchId,
    projectId: project.projectId,
    threadId: thread.threadId,
    threadName: thread.name,
    message,
    timeoutSec,
    created,
    resolution,
    dispatchStatus: "running",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    turnId,
    errorCode: "turn_timeout",
    errorMessage: timeoutMessage,
    createdAt: acceptedAt,
    acceptedAt,
    updatedAt: new Date().toISOString(),
    warning: mergeWarningText(
      warning,
      "Created from a sync relay timeout; the same target turn is continuing in background.",
    ),
  });

  let backgroundRecoveryScheduled = false;
  let schedulingWarning = null;
  try {
    await Promise.resolve(scheduleRecoveryWorker(dispatchId));
    backgroundRecoveryScheduled = true;
  } catch (error) {
    const normalized = normalizeRelayError(error);
    schedulingWarning = `Background recovery worker could not be scheduled: ${normalized.message}`;
    record = await updateDispatchRecord(dispatchId, (current) => ({
      ...current,
      warning: mergeWarningText(current.warning, schedulingWarning),
      updatedAt: new Date().toISOString(),
    })) ?? record;
  }

  return {
    dispatchId,
    record,
    backgroundRecoveryScheduled,
    schedulingWarning,
  };
}

async function rememberThreadTurnResult(project, thread, turnId, completedAt) {
  await rememberCreatedThread({
    threadId: thread.threadId,
    name: thread.name,
    projectId: project.projectId,
    createdAt: thread.createdAt ?? completedAt,
    lastUsedAt: completedAt,
    lastTurnId: turnId,
  });
}

function buildTurnResultPayload(project, thread, resolution, created, turnId, replyText, startedAt, completedAt, warning) {
  return {
    projectId: project.projectId,
    projectName: project.name,
    threadId: thread.threadId,
    threadName: thread.name,
    created,
    resolution,
    turnId,
    replyText,
    timingMs: Date.now() - startedAt,
    lastUsedAt: completedAt,
    statePath: relayStatePath(),
    warning,
  };
}

async function waitForRecordedTurnResult(session, options) {
  const {
    project,
    thread,
    turnId,
    timeoutSec,
    resolution,
    created,
    warning = null,
    startedAt = Date.now(),
  } = options;
  const timeoutSeconds = normalizeTimeoutSeconds(timeoutSec, Math.ceil(session.turnTimeoutMs / 1000));
  const finalTurn = await waitForTurnWithRetry(
    session,
    thread.threadId,
    turnId,
    timeoutSeconds * 1_000,
  );
  if (!isSuccessfulTurn(finalTurn)) {
    const status = typeof finalTurn?.status === "string" ? finalTurn.status : finalTurn?.status?.type;
    const detail = finalTurn?.error?.message || status || "unknown";
    throw relayError("target_turn_failed", `Target turn failed: ${detail}`, {
      threadId: thread.threadId,
      turnId,
      detail,
    });
  }

  const replyText = extractTurnReply(finalTurn);
  if (!replyText) {
    throw relayError("reply_missing", "Target thread completed but returned no final text.", {
      threadId: thread.threadId,
      turnId,
    });
  }

  const completedAt = epochishToIso(finalTurn?.completedAt) || new Date().toISOString();
  await rememberThreadTurnResult(project, thread, turnId, completedAt);
  const payload = buildTurnResultPayload(
    project,
    thread,
    resolution,
    created,
    turnId,
    replyText,
    startedAt,
    completedAt,
    warning,
  );

  return {
    text: formatTurnResultText(payload),
    payload,
  };
}

async function syncDispatchTurnIdFromLease(record, runtime = null) {
  if (record.turnId) {
    return record;
  }

  const activeRuntime = runtime ?? await inspectDispatchRuntime(record);
  if (!activeRuntime.threadLeaseTurnId) {
    return record;
  }

  return updateDispatchRecord(record.dispatchId, (current) => ({
    ...current,
    turnId: activeRuntime.threadLeaseTurnId,
    dispatchStatus: current.dispatchStatus === "queued" ? "running" : current.dispatchStatus,
    updatedAt: new Date().toISOString(),
  })) ?? record;
}

function isActionableRecovery(runtime) {
  return [
    "resume_turn_wait",
    "restart_dispatch",
    "resume_timed_out_turn",
    "deliver_callback",
    "retry_callback",
  ].includes(runtime?.recoverySuggested ?? "");
}

async function getTrustedProjectsFromSession(session) {
  return getTrustedProjects(await session.request("config/read"));
}

async function hydrateRememberedThreads(session, project, listedThreads) {
  const remembered = await listRememberedThreads(project.projectId);
  const seen = new Set(listedThreads.map((item) => item.threadId));
  const hydrated = [];

  for (const candidate of remembered) {
    if (seen.has(candidate.threadId)) {
      continue;
    }

    try {
      const read = await session.request("thread/read", {
        threadId: candidate.threadId,
        includeTurns: false,
      });
      const thread = read?.result?.thread;
      if (!thread?.id) {
        await forgetCreatedThread(candidate.threadId);
        continue;
      }

      hydrated.push({
        threadId: thread.id,
        name: thread.name || candidate.name || thread.id,
        status: thread?.status?.type || "unknown",
        lastActivityAt: candidate.lastUsedAt || candidate.createdAt || null,
        projectId: project.projectId,
        cwd: project.path,
        remembered: true,
        createdAt: candidate.createdAt,
        lastUsedAt: candidate.lastUsedAt,
        lastTurnId: candidate.lastTurnId,
      });
    } catch {
      await forgetCreatedThread(candidate.threadId);
    }
  }

  return {
    hydrated,
    remembered,
  };
}

async function listProjectThreads(session, project) {
  const listedThreads = filterThreadsForProject(await session.listAllThreads(), project);
  const { hydrated, remembered } = await hydrateRememberedThreads(session, project, listedThreads);
  return mergeThreadLists(listedThreads, hydrated, remembered);
}

async function resolveThreadTarget(session, projects, threadId) {
  const listedThreads = await session.listAllThreads();
  const listedThread = findThreadById(listedThreads, threadId);
  if (listedThread) {
    const project = projects.find(
      (item) => item.pathKey === normalizeWindowsPathKey(listedThread.cwd),
    );
    if (!project) {
      throw relayError("project_untrusted", `Thread ${threadId} does not belong to a trusted Windows Codex App project.`, {
        threadId,
      });
    }

    const remembered = (await listRememberedThreads(project.projectId)).find((item) => item.threadId === threadId);
    return {
      project,
      thread: {
        threadId: listedThread.id,
        name: listedThread.name || listedThread.preview || listedThread.id,
        status: listedThread?.status?.type || "unknown",
        lastActivityAt: epochishToIso(listedThread.updatedAt),
        projectId: project.projectId,
        cwd: project.path,
        remembered: Boolean(remembered),
        createdAt: remembered?.createdAt ?? null,
        lastUsedAt: remembered?.lastUsedAt ?? null,
        lastTurnId: remembered?.lastTurnId ?? null,
      },
    };
  }

  const remembered = await listRememberedThreads();
  const rememberedThread = remembered.find((item) => item.threadId === threadId);
  if (!rememberedThread) {
    throw relayError("thread_not_found", `Thread not found: ${threadId}`, {
      threadId,
    });
  }

  const project = requireTrustedProjectSafe(projects, rememberedThread.projectId);
  try {
    const read = await session.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    const thread = read?.result?.thread;
    if (!thread?.id) {
      await forgetCreatedThread(threadId);
      throw relayError("thread_not_found", `Thread not found: ${threadId}`, {
        threadId,
      });
    }

    return {
      project,
      thread: {
        threadId: thread.id,
        name: thread.name || rememberedThread.name || thread.id,
        status: thread?.status?.type || "unknown",
        lastActivityAt: rememberedThread.lastUsedAt || rememberedThread.createdAt || null,
        projectId: project.projectId,
        cwd: project.path,
        remembered: true,
        createdAt: rememberedThread.createdAt,
        lastUsedAt: rememberedThread.lastUsedAt,
        lastTurnId: rememberedThread.lastTurnId,
      },
    };
  } catch (error) {
    const normalized = normalizeRelayError(error);
    if (normalized.relayCode === "app_server_unavailable") {
      throw normalized;
    }

    return {
      project,
      thread: {
        threadId: rememberedThread.threadId,
        name: rememberedThread.name || rememberedThread.threadId,
        status: "unknown",
        lastActivityAt: rememberedThread.lastUsedAt || rememberedThread.createdAt || null,
        projectId: project.projectId,
        cwd: project.path,
        remembered: true,
        createdAt: rememberedThread.createdAt,
        lastUsedAt: rememberedThread.lastUsedAt,
        lastTurnId: rememberedThread.lastTurnId,
      },
    };
  }
}

async function resolveCallbackThreadTarget(session, callbackThreadId) {
  const projects = await getTrustedProjectsFromSession(session);
  try {
    return await resolveThreadTarget(session, projects, callbackThreadId);
  } catch (error) {
    const normalized = normalizeRelayError(error);
    if (normalized.relayCode === "thread_not_found" || normalized.relayCode === "project_untrusted") {
      throw relayError("callback_target_invalid", `Callback thread could not be resolved: ${callbackThreadId}`, {
        callbackThreadId,
        cause: normalized.message,
      });
    }
    throw normalized;
  }
}

export function resolveDispatchThread(threads, selectors) {
  const threadId = selectors?.threadId?.trim();
  const threadName = selectors?.threadName?.trim();
  const query = selectors?.query?.trim();
  const createIfMissing = Boolean(selectors?.createIfMissing);

  if (threadId) {
    const match = threads.find((thread) => thread.threadId === threadId);
    if (!match) {
      throw relayError("thread_not_found", `Thread not found: ${threadId}`, {
        threadId,
      });
    }
    return {
      thread: match,
      resolution: "by_thread_id",
      created: false,
    };
  }

  if (threadName) {
    const exactMatches = threads.filter((thread) => thread.name === threadName);
    if (exactMatches.length === 1) {
      return {
        thread: exactMatches[0],
        resolution: "by_exact_name",
        created: false,
      };
    }

    if (exactMatches.length > 1) {
      throw relayError(
        "target_ambiguous",
        `Multiple threads share the exact name "${threadName}".`,
        {
          threadName,
          matches: buildMatchPreview(exactMatches),
        },
      );
    }
  }

  if (query) {
    const queryMatches = filterThreadRows(threads, query);
    if (queryMatches.length === 1) {
      return {
        thread: queryMatches[0],
        resolution: "by_query_match",
        created: false,
      };
    }

    if (queryMatches.length > 1) {
      throw relayError(
        "target_ambiguous",
        `Multiple threads matched query "${query}".`,
        {
          query,
          matches: buildMatchPreview(queryMatches),
        },
      );
    }
  }

  if (!createIfMissing) {
    throw relayError("thread_not_found", "No matching thread could be resolved for dispatch.", {
      threadId: threadId || null,
      threadName: threadName || null,
      query: query || null,
    });
  }

  return {
    thread: null,
    resolution: "created_new",
    created: true,
  };
}

async function waitForTurnWithRetry(session, threadId, turnId, timeoutMs) {
  let attempt = 0;
  let lastError = null;

  while (attempt < 4) {
    try {
      return await session.waitForTurn(threadId, turnId, timeoutMs);
    } catch (error) {
      if (!isTransientRolloutLoadFailure(error)) {
        throw error;
      }

      lastError = error;
      attempt += 1;
      if (attempt >= 4) {
        throw lastError;
      }

      await sleep(500 * attempt);
    }
  }

  throw lastError;
}

async function waitForThreadVisibility(session, threadId, options = {}) {
  const attemptsLimit = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = Math.max(100, options.baseDelayMs ?? 250);
  let attempt = 0;

  while (attempt < attemptsLimit) {
    try {
      const read = await session.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      const thread = read?.result?.thread;
      if (thread?.id) {
        return thread;
      }
    } catch (error) {
      const normalized = normalizeRelayError(error);
      if (normalized.relayCode === "app_server_unavailable") {
        throw normalized;
      }
    }

    attempt += 1;
    await sleep(baseDelayMs * attempt);
  }

  return null;
}

async function resolveDispatchTarget(session, {
  projectId,
  threadId,
  threadName,
  query,
  createIfMissing = false,
}) {
  const projects = await getTrustedProjectsFromSession(session);
  const project = requireTrustedProjectSafe(projects, projectId);
  const threads = await listProjectThreads(session, project);
  const selected = resolveDispatchThread(threads, {
    threadId,
    threadName,
    query,
    createIfMissing,
  });

  let targetThread = selected.thread;
  let warning = null;
  if (selected.created) {
    const created = await createThreadAction(session, {
      projectId: project.projectId,
      name: makeDispatchThreadName(threadName),
    });
    warning = created.payload.warning ?? null;
    const visibleThread = await waitForThreadVisibility(session, created.payload.threadId);
    targetThread = {
      threadId: created.payload.threadId,
      name: visibleThread?.name || created.payload.threadName,
      status: visibleThread?.status?.type || "idle",
      lastActivityAt: created.payload.lastUsedAt,
      projectId: project.projectId,
      cwd: project.path,
      remembered: true,
      createdAt: created.payload.createdAt,
      lastUsedAt: created.payload.lastUsedAt,
      lastTurnId: created.payload.lastTurnId,
    };
  }

  return {
    project,
    targetThread,
    resolution: selected.resolution,
    created: selected.created,
    warning,
  };
}

export async function deliverMessageToThread(session, options) {
  const {
    project,
    thread,
    message,
    timeoutSec,
    resolution,
    created,
    warning = null,
    onTurnStarted = null,
    createRecoveryDispatchOnTimeout = false,
    scheduleRecoveryWorker = scheduleAsyncDispatchWorker,
  } = options;

  if (isTargetBusy(thread)) {
    const activeLease = await getActiveThreadLease(thread.threadId);
    throw await annotateActiveThreadLeaseError(relayError("target_busy", `Thread ${thread.threadId} is already active in Codex.`, {
      threadId: thread.threadId,
      projectId: project.projectId,
      status: thread.status,
      activeLease,
    }));
  }

  const startedAt = Date.now();
  const timeoutSeconds = normalizeTimeoutSeconds(timeoutSec, Math.ceil(session.turnTimeoutMs / 1000));
  let releaseLeaseOnExit = true;
  let turnId = null;
  let lease = null;

  try {
    try {
      lease = await acquireThreadLease({
        threadId: thread.threadId,
        projectId: project.projectId,
        ttlMs: timeoutSeconds * 1_000 + 60_000,
      });
    } catch (error) {
      throw await annotateActiveThreadLeaseError(error);
    }

    await session.request("thread/resume", { threadId: thread.threadId });
    const started = await session.request(
      "turn/start",
      {
        threadId: thread.threadId,
        cwd: project.path,
        input: [
          {
            type: "text",
            text: buildEnvelope(message),
          },
        ],
      },
      session.turnTimeoutMs,
    );

    turnId = started?.result?.turn?.id;
    if (!turnId) {
      throw relayError("target_turn_failed", "turn/start did not return a turn id.", {
        threadId: thread.threadId,
      });
    }

    await updateThreadLease({
      threadId: thread.threadId,
      leaseId: lease.leaseId,
      turnId,
      status: "running",
    });

    if (typeof onTurnStarted === "function") {
      await onTurnStarted({ turnId });
    }

    return await waitForRecordedTurnResult(session, {
      project,
      thread,
      turnId,
      timeoutSec: timeoutSeconds,
      resolution,
      created,
      warning,
      startedAt,
    });
  } catch (error) {
    const normalized = await annotateActiveThreadLeaseError(error);
    if (normalized.relayCode === "turn_timeout") {
      releaseLeaseOnExit = false;
      normalized.details = {
        ...normalized.details,
        threadId: thread.threadId,
        turnId,
      };
      if (createRecoveryDispatchOnTimeout && turnId) {
        try {
          const recovery = await startSyncTimeoutRecoveryDispatch({
            project,
            thread,
            message,
            timeoutSec: timeoutSeconds,
            resolution,
            created,
            warning,
            startedAt,
            turnId,
            timeoutMessage: normalized.message,
            scheduleRecoveryWorker,
          });
          await updateThreadLease({
            threadId: thread.threadId,
            leaseId: lease?.leaseId ?? null,
            dispatchId: recovery.dispatchId,
          });
          normalized.details = {
            ...normalized.details,
            recoveryDispatchId: recovery.dispatchId,
            recoveryDispatchStatus: recovery.record.dispatchStatus,
            recoveryScheduled: recovery.backgroundRecoveryScheduled,
            recoveryStatePath: relayStatePath(),
            recoverySuggested: "Use relay_dispatch_status or relay_dispatch_recover with this dispatch id.",
            recoveryWarning: recovery.schedulingWarning ?? undefined,
          };
          normalized.message = recovery.backgroundRecoveryScheduled
            ? `${normalized.message} Recovery dispatch ${recovery.dispatchId} is continuing in background.`
            : `${normalized.message} Recovery dispatch ${recovery.dispatchId} was recorded for manual recovery.`;
        } catch (recoveryError) {
          const recoveryFailure = normalizeRelayError(recoveryError);
          normalized.details = {
            ...normalized.details,
            recoverySuggested: "Wait for the active thread lease to expire, or inspect the target thread manually before replaying.",
            recoveryRecordingError: recoveryFailure.message,
          };
        }
      }
    }
    throw normalized;
  } finally {
    if (releaseLeaseOnExit && lease?.leaseId) {
      await releaseThreadLease({
        threadId: thread.threadId,
        leaseId: lease.leaseId,
      });
    }
  }
}

async function tryDeliverCallback(session, record, callbackThreadId = record.callbackThreadId, options = {}) {
  const normalizedCallbackThreadId = typeof callbackThreadId === "string" && callbackThreadId.trim().length > 0
    ? callbackThreadId.trim()
    : null;

  if (!normalizedCallbackThreadId) {
    const updated = await updateDispatchRecord(record.dispatchId, (current) => ({
      ...current,
      callbackThreadId: null,
      callbackStatus: "not_requested",
      callbackTurnId: null,
      callbackErrorCode: null,
      callbackErrorMessage: null,
      updatedAt: new Date().toISOString(),
    }));
    return { record: updated ?? record, delivered: false };
  }

  let callbackTarget;
  try {
    callbackTarget = await resolveCallbackThreadTarget(session, normalizedCallbackThreadId);
  } catch (error) {
    const normalized = normalizeRelayError(error);
    if (options.throwOnInvalidTarget === true) {
      throw normalized;
    }

    const updated = await updateDispatchRecord(record.dispatchId, (current) => ({
      ...current,
      callbackThreadId: normalizedCallbackThreadId,
      callbackStatus: "failed",
      callbackTurnId: null,
      callbackErrorCode: normalized.relayCode,
      callbackErrorMessage: normalized.message,
      updatedAt: new Date().toISOString(),
    }));
    return {
      record: updated ?? record,
      delivered: false,
      error: normalized,
    };
  }

  try {
    const delivered = await deliverMessageToThread(session, {
      project: callbackTarget.project,
      thread: callbackTarget.thread,
      message: buildCallbackMessage({
        ...record,
        callbackThreadId: normalizedCallbackThreadId,
      }),
      timeoutSec: callbackTimeoutSeconds(record, session),
      resolution: "by_thread_id",
      created: false,
    });

    const updated = await updateDispatchRecord(record.dispatchId, (current) => ({
      ...current,
      callbackThreadId: normalizedCallbackThreadId,
      callbackStatus: "delivered",
      callbackTurnId: delivered.payload.turnId,
      callbackErrorCode: null,
      callbackErrorMessage: null,
      callbackDeliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    return { record: updated ?? record, delivered: true, result: delivered };
  } catch (error) {
    const normalized = normalizeRelayError(error);
    const callbackStatus = normalized.relayCode === "target_busy" ? "pending" : "failed";
    const updated = await updateDispatchRecord(record.dispatchId, (current) => ({
      ...current,
      callbackThreadId: normalizedCallbackThreadId,
      callbackStatus,
      callbackTurnId: null,
      callbackErrorCode: normalized.relayCode,
      callbackErrorMessage: normalized.message,
      updatedAt: new Date().toISOString(),
    }));
    return {
      record: updated ?? record,
      delivered: false,
      error: normalized,
    };
  }
}

async function retryPendingCallbackDelivery(session, record, delaysMs = CALLBACK_PENDING_RETRY_DELAYS_MS) {
  let currentRecord = record;

  for (const delayMs of delaysMs) {
    if (currentRecord.callbackStatus !== "pending") {
      break;
    }

    await sleep(delayMs);
    const attempt = await tryDeliverCallback(session, currentRecord);
    currentRecord = attempt.record;
  }

  return currentRecord;
}

async function executeDispatchTurn(session, dispatchId, record) {
  const projects = await getTrustedProjectsFromSession(session);
  const resolvedTarget = await resolveThreadTarget(session, projects, record.threadId);
  const visibleCreatedThread = record.created
    ? await waitForThreadVisibility(session, resolvedTarget.thread.threadId, {
      attempts: 8,
      baseDelayMs: 500,
    })
    : null;
  const target = visibleCreatedThread?.id
    ? {
      ...resolvedTarget,
      thread: {
        ...resolvedTarget.thread,
        threadId: visibleCreatedThread.id,
        name: visibleCreatedThread.name || resolvedTarget.thread.name,
        status: visibleCreatedThread?.status?.type || resolvedTarget.thread.status,
      },
    }
    : resolvedTarget;
  if (record.turnId) {
    const startedAt = Date.parse(record.acceptedAt ?? record.updatedAt ?? "") || Date.now();
    const matchingLease = await getActiveThreadLease(target.thread.threadId);
    return {
      target,
      result: await (async () => {
        try {
          const resumedResult = await waitForRecordedTurnResult(session, {
            project: target.project,
            thread: target.thread,
            turnId: record.turnId,
            timeoutSec: recordedTurnTimeoutSeconds(record, session),
            resolution: record.resolution,
            created: record.created,
            warning: record.warning ?? null,
            startedAt,
          });
          if (matchingLease?.turnId === record.turnId) {
            await releaseThreadLease({
              threadId: target.thread.threadId,
              leaseId: matchingLease.leaseId,
            });
          }
          return resumedResult;
        } catch (error) {
          const normalized = normalizeRelayError(error);
          if (matchingLease?.turnId === record.turnId && normalized.relayCode !== "turn_timeout") {
            await releaseThreadLease({
              threadId: target.thread.threadId,
              leaseId: matchingLease.leaseId,
            });
          }
          throw normalized;
        }
      })(),
    };
  }

  return {
    target,
    result: await (async () => {
      try {
        return await deliverMessageToThread(session, {
          project: target.project,
          thread: target.thread,
          message: record.message,
          timeoutSec: record.timeoutSec,
          resolution: record.resolution,
          created: record.created,
          warning: record.warning ?? null,
          onTurnStarted: async ({ turnId }) => {
            await updateDispatchRecord(dispatchId, (current) => ({
              ...current,
              projectId: target.project.projectId,
              threadId: target.thread.threadId,
              threadName: target.thread.name,
              turnId,
              dispatchStatus: "running",
              updatedAt: new Date().toISOString(),
            }));
          },
        });
      } catch (error) {
        const normalized = normalizeRelayError(error);
        if (!record.created || normalized.relayCode !== "thread_not_found") {
          throw normalized;
        }

        const retriedVisibleThread = await waitForThreadVisibility(session, target.thread.threadId, {
          attempts: 8,
          baseDelayMs: 500,
        });
        if (!retriedVisibleThread?.id) {
          throw normalized;
        }

        return deliverMessageToThread(session, {
          project: target.project,
          thread: {
            ...target.thread,
            threadId: retriedVisibleThread.id,
            name: retriedVisibleThread.name || target.thread.name,
            status: retriedVisibleThread?.status?.type || target.thread.status,
          },
          message: record.message,
          timeoutSec: record.timeoutSec,
          resolution: record.resolution,
          created: record.created,
          warning: record.warning ?? null,
          onTurnStarted: async ({ turnId }) => {
            await updateDispatchRecord(dispatchId, (current) => ({
              ...current,
              projectId: target.project.projectId,
              threadId: target.thread.threadId,
              threadName: target.thread.name,
              turnId,
              dispatchStatus: "running",
              updatedAt: new Date().toISOString(),
            }));
          },
        });
      }
    })(),
  };
}

async function completeDispatchRecord(session, dispatchId, activeRecord, options = {}) {
  const allowTimedOutTurnRecovery = options.allowTimedOutTurnRecovery === true;
  const allowFailedCallbackRetry = options.allowFailedCallbackRetry === true;
  const callbackRetryDelaysMs = Array.isArray(options.callbackRetryDelaysMs)
    ? options.callbackRetryDelaysMs
    : CALLBACK_PENDING_RETRY_DELAYS_MS;

  let terminalRecord = activeRecord;
  const shouldRunTargetTurn = !isTerminalDispatchStatus(activeRecord.dispatchStatus)
    || (allowTimedOutTurnRecovery && activeRecord.dispatchStatus === "timed_out" && activeRecord.turnId);

  if (shouldRunTargetTurn) {
    try {
      const { target, result } = await executeDispatchTurn(session, dispatchId, activeRecord);
      terminalRecord = await updateDispatchRecord(dispatchId, (current) => ({
        ...current,
        projectId: target.project.projectId,
        threadId: target.thread.threadId,
        threadName: target.thread.name,
        turnId: result.payload.turnId,
        dispatchStatus: "succeeded",
        replyText: result.payload.replyText,
        errorCode: null,
        errorMessage: null,
        timingMs: result.payload.timingMs,
        warning: result.payload.warning ?? null,
        updatedAt: new Date().toISOString(),
      })) ?? activeRecord;
    } catch (error) {
      const terminalError = normalizeDispatchTerminalError(error);
      terminalRecord = await updateDispatchRecord(dispatchId, (current) => ({
        ...current,
        dispatchStatus: terminalError.dispatchStatus,
        errorCode: terminalError.errorCode,
        errorMessage: terminalError.errorMessage,
        turnId: terminalError.details.turnId ?? current.turnId ?? null,
        updatedAt: new Date().toISOString(),
      })) ?? activeRecord;
    }
  }

  if (!terminalRecord.callbackThreadId) {
    return updateDispatchRecord(dispatchId, (current) => ({
      ...current,
      callbackStatus: "not_requested",
      updatedAt: new Date().toISOString(),
    })) ?? terminalRecord;
  }

  const shouldRetryCallback = terminalRecord.callbackStatus === "pending"
    || (allowFailedCallbackRetry && terminalRecord.callbackStatus === "failed")
    || terminalRecord.callbackStatus === "not_requested";
  if (!shouldRetryCallback) {
    return terminalRecord;
  }

  const callbackAttempt = await tryDeliverCallback(session, terminalRecord);
  if (callbackAttempt.record.callbackStatus === "pending") {
    return retryPendingCallbackDelivery(session, callbackAttempt.record, callbackRetryDelaysMs);
  }
  return callbackAttempt.record;
}

export async function processAsyncDispatchWithSession(session, dispatchId, options = {}) {
  const storedRecord = await getDispatchRecord(dispatchId);
  if (!storedRecord) {
    throw relayError("dispatch_not_found", `Dispatch not found: ${dispatchId}`, {
      dispatchId,
    });
  }
  const record = await syncDispatchTurnIdFromLease(storedRecord);

  const allowTimedOutTurnRecovery = options.allowTimedOutTurnRecovery === true;
  const allowFailedCallbackRetry = options.allowFailedCallbackRetry === true;
  const callbackRecoverable = record.callbackStatus === "pending"
    || (allowFailedCallbackRetry && record.callbackStatus === "failed");
  const timedOutRecoverable = allowTimedOutTurnRecovery && record.dispatchStatus === "timed_out" && record.turnId;
  if (isTerminalDispatchStatus(record.dispatchStatus) && !callbackRecoverable && !timedOutRecoverable) {
    return record;
  }

  const lease = await acquireDispatchLease({
    dispatchId,
    ttlMs: DISPATCH_WORKER_LEASE_MS,
  });

  try {
    const runningRecord = await updateDispatchRecord(dispatchId, (current) => ({
      ...current,
      dispatchStatus: isTerminalDispatchStatus(current.dispatchStatus) ? current.dispatchStatus : "running",
      updatedAt: new Date().toISOString(),
    }));
    const activeRecord = runningRecord ?? record;
    return await completeDispatchRecord(session, dispatchId, activeRecord, {
      allowTimedOutTurnRecovery,
      allowFailedCallbackRetry,
    });
  } finally {
    await releaseDispatchLease({
      dispatchId,
      leaseId: lease.leaseId,
    });
  }
}

export async function listProjectsAction(session) {
  const projects = await getTrustedProjectsFromSession(session);
  return {
    text: formatProjectsText(projects),
    payload: { projects },
  };
}

export async function listThreadsAction(session, { projectId, query }) {
  const projects = await getTrustedProjectsFromSession(session);
  const project = requireTrustedProjectSafe(projects, projectId);
  const allThreads = await listProjectThreads(session, project);
  const threads = filterThreadRows(allThreads, query);
  return {
    text: formatThreadsText(project, threads),
    payload: {
      project,
      threads,
      statePath: relayStatePath(),
    },
  };
}

export async function createThreadAction(session, { projectId, name }) {
  const projects = await getTrustedProjectsFromSession(session);
  const project = requireTrustedProjectSafe(projects, projectId);
  const createdAt = new Date().toISOString();
  const created = await session.request("thread/start", {
    cwd: project.path,
  });
  const thread = created?.result?.thread;
  if (!thread?.id) {
    throw relayError("target_turn_failed", "thread/start did not return a thread id.", {
      projectId: project.projectId,
    });
  }

  let finalName = thread.name || name || thread.id;
  let warning = null;
  if (name) {
    try {
      await session.request("thread/name/set", {
        threadId: thread.id,
        name,
      });
      finalName = name;
    } catch (error) {
      warning = `Thread created but rename failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  await rememberCreatedThread({
    threadId: thread.id,
    name: finalName,
    projectId: project.projectId,
    createdAt,
    lastUsedAt: createdAt,
    lastTurnId: null,
  });

  const payload = {
    threadId: thread.id,
    name: finalName,
    threadName: finalName,
    projectId: project.projectId,
    projectName: project.name,
    created: true,
    createdAt,
    lastUsedAt: createdAt,
    lastTurnId: null,
    statePath: relayStatePath(),
    warning,
  };

  return {
    text: formatCreateThreadText(payload),
    payload,
  };
}

export async function sendWaitAction(session, { threadId, message, timeoutSec }) {
  const projects = await getTrustedProjectsFromSession(session);
  const { project, thread } = await resolveThreadTarget(session, projects, threadId);
  try {
    return await deliverMessageToThread(session, {
      project,
      thread,
      message,
      timeoutSec,
      resolution: "by_thread_id",
      created: false,
      createRecoveryDispatchOnTimeout: true,
      scheduleRecoveryWorker: scheduleAsyncDispatchWorker,
    });
  } catch (error) {
    const busyResult = await buildActiveBusyDispatchResult(error);
    if (busyResult) {
      return busyResult;
    }
    throw error;
  }
}

export async function dispatchAction(session, {
  projectId,
  message,
  threadId,
  threadName,
  query,
  createIfMissing = false,
  timeoutSec,
}) {
  const target = await resolveDispatchTarget(session, {
    projectId,
    threadId,
    threadName,
    query,
    createIfMissing,
  });

  try {
    return await deliverMessageToThread(session, {
      project: target.project,
      thread: target.targetThread,
      message,
      timeoutSec,
      resolution: target.resolution,
      created: target.created,
      warning: target.warning,
      createRecoveryDispatchOnTimeout: true,
      scheduleRecoveryWorker: scheduleAsyncDispatchWorker,
    });
  } catch (error) {
    const busyResult = await buildActiveBusyDispatchResult(error);
    if (busyResult) {
      return busyResult;
    }
    throw error;
  }
}

export async function dispatchAsyncAction(session, {
  projectId,
  message,
  threadId,
  threadName,
  query,
  createIfMissing = false,
  timeoutSec,
  callbackThreadId,
}) {
  const target = await resolveDispatchTarget(session, {
    projectId,
    threadId,
    threadName,
    query,
    createIfMissing,
  });
  const normalizedTimeoutSec = normalizeTimeoutSeconds(timeoutSec, Math.ceil(session.turnTimeoutMs / 1000));
  const acceptedAt = new Date().toISOString();
  const dispatchId = randomUUID();
  const record = await createDispatchRecord({
    dispatchId,
    projectId: target.project.projectId,
    threadId: target.targetThread.threadId,
    threadName: target.targetThread.name,
    message,
    timeoutSec: normalizedTimeoutSec,
    created: target.created,
    resolution: target.resolution,
    dispatchStatus: "queued",
    callbackThreadId,
    callbackStatus: callbackThreadId ? "pending" : "not_requested",
    createdAt: acceptedAt,
    acceptedAt,
    updatedAt: acceptedAt,
    warning: target.warning,
  });

  try {
    scheduleAsyncDispatchWorker(dispatchId);
  } catch (error) {
    const normalized = normalizeRelayError(error);
    await updateDispatchRecord(dispatchId, (current) => ({
      ...current,
      dispatchStatus: "failed",
      errorCode: normalized.relayCode,
      errorMessage: normalized.message,
      updatedAt: new Date().toISOString(),
    }));
    throw relayError("internal_error", `Failed to schedule async relay dispatch ${dispatchId}.`, {
      dispatchId,
      cause: normalized.message,
    });
  }

  const payload = {
    dispatchId: record.dispatchId,
    projectId: record.projectId,
    threadId: record.threadId,
    threadName: record.threadName,
    created: record.created,
    resolution: record.resolution,
    acceptedAt: record.acceptedAt,
    callbackRequested: Boolean(record.callbackThreadId),
    statePath: relayStatePath(),
  };
  return {
    text: formatAsyncDispatchAcceptedText(payload),
    payload,
  };
}

export async function dispatchStatusAction({ dispatchId }) {
  const record = await getDispatchRecord(dispatchId);
  if (!record) {
    throw relayError("dispatch_not_found", `Dispatch not found: ${dispatchId}`, {
      dispatchId,
    });
  }

  const payload = buildDispatchStatusPayload(record, await inspectDispatchRuntime(record));
  return {
    text: formatDispatchStatusText(payload),
    payload,
  };
}

async function recoverSingleDispatch(session, { dispatchId, callbackThreadId }) {
  const record = await getDispatchRecord(dispatchId);
  if (!record) {
    throw relayError("dispatch_not_found", `Dispatch not found: ${dispatchId}`, {
      dispatchId,
    });
  }

  const initialRuntime = await inspectDispatchRuntime(record);
  const syncedRecord = await syncDispatchTurnIdFromLease(record, initialRuntime);
  let runtime = syncedRecord === record ? initialRuntime : await inspectDispatchRuntime(syncedRecord);
  const normalizedCallbackThreadId = typeof callbackThreadId === "string" && callbackThreadId.trim().length > 0
    ? callbackThreadId.trim()
    : syncedRecord.callbackThreadId;
  let workingRecord = syncedRecord;

  if (normalizedCallbackThreadId && normalizedCallbackThreadId !== syncedRecord.callbackThreadId) {
    workingRecord = await updateDispatchRecord(dispatchId, (current) => ({
      ...current,
      callbackThreadId: normalizedCallbackThreadId,
      callbackStatus: current.callbackStatus === "delivered" ? current.callbackStatus : "pending",
      callbackErrorCode: null,
      callbackErrorMessage: null,
      updatedAt: new Date().toISOString(),
    })) ?? syncedRecord;
    runtime = await inspectDispatchRuntime(workingRecord);
  }
  const recoveryAction = runtime.recoverySuggested ?? "none";

  if (runtime.dispatchLeaseActive) {
    const payload = {
      ...buildDispatchStatusPayload(workingRecord, runtime),
      recoveryAction,
    };
    return {
      text: formatRecoverStatusText(payload),
      payload,
    };
  }

  if ((workingRecord.dispatchStatus === "queued" || workingRecord.dispatchStatus === "running")
    && !workingRecord.turnId
    && !runtime.threadLeaseTurnId
    && runtime.threadLeaseActive) {
    const payload = {
      ...buildDispatchStatusPayload(workingRecord, runtime),
      recoveryAction,
    };
    return {
      text: formatRecoverStatusText(payload),
      payload,
    };
  }

  const allowTimedOutTurnRecovery = workingRecord.dispatchStatus === "timed_out" && Boolean(workingRecord.turnId);
  const allowFailedCallbackRetry = workingRecord.callbackStatus === "failed";
  const recoveredRecord = await processAsyncDispatchWithSession(session, dispatchId, {
    allowTimedOutTurnRecovery,
    allowFailedCallbackRetry,
  });
  const payload = {
    ...buildDispatchStatusPayload(recoveredRecord, await inspectDispatchRuntime(recoveredRecord)),
    recoveryAction,
  };
  return {
    text: formatRecoverStatusText(payload),
    payload,
  };
}

export async function dispatchDeliverAction(session, { dispatchId, callbackThreadId }) {
  const record = await getDispatchRecord(dispatchId);
  if (!record) {
    throw relayError("dispatch_not_found", `Dispatch not found: ${dispatchId}`, {
      dispatchId,
    });
  }

  const normalizedCallbackThreadId = typeof callbackThreadId === "string" && callbackThreadId.trim().length > 0
    ? callbackThreadId.trim()
    : record.callbackThreadId;
  if (!normalizedCallbackThreadId) {
    throw relayError("callback_target_invalid", `Dispatch ${dispatchId} does not have a callback thread.`, {
      dispatchId,
    });
  }

  if (!isTerminalDispatchStatus(record.dispatchStatus)) {
    const payload = buildDispatchStatusPayload({
      ...record,
      callbackThreadId: normalizedCallbackThreadId,
    }, await inspectDispatchRuntime(record));
    return {
      text: formatDeliverStatusText(payload),
      payload,
    };
  }

  const callbackAttempt = await tryDeliverCallback(session, record, normalizedCallbackThreadId, {
    throwOnInvalidTarget: true,
  });
  const payload = buildDispatchStatusPayload(callbackAttempt.record, await inspectDispatchRuntime(callbackAttempt.record));
  return {
    text: formatDeliverStatusText(payload),
    payload,
  };
}

export async function dispatchRecoverAction(session, { dispatchId, projectId, callbackThreadId, limit }) {
  if (typeof dispatchId === "string" && dispatchId.trim().length > 0) {
    return recoverSingleDispatch(session, { dispatchId, callbackThreadId });
  }

  let normalizedProjectId = null;
  if (typeof projectId === "string" && projectId.trim().length > 0) {
    const projects = await getTrustedProjectsFromSession(session);
    normalizedProjectId = requireTrustedProjectSafe(projects, projectId).projectId;
  }

  const parsedLimit = Number.parseInt(String(limit ?? DEFAULT_RECOVER_BATCH_LIMIT), 10);
  const recoverLimit = Math.max(
    1,
    Math.min(DEFAULT_RECOVER_BATCH_LIMIT, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_RECOVER_BATCH_LIMIT),
  );
  const records = await listDispatchRecords(normalizedProjectId);
  const candidates = [];

  for (const record of records) {
    const runtime = await inspectDispatchRuntime(record);
    if (!isActionableRecovery(runtime) || runtime.dispatchLeaseActive) {
      continue;
    }

    candidates.push(record);
    if (candidates.length >= recoverLimit) {
      break;
    }
  }

  const recovered = [];
  for (const record of candidates) {
    recovered.push((await recoverSingleDispatch(session, {
      dispatchId: record.dispatchId,
      callbackThreadId,
    })).payload);
  }

  const payload = {
    projectId: normalizedProjectId,
    recovered,
    scannedCount: records.length,
    recoveredCount: recovered.length,
    statePath: relayStatePath(),
  };
  return {
    text: formatRecoverBatchText(payload),
    payload,
  };
}
