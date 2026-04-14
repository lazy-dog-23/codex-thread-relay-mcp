import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { relayError } from "./errors.js";

const THREAD_LEASE_TTL_MS = 30_000;
const DISPATCH_LEASE_TTL_MS = 30_000;
const THREAD_LEASE_STATUSES = new Set(["queued", "running", "busy", "inProgress"]);
const ASYNC_DISPATCH_STATUSES = new Set(["queued", "running", "succeeded", "failed", "timed_out"]);
const CALLBACK_STATUSES = new Set(["not_requested", "pending", "delivered", "failed"]);

const DEFAULT_STATE = {
  version: 3,
  createdThreads: [],
  activeDispatches: [],
  dispatchRecords: [],
  dispatchLeases: [],
};

function relayHome() {
  return process.env.THREAD_RELAY_HOME || path.join(os.homedir(), ".codex-relay");
}

function stateFilePath() {
  return path.join(relayHome(), "state.json");
}

function locksRoot() {
  return path.join(relayHome(), "locks");
}

function stateLockPath() {
  return path.join(relayHome(), "state.lock.json");
}

function threadLeaseFilePath(threadId) {
  return path.join(locksRoot(), `${Buffer.from(String(threadId)).toString("base64url")}.lease.json`);
}

function dispatchLeaseFilePath(dispatchId) {
  return path.join(locksRoot(), `dispatch-${Buffer.from(String(dispatchId)).toString("base64url")}.lease.json`);
}

function normalizeIso(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function normalizeOptionalString(value, fallback = null) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeOptionalInteger(value, fallback = null) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeCreatedThread(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const threadId = normalizeOptionalString(record.threadId, "");
  const projectId = normalizeOptionalString(record.projectId, "");
  if (!threadId || !projectId) {
    return null;
  }

  const createdAt = normalizeIso(record.createdAt, new Date(0).toISOString());
  const lastUsedAt = normalizeIso(record.lastUsedAt, createdAt);

  return {
    threadId,
    name: normalizeOptionalString(record.name, threadId),
    projectId,
    createdAt,
    lastUsedAt,
    lastTurnId: normalizeOptionalString(record.lastTurnId),
  };
}

function normalizeThreadLease(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const threadId = normalizeOptionalString(record.threadId, "");
  const projectId = normalizeOptionalString(record.projectId, "");
  const leaseId = normalizeOptionalString(record.leaseId, "");
  const acquiredAt = normalizeIso(record.acquiredAt);
  const expiresAt = normalizeIso(record.expiresAt);
  if (!threadId || !projectId || !leaseId || !acquiredAt || !expiresAt) {
    return null;
  }

  const status = normalizeOptionalString(record.status, "running");
  return {
    threadId,
    projectId,
    leaseId,
    acquiredAt,
    expiresAt,
    ownerPid: Number.isInteger(record.ownerPid) ? record.ownerPid : null,
    turnId: normalizeOptionalString(record.turnId),
    status: THREAD_LEASE_STATUSES.has(status) ? status : "running",
  };
}

function normalizeDispatchRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const dispatchId = normalizeOptionalString(record.dispatchId, "");
  const projectId = normalizeOptionalString(record.projectId, "");
  const threadId = normalizeOptionalString(record.threadId, "");
  const threadName = normalizeOptionalString(record.threadName, threadId);
  const message = normalizeOptionalString(record.message, "");
  const resolution = normalizeOptionalString(record.resolution, "by_thread_id");
  const createdAt = normalizeIso(record.createdAt, new Date(0).toISOString());
  const acceptedAt = normalizeIso(record.acceptedAt, createdAt);
  const updatedAt = normalizeIso(record.updatedAt, acceptedAt);
  const dispatchStatus = normalizeOptionalString(record.dispatchStatus, "queued");
  const callbackStatus = normalizeOptionalString(record.callbackStatus, "not_requested");

  if (!dispatchId || !projectId || !threadId || !threadName || !message) {
    return null;
  }

  return {
    dispatchId,
    projectId,
    threadId,
    threadName,
    message,
    timeoutSec: normalizeOptionalInteger(record.timeoutSec),
    created: record.created === true,
    resolution,
    turnId: normalizeOptionalString(record.turnId),
    dispatchStatus: ASYNC_DISPATCH_STATUSES.has(dispatchStatus) ? dispatchStatus : "queued",
    callbackThreadId: normalizeOptionalString(record.callbackThreadId),
    callbackStatus: CALLBACK_STATUSES.has(callbackStatus) ? callbackStatus : "not_requested",
    callbackTurnId: normalizeOptionalString(record.callbackTurnId),
    replyText: normalizeOptionalString(record.replyText),
    errorCode: normalizeOptionalString(record.errorCode),
    errorMessage: normalizeOptionalString(record.errorMessage),
    callbackErrorCode: normalizeOptionalString(record.callbackErrorCode),
    callbackErrorMessage: normalizeOptionalString(record.callbackErrorMessage),
    createdAt,
    acceptedAt,
    updatedAt,
    callbackDeliveredAt: normalizeIso(record.callbackDeliveredAt),
    timingMs: normalizeOptionalInteger(record.timingMs),
    warning: normalizeOptionalString(record.warning),
  };
}

