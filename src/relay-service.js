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
  acquireThreadLease,
  forgetCreatedThread,
  listRememberedThreads,
  relayStatePath,
  releaseThreadLease,
  rememberCreatedThread,
} from "./state-store.js";

const DEFAULT_DISPATCH_NAME_PREFIX = "relay dispatch";

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

async function waitForThreadVisibility(session, threadId) {
  let attempt = 0;

  while (attempt < 4) {
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
    await sleep(250 * attempt);
  }

  return null;
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
  } = options;

  if (isTargetBusy(thread)) {
    throw relayError("target_busy", `Thread ${thread.threadId} is already active in Codex.`, {
      threadId: thread.threadId,
      projectId: project.projectId,
      status: thread.status,
    });
  }

  const startedAt = Date.now();
  const timeoutSeconds = normalizeTimeoutSeconds(timeoutSec, Math.ceil(session.turnTimeoutMs / 1000));
  const lease = await acquireThreadLease({
    threadId: thread.threadId,
    projectId: project.projectId,
    ttlMs: timeoutSeconds * 1_000 + 60_000,
  });
  let releaseLeaseOnExit = true;

  try {
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

    const turnId = started?.result?.turn?.id;
    if (!turnId) {
      throw relayError("target_turn_failed", "turn/start did not return a turn id.", {
        threadId: thread.threadId,
      });
    }

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
    await rememberCreatedThread({
      threadId: thread.threadId,
      name: thread.name,
      projectId: project.projectId,
      createdAt: thread.createdAt ?? completedAt,
      lastUsedAt: completedAt,
      lastTurnId: turnId,
    });

    const payload = {
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

    return {
      text: formatTurnResultText(payload),
      payload,
    };
  } catch (error) {
    const normalized = normalizeRelayError(error);
    if (normalized.relayCode === "turn_timeout") {
      releaseLeaseOnExit = false;
    }
    throw normalized;
  } finally {
    if (releaseLeaseOnExit) {
      await releaseThreadLease({
        threadId: thread.threadId,
        leaseId: lease.leaseId,
      });
    }
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
  return deliverMessageToThread(session, {
    project,
    thread,
    message,
    timeoutSec,
    resolution: "by_thread_id",
    created: false,
  });
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

  return deliverMessageToThread(session, {
    project,
    thread: targetThread,
    message,
    timeoutSec,
    resolution: selected.resolution,
    created: selected.created,
    warning,
  });
}
