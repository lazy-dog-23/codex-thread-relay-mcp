import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { relayError } from "./errors.js";

const DEFAULT_STATE = {
  version: 2,
  createdThreads: [],
  activeDispatches: [],
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

function leaseFilePath(threadId) {
  return path.join(locksRoot(), `${Buffer.from(String(threadId)).toString("base64url")}.lease.json`);
}

function normalizeIso(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function normalizeCreatedThread(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const threadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  if (!threadId || !projectId) {
    return null;
  }

  const createdAt = normalizeIso(record.createdAt, new Date(0).toISOString());
  const lastUsedAt = normalizeIso(record.lastUsedAt, createdAt);

  return {
    threadId,
    name: typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : threadId,
    projectId,
    createdAt,
    lastUsedAt,
    lastTurnId: typeof record.lastTurnId === "string" && record.lastTurnId.trim().length > 0 ? record.lastTurnId.trim() : null,
  };
}

function normalizeActiveDispatch(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const threadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const leaseId = typeof record.leaseId === "string" ? record.leaseId.trim() : "";
  const acquiredAt = normalizeIso(record.acquiredAt);
  const expiresAt = normalizeIso(record.expiresAt);

  if (!threadId || !projectId || !leaseId || !acquiredAt || !expiresAt) {
    return null;
  }

  return {
    threadId,
    projectId,
    leaseId,
    acquiredAt,
    expiresAt,
    ownerPid: Number.isInteger(record.ownerPid) ? record.ownerPid : null,
    turnId: typeof record.turnId === "string" && record.turnId.trim().length > 0 ? record.turnId.trim() : null,
  };
}

function normalizeState(value) {
  const createdThreads = Array.isArray(value?.createdThreads)
    ? value.createdThreads.map(normalizeCreatedThread).filter(Boolean)
    : [];
  const activeDispatches = Array.isArray(value?.activeDispatches)
    ? value.activeDispatches.map(normalizeActiveDispatch).filter(Boolean)
    : [];

  return {
    version: 2,
    createdThreads,
    activeDispatches,
  };
}

function cleanupExpiredDispatches(state, now = Date.now()) {
  return {
    ...state,
    activeDispatches: state.activeDispatches.filter((dispatch) => {
      const expiresAt = Date.parse(dispatch.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now;
    }),
  };
}

async function ensureRelayHome() {
  await fs.mkdir(relayHome(), { recursive: true });
  await fs.mkdir(locksRoot(), { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return cleanupExpiredDispatches(normalizeState(JSON.parse(raw)));
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
  const temp = `${target}.tmp`;
  const normalized = cleanupExpiredDispatches(normalizeState(state));
  await fs.writeFile(temp, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(temp, target);
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

async function readLease(threadId) {
  try {
    const raw = await fs.readFile(leaseFilePath(threadId), "utf8");
    return normalizeActiveDispatch(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeLeaseFile(threadId) {
  await fs.rm(leaseFilePath(threadId), { force: true });
}

async function cleanupExpiredLease(threadId, now = Date.now()) {
  const existing = await readLease(threadId);
  if (!existing) {
    return;
  }

  const expiresAt = Date.parse(existing.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    return;
  }

  await removeLeaseFile(threadId);
  await updateState((state) => ({
    ...state,
    activeDispatches: state.activeDispatches.filter((dispatch) => dispatch.threadId !== threadId),
  }));
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
      name: typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : existing?.name ?? String(record.threadId),
      createdAt,
      lastUsedAt,
      lastTurnId: Object.prototype.hasOwnProperty.call(record, "lastTurnId")
        ? (typeof record.lastTurnId === "string" && record.lastTurnId.trim().length > 0 ? record.lastTurnId.trim() : null)
        : existing?.lastTurnId ?? null,
    };

    const filtered = state.createdThreads.filter((item) => item.threadId !== nextRecord.threadId);
    filtered.push(nextRecord);
    return {
      ...state,
      createdThreads: filtered.sort((left, right) =>
        String(right.lastUsedAt || right.createdAt).localeCompare(String(left.lastUsedAt || left.createdAt)),
      ),
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

export async function acquireThreadLease({ threadId, projectId, ttlMs, turnId = null }) {
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
    turnId: typeof turnId === "string" && turnId.trim().length > 0 ? turnId.trim() : null,
  };

  await ensureRelayHome();
  await cleanupExpiredLease(normalizedThreadId, now);

  let handle;
  try {
    handle = await fs.open(leaseFilePath(normalizedThreadId), "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = await readLease(normalizedThreadId);
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
    await removeLeaseFile(normalizedThreadId);
    throw error;
  }

  return {
    ...lease,
    lockPath: leaseFilePath(normalizedThreadId),
  };
}

export async function releaseThreadLease({ threadId, leaseId = null }) {
  const normalizedThreadId = String(threadId);
  await updateState((state) => ({
    ...state,
    activeDispatches: state.activeDispatches.filter((dispatch) =>
      dispatch.threadId !== normalizedThreadId || (leaseId && dispatch.leaseId !== leaseId)),
  }));

  const existing = await readLease(normalizedThreadId);
  if (!existing || !leaseId || existing.leaseId === leaseId) {
    await removeLeaseFile(normalizedThreadId);
  }
}

export function relayStatePath() {
  return stateFilePath();
}