function normalizeDispatchLease(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const dispatchId = normalizeOptionalString(record.dispatchId, "");
  const leaseId = normalizeOptionalString(record.leaseId, "");
  const acquiredAt = normalizeIso(record.acquiredAt);
  const expiresAt = normalizeIso(record.expiresAt);
  if (!dispatchId || !leaseId || !acquiredAt || !expiresAt) {
    return null;
  }

  return {
    dispatchId,
    leaseId,
    acquiredAt,
    expiresAt,
    ownerPid: Number.isInteger(record.ownerPid) ? record.ownerPid : null,
  };
}

function normalizeState(value) {
  const createdThreads = Array.isArray(value?.createdThreads)
    ? value.createdThreads.map(normalizeCreatedThread).filter(Boolean)
    : [];
  const activeDispatches = Array.isArray(value?.activeDispatches)
    ? value.activeDispatches.map(normalizeThreadLease).filter(Boolean)
    : [];
  const dispatchRecords = Array.isArray(value?.dispatchRecords)
    ? value.dispatchRecords.map(normalizeDispatchRecord).filter(Boolean)
    : [];
  const dispatchLeases = Array.isArray(value?.dispatchLeases)
    ? value.dispatchLeases.map(normalizeDispatchLease).filter(Boolean)
    : [];

  return {
    version: 3,
    createdThreads,
    activeDispatches,
    dispatchRecords,
    dispatchLeases,
  };
}

