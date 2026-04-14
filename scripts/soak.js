import assert from "node:assert/strict";
import path from "node:path";

import { CodexAppServerSession } from "../src/app-server-client.js";
import {
  createThreadAction,
  dispatchAsyncAction,
  dispatchRecoverAction,
  dispatchStatusAction,
  listProjectsAction,
  sendWaitAction,
} from "../src/relay-service.js";
import { acquireThreadLease, releaseThreadLease } from "../src/state-store.js";
import { normalizeWindowsPathKey } from "../src/project-registry.js";

function makeReplyMessage(label) {
  return `Reply with exactly "${label}" and nothing else.`;
}

async function withSession(handler) {
  const session = new CodexAppServerSession();
  await session.open();
  try {
    return await handler(session);
  } finally {
    await session.close();
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDispatchCompletion(dispatchId, predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await dispatchStatusAction({ dispatchId });
    if (status.payload.dispatchStatus === "failed" || status.payload.dispatchStatus === "timed_out") {
      const errorText = status.payload.errorCode
        ? `[${status.payload.errorCode}] ${status.payload.errorMessage}`
        : status.payload.dispatchStatus;
      throw new Error(`Dispatch ${dispatchId} ended early: ${errorText}`);
    }
    if (predicate(status.payload)) {
      return status.payload;
    }
    await sleep(2_000);
  }

  throw new Error(`Timed out while waiting for dispatch ${dispatchId}`);
}

async function recoverBatchUntilDelivered(projectId, dispatchIds, timeoutMs = 180_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await withSession((session) => dispatchRecoverAction(session, {
      projectId,
      limit: dispatchIds.length,
    }));

    const statuses = await Promise.all(dispatchIds.map((dispatchId) => dispatchStatusAction({ dispatchId })));
    if (statuses.every((status) => status.payload.callbackStatus === "delivered")) {
      return statuses.map((status) => status.payload);
    }

    await sleep(3_000);
  }

  throw new Error(`Dispatch callbacks stayed pending after batch recovery: ${dispatchIds.join(", ")}`);
}

async function main() {
  const cwdProjectId = process.env.THREAD_RELAY_SOAK_PROJECT_ID || path.resolve(process.cwd());
  const projectKey = normalizeWindowsPathKey(cwdProjectId);
  const iterations = Math.max(4, Number.parseInt(process.env.THREAD_RELAY_SOAK_ITERATIONS ?? "8", 10) || 8);
  const timeoutSec = Math.max(30, Number.parseInt(process.env.THREAD_RELAY_SOAK_TIMEOUT_SEC ?? "120", 10) || 120);
  const concurrency = Math.max(1, Math.min(4, Number.parseInt(process.env.THREAD_RELAY_SOAK_CONCURRENCY ?? "2", 10) || 2));
  const timeoutMs = timeoutSec * 1_000;

  const targetProject = await withSession(async (session) => {
    const listedProjects = await listProjectsAction(session);
    const project = listedProjects.payload.projects.find((candidate) => candidate.pathKey === projectKey);
    assert.ok(project, `Trusted project not found for soak target: ${cwdProjectId}`);
    return project;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mainThread = await withSession((session) => createThreadAction(session, {
    projectId: targetProject.projectId,
    name: `relay soak main ${stamp}`,
  }));

  const targetThreads = [];
  for (let index = 0; index < concurrency; index += 1) {
    targetThreads.push(await withSession((session) => createThreadAction(session, {
      projectId: targetProject.projectId,
      name: `relay soak target ${stamp} ${index + 1}`,
    })));
  }

  for (let index = 0; index < targetThreads.length; index += 1) {
    const warmup = await withSession((session) => sendWaitAction(session, {
      threadId: targetThreads[index].payload.threadId,
      message: makeReplyMessage(`relay soak warmup ${index + 1}`),
      timeoutSec,
    }));
    assert.match(warmup.payload.replyText, new RegExp(`relay soak warmup ${index + 1}`, "i"));
  }

  const batchCount = Math.ceil(iterations / concurrency);
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const forcePending = (batchIndex + 1) % 3 === 0;
    const pendingDispatchIds = [];
    let busyLease = null;

    try {
      if (forcePending) {
        busyLease = await acquireThreadLease({
          threadId: mainThread.payload.threadId,
          projectId: targetProject.projectId,
          ttlMs: 120_000,
        });
      }

      const batchSlots = [];
      for (let slot = 0; slot < concurrency; slot += 1) {
        const iteration = batchIndex * concurrency + slot + 1;
        if (iteration > iterations) {
          break;
        }

        batchSlots.push({
          iteration,
          threadId: targetThreads[slot].payload.threadId,
        });
      }

      const acceptedDispatches = await Promise.all(batchSlots.map(({ iteration, threadId }) =>
        withSession((session) => dispatchAsyncAction(session, {
          projectId: targetProject.projectId,
          threadId,
          message: makeReplyMessage(`relay soak ok ${iteration}`),
          callbackThreadId: mainThread.payload.threadId,
          timeoutSec,
        })),
      ));

      const completedDispatches = await Promise.all(acceptedDispatches.map((accepted, slot) =>
        waitForDispatchCompletion(
          accepted.payload.dispatchId,
          (status) => status.dispatchStatus === "succeeded"
            && (forcePending ? status.callbackStatus === "pending" : status.callbackStatus === "delivered"),
          timeoutMs,
        ).then((status) => ({
          accepted: accepted.payload,
          status,
          iteration: batchSlots[slot].iteration,
        })),
      ));

      for (const completed of completedDispatches) {
        assert.match(completed.status.replyText, new RegExp(`relay soak ok ${completed.iteration}`, "i"));
        if (forcePending) {
          assert.equal(completed.status.recoverySuggested, "deliver_callback");
          pendingDispatchIds.push(completed.accepted.dispatchId);
        }
      }

      if (forcePending) {
        await releaseThreadLease({
          threadId: mainThread.payload.threadId,
          leaseId: busyLease.leaseId,
        });
        busyLease = null;

        const recoveredStatuses = await recoverBatchUntilDelivered(
          targetProject.projectId,
          pendingDispatchIds,
          timeoutMs,
        );
        assert.equal(recoveredStatuses.length, pendingDispatchIds.length);
      }

      for (const accepted of acceptedDispatches) {
        const finalStatus = await dispatchStatusAction({ dispatchId: accepted.payload.dispatchId });
        assert.equal(finalStatus.payload.dispatchStatus, "succeeded");
        assert.equal(finalStatus.payload.callbackStatus, "delivered");
      }

      console.log(`[batch ${batchIndex + 1}/${batchCount}] ${acceptedDispatches.length} dispatch(es) settled`);
    } finally {
      if (busyLease) {
        await releaseThreadLease({
          threadId: mainThread.payload.threadId,
          leaseId: busyLease.leaseId,
        });
      }
    }
  }

  console.log(`relay soak passed (${iterations} iterations, concurrency=${concurrency})`);
}

await main();