function removeExpiredLeases(items, now = Date.now()) {
  return items.filter((lease) => {
    const expiresAt = Date.parse(lease.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
}

function cleanupExpiredState(state, now = Date.now()) {
  return {
    ...state,
    activeDispatches: removeExpiredLeases(state.activeDispatches, now),
    dispatchLeases: removeExpiredLeases(state.dispatchLeases, now),
  };
}

async function ensureRelayHome() {
  await fs.mkdir(relayHome(), { recursive: true });
  await fs.mkdir(locksRoot(), { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientReplaceError(error) {
  return ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
}

async function readStateLock() {
  try {
    const raw = await fs.readFile(stateLockPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ownerPid: Number.isInteger(parsed?.ownerPid) ? parsed.ownerPid : null,
      acquiredAt: normalizeIso(parsed?.acquiredAt),
      expiresAt: normalizeIso(parsed?.expiresAt),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function acquireStateLock() {
  await ensureRelayHome();
  const staleAfterMs = 30_000;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const acquiredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + staleAfterMs).toISOString();
    let handle;

    try {
      handle = await fs.open(stateLockPath(), "wx");
      await handle.writeFile(JSON.stringify({
        ownerPid: process.pid,
        acquiredAt,
        expiresAt,
      }, null, 2), "utf8");
      return handle;
    } catch (error) {
      if (handle) {
        await handle.close();
      }

      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existing = await readStateLock();
      const existingExpiry = Date.parse(existing?.expiresAt ?? "");
      if (Number.isFinite(existingExpiry) && existingExpiry <= Date.now()) {
        await fs.rm(stateLockPath(), { force: true });
        continue;
      }

      await sleep(100);
    }
  }

  throw relayError("internal_error", "Timed out while acquiring the relay state lock.", {
    statePath: stateFilePath(),
  });
}

async function releaseStateLock(handle) {
  try {
    await handle.close();
  } finally {
    await fs.rm(stateLockPath(), { force: true });
  }
}

async function loadState() {
  await ensureRelayHome();

  try {
    const raw = await fs.readFile(stateFilePath(), "utf8");
    return cleanupExpiredState(normalizeState(JSON.parse(raw)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return structuredClone(DEFAULT_STATE);
    }
    throw error;
  }
}

async function saveState(state) {
  await ensureRelayHome();
  const target = stateFilePath();
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const normalized = cleanupExpiredState(normalizeState(state));
  await fs.writeFile(temp, JSON.stringify(normalized, null, 2), "utf8");
  let renamed = false;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await fs.rename(temp, target);
        renamed = true;
        break;
      } catch (error) {
        if (!isTransientReplaceError(error)) {
          throw error;
        }
        await sleep(25 * (attempt + 1));
      }
    }

    if (!renamed) {
      throw relayError("internal_error", `Could not replace relay state file after retries: ${target}`, {
        statePath: target,
      });
    }
  } finally {
    if (!renamed) {
      await fs.rm(temp, { force: true });
    }
  }
}

async function updateState(mutator) {
  const lockHandle = await acquireStateLock();
  try {
    const current = await loadState();
    const next = await mutator(structuredClone(current));
    await saveState(next);
    return next;
  } finally {
    await releaseStateLock(lockHandle);
  }
}

async function readLeaseFile(filePath, normalizer) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizer(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeLeaseFile(filePath) {
  await fs.rm(filePath, { force: true });
}

async function cleanupExpiredThreadLease(threadId, now = Date.now()) {
  const existing = await readLeaseFile(threadLeaseFilePath(threadId), normalizeThreadLease);
  if (!existing) {
    return;
  }

  const expiresAt = Date.parse(existing.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    return;
  }

  await removeLeaseFile(threadLeaseFilePath(threadId));
  await updateState((state) => ({
    ...state,
    activeDispatches: state.activeDispatches.filter((dispatch) => dispatch.threadId !== threadId),
  }));
}

async function cleanupExpiredDispatchLease(dispatchId, now = Date.now()) {
  const existing = await readLeaseFile(dispatchLeaseFilePath(dispatchId), normalizeDispatchLease);
  if (!existing) {
    return;
  }

  const expiresAt = Date.parse(existing.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    return;
  }

  await removeLeaseFile(dispatchLeaseFilePath(dispatchId));
  await updateState((state) => ({
    ...state,
    dispatchLeases: state.dispatchLeases.filter((lease) => lease.dispatchId !== dispatchId),
  }));
}

function sortCreatedThreads(records) {
  return records.sort((left, right) =>
    String(right.lastUsedAt || right.createdAt).localeCompare(String(left.lastUsedAt || left.createdAt)),
  );
}

function sortDispatchRecords(records) {
  return records.sort((left, right) => String(right.updatedAt || right.acceptedAt).localeCompare(String(left.updatedAt || left.acceptedAt)));
}

function mergeThreadLeaseRecords(stateLease, fileLease) {
  if (!stateLease) {
    return fileLease;
  }
  if (!fileLease) {
    return stateLease;
  }
  if (stateLease.leaseId !== fileLease.leaseId) {
    return stateLease;
  }

  return normalizeThreadLease({
    ...stateLease,
    turnId: fileLease.turnId ?? stateLease.turnId ?? null,
    status: fileLease.status ?? stateLease.status,
    acquiredAt: fileLease.acquiredAt ?? stateLease.acquiredAt,
    expiresAt: fileLease.expiresAt ?? stateLease.expiresAt,
    ownerPid: fileLease.ownerPid ?? stateLease.ownerPid,
  });
}

async function writeThreadLeaseFile(lease) {
  await ensureRelayHome();
  const target = threadLeaseFilePath(lease.threadId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(lease, null, 2), "utf8");
  let renamed = false;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await fs.rename(temp, target);
        renamed = true;
        break;
      } catch (error) {
        if (!isTransientReplaceError(error)) {
          throw error;
        }
        await sleep(25 * (attempt + 1));
      }
    }

    if (!renamed) {
      throw relayError("internal_error", `Could not replace relay lease file after retries: ${target}`, {
        leasePath: target,
      });
    }
  } finally {
    if (!renamed) {
      await fs.rm(temp, { force: true });
    }
  }
}

export async function rememberCreatedThread(record) {
  const nowIso = new Date().toISOString();
  await updateState((state) => {
    const existing = state.createdThreads.find((item) => item.threadId === record.threadId);
    const createdAt = normalizeIso(record.createdAt, existing?.createdAt ?? nowIso);
    const lastUsedAt = normalizeIso(record.lastUsedAt, existing?.lastUsedAt ?? createdAt);
    const nextRecord = {
      threadId: String(record.threadId),
      projectId: String(record.projectId),
      name: normalizeOptionalString(record.name, existing?.name ?? String(record.threadId)),
      createdAt,
      lastUsedAt,
      lastTurnId: Object.prototype.hasOwnProperty.call(record, "lastTurnId")
        ? normalizeOptionalString(record.lastTurnId)
        : existing?.lastTurnId ?? null,
    };

    const filtered = state.createdThreads.filter((item) => item.threadId !== nextRecord.threadId);
    filtered.push(nextRecord);
    return {
      ...state,
      createdThreads: sortCreatedThreads(filtered),
    };
  });
}

export async function forgetCreatedThread(threadId) {
  await updateState((state) => ({
    ...state,
    createdThreads: state.createdThreads.filter((item) => item.threadId !== threadId),
  }));
}

export async function listRememberedThreads(projectId) {
  const state = await loadState();
  if (!projectId) {
    return state.createdThreads;
  }

  return state.createdThreads.filter((item) => item.projectId === projectId);
}

export async function listActiveDispatches(projectId) {
  const state = await loadState();
  if (!projectId) {
    return state.activeDispatches;
  }

  return state.activeDispatches.filter((item) => item.projectId === projectId);
}

export async function listDispatchRecords(projectId) {
  const state = await loadState();
  if (!projectId) {
    return sortDispatchRecords([...state.dispatchRecords]);
  }

  return sortDispatchRecords(state.dispatchRecords.filter((item) => item.projectId === projectId));
}

export async function createDispatchRecord(record) {
  const acceptedAt = normalizeIso(record.acceptedAt, new Date().toISOString());
  const normalized = normalizeDispatchRecord({
    ...record,
    acceptedAt,
    createdAt: normalizeIso(record.createdAt, acceptedAt),
    updatedAt: normalizeIso(record.updatedAt, acceptedAt),
    dispatchStatus: normalizeOptionalString(record.dispatchStatus, "queued"),
    callbackStatus: normalizeOptionalString(
      record.callbackStatus,
      normalizeOptionalString(record.callbackThreadId) ? "pending" : "not_requested",
    ),
  });
  if (!normalized) {
    throw relayError("internal_error", "Dispatch record is incomplete and could not be stored.");
  }

  await updateState((state) => {
    const filtered = state.dispatchRecords.filter((item) => item.dispatchId !== normalized.dispatchId);
    filtered.push(normalized);
    return {
      ...state,
      dispatchRecords: sortDispatchRecords(filtered),
    };
  });

  return normalized;
}

export async function getDispatchRecord(dispatchId) {
  const normalizedDispatchId = normalizeOptionalString(dispatchId, "");
  if (!normalizedDispatchId) {
    return null;
  }

  const state = await loadState();
  return state.dispatchRecords.find((item) => item.dispatchId === normalizedDispatchId) ?? null;
}

export async function getActiveThreadLease(threadId) {
  const normalizedThreadId = normalizeOptionalString(threadId, "");
  if (!normalizedThreadId) {
    return null;
  }

  await cleanupExpiredThreadLease(normalizedThreadId);
  const state = await loadState();
  const stateLease = state.activeDispatches.find((item) => item.threadId === normalizedThreadId) ?? null;
  const fileLease = await readLeaseFile(threadLeaseFilePath(normalizedThreadId), normalizeThreadLease);
  return mergeThreadLeaseRecords(stateLease, fileLease);
}

export async function getActiveDispatchLease(dispatchId) {
  const normalizedDispatchId = normalizeOptionalString(dispatchId, "");
  if (!normalizedDispatchId) {
    return null;
  }

  await cleanupExpiredDispatchLease(normalizedDispatchId);
  const state = await loadState();
  return state.dispatchLeases.find((item) => item.dispatchId === normalizedDispatchId) ?? null;
}

export async function updateDispatchRecord(dispatchId, mutator) {
  const normalizedDispatchId = normalizeOptionalString(dispatchId, "");
  if (!normalizedDispatchId) {
    return null;
  }

  let updatedRecord = null;
  await updateState((state) => {
    const current = state.dispatchRecords.find((item) => item.dispatchId === normalizedDispatchId);
    if (!current) {
      return state;
    }

    const candidate = mutator(structuredClone(current));
    const normalized = normalizeDispatchRecord(candidate);
    if (!normalized) {
      throw relayError("internal_error", `Dispatch ${normalizedDispatchId} could not be normalized after update.`, {
        dispatchId: normalizedDispatchId,
      });
    }

    updatedRecord = normalized;
    const filtered = state.dispatchRecords.filter((item) => item.dispatchId !== normalizedDispatchId);
    filtered.push(normalized);
    return {
      ...state,
      dispatchRecords: sortDispatchRecords(filtered),
    };
  });

  return updatedRecord;
}

export async function updateThreadLease(params) {
  const { threadId, leaseId = null, turnId, status } = params;
  const normalizedThreadId = normalizeOptionalString(threadId, "");
  if (!normalizedThreadId) {
    return null;
  }
  const hasTurnIdPatch = Object.prototype.hasOwnProperty.call(params, "turnId");

  let updatedLease = null;
  await updateState((state) => {
    const current = state.activeDispatches.find((item) => item.threadId === normalizedThreadId);
    if (!current) {
      return state;
    }
    if (leaseId && current.leaseId !== leaseId) {
      return state;
    }

    const normalized = normalizeThreadLease({
      ...current,
      turnId: hasTurnIdPatch
        ? normalizeOptionalString(turnId)
        : current.turnId ?? null,
      status: typeof status === "string" ? status : current.status,
    });
    if (!normalized) {
      throw relayError("internal_error", `Thread lease ${normalizedThreadId} could not be normalized after update.`, {
        threadId: normalizedThreadId,
      });
    }

    updatedLease = normalized;
    const filtered = state.activeDispatches.filter((item) => item.threadId !== normalizedThreadId);
    filtered.push(normalized);
    return {
      ...state,
      activeDispatches: filtered,
    };
  });

  if (!updatedLease) {
    return null;
  }

  const existingFileLease = await readLeaseFile(threadLeaseFilePath(normalizedThreadId), normalizeThreadLease);
  if (existingFileLease && (!leaseId || existingFileLease.leaseId === leaseId)) {
    const mergedLease = normalizeThreadLease({
      ...existingFileLease,
      turnId: updatedLease.turnId ?? existingFileLease.turnId ?? null,
      status: updatedLease.status,
      acquiredAt: updatedLease.acquiredAt,
      expiresAt: updatedLease.expiresAt,
      ownerPid: updatedLease.ownerPid,
    });
    if (mergedLease) {
      await writeThreadLeaseFile(mergedLease);
      updatedLease = mergeThreadLeaseRecords(updatedLease, mergedLease);
    }
  }

  return updatedLease;
}

export async function acquireThreadLease({ threadId, projectId, ttlMs, turnId = null, status = "running" }) {
  const normalizedThreadId = String(threadId);
  const normalizedProjectId = String(projectId);
  const now = Date.now();
  const leaseTtlMs = Math.max(5_000, Math.trunc(ttlMs));
  const lease = {
    threadId: normalizedThreadId,
    projectId: normalizedProjectId,
    leaseId: randomUUID(),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseTtlMs).toISOString(),
    ownerPid: process.pid,
    turnId: normalizeOptionalString(turnId),
    status: THREAD_LEASE_STATUSES.has(status) ? status : "running",
  };

  await ensureRelayHome();
  await cleanupExpiredThreadLease(normalizedThreadId, now);

  let handle;
  try {
    handle = await fs.open(threadLeaseFilePath(normalizedThreadId), "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = await readLeaseFile(threadLeaseFilePath(normalizedThreadId), normalizeThreadLease);
      throw relayError(
        "target_busy",
        `Thread ${normalizedThreadId} already has an active relay dispatch lease.`,
        {
          threadId: normalizedThreadId,
          activeLease: existing,
        },
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify(lease, null, 2), "utf8");
  } finally {
    await handle.close();
  }

  try {
    await updateState((state) => {
      if (state.activeDispatches.some((dispatch) => dispatch.threadId === normalizedThreadId)) {
        throw relayError(
          "target_busy",
          `Thread ${normalizedThreadId} already has an active relay dispatch lease.`,
          {
            threadId: normalizedThreadId,
          },
        );
      }

      state.activeDispatches.push(lease);
      return state;
    });
  } catch (error) {
    await removeLeaseFile(threadLeaseFilePath(normalizedThreadId));
    throw error;
  }

  return {
    ...lease,
    lockPath: threadLeaseFilePath(normalizedThreadId),
  };
}

export async function releaseThreadLease({ threadId, leaseId = null }) {
  const normalizedThreadId = String(threadId);
  await updateState((state) => ({
    ...state,
    activeDispatches: state.activeDispatches.filter((dispatch) =>
      dispatch.threadId !== normalizedThreadId || (leaseId && dispatch.leaseId !== leaseId)),
  }));

  const existing = await readLeaseFile(threadLeaseFilePath(normalizedThreadId), normalizeThreadLease);
  if (!existing || !leaseId || existing.leaseId === leaseId) {
    await removeLeaseFile(threadLeaseFilePath(normalizedThreadId));
  }
}

export async function acquireDispatchLease({ dispatchId, ttlMs }) {
  const normalizedDispatchId = String(dispatchId);
  const now = Date.now();
  const leaseTtlMs = Math.max(5_000, Math.trunc(ttlMs));
  const lease = {
    dispatchId: normalizedDispatchId,
    leaseId: randomUUID(),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseTtlMs).toISOString(),
    ownerPid: process.pid,
  };

  await ensureRelayHome();
  await cleanupExpiredDispatchLease(normalizedDispatchId, now);

  let handle;
  try {
    handle = await fs.open(dispatchLeaseFilePath(normalizedDispatchId), "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = await readLeaseFile(dispatchLeaseFilePath(normalizedDispatchId), normalizeDispatchLease);
      throw relayError("target_busy", `Dispatch ${normalizedDispatchId} already has an active worker lease.`, {
        dispatchId: normalizedDispatchId,
        activeLease: existing,
      });
    }
    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify(lease, null, 2), "utf8");
  } finally {
    await handle.close();
  }

  try {
    await updateState((state) => {
      if (state.dispatchLeases.some((entry) => entry.dispatchId === normalizedDispatchId)) {
        throw relayError("target_busy", `Dispatch ${normalizedDispatchId} already has an active worker lease.`, {
          dispatchId: normalizedDispatchId,
        });
      }

      state.dispatchLeases.push(lease);
      return state;
    });
  } catch (error) {
    await removeLeaseFile(dispatchLeaseFilePath(normalizedDispatchId));
    throw error;
  }

  return {
    ...lease,
    lockPath: dispatchLeaseFilePath(normalizedDispatchId),
  };
}

export async function releaseDispatchLease({ dispatchId, leaseId = null }) {
  const normalizedDispatchId = String(dispatchId);
  await updateState((state) => ({
    ...state,
    dispatchLeases: state.dispatchLeases.filter((lease) =>
      lease.dispatchId !== normalizedDispatchId || (leaseId && lease.leaseId !== leaseId)),
  }));

  const existing = await readLeaseFile(dispatchLeaseFilePath(normalizedDispatchId), normalizeDispatchLease);
  if (!existing || !leaseId || existing.leaseId === leaseId) {
    await removeLeaseFile(dispatchLeaseFilePath(normalizedDispatchId));
  }
}

export function relayStatePath() {
  return stateFilePath();
}
