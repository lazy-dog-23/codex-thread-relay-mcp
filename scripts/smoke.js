import assert from "node:assert/strict";
import path from "node:path";

import { CodexAppServerSession } from "../src/app-server-client.js";
import { RelayError } from "../src/errors.js";
import {
  createThreadAction,
  deliverMessageToThread,
  dispatchAction,
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

async function waitForDispatchCompletion(dispatchId, predicate, timeoutMs = 180_000) {
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

async function recoverDispatchDelivery(dispatchId, maxAttempts = 10) {
  let lastPayload = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await withSession((session) => dispatchRecoverAction(session, {
      dispatchId,
    }));
    lastPayload = result.payload;
    if (lastPayload.callbackStatus === "delivered") {
      return lastPayload;
    }

    await sleep(2_000);
  }

  throw new Error(
    `Dispatch ${dispatchId} callback stayed ${lastPayload?.callbackStatus ?? "unknown"} after ${maxAttempts} retries.`,
  );
}

async function main() {
  const cwdProjectId = process.env.THREAD_RELAY_SMOKE_PROJECT_ID || path.resolve(process.cwd());
  const projectKey = normalizeWindowsPathKey(cwdProjectId);
  const targetProject = await withSession(async (session) => {
    const listedProjects = await listProjectsAction(session);
    const project = listedProjects.payload.projects.find(
      (project) => project.pathKey === projectKey,
    );
    assert.ok(project, `Trusted project not found for smoke target: ${cwdProjectId}`);
    return project;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mainThread = await withSession((session) => createThreadAction(session, {
    projectId: targetProject.projectId,
    name: `relay async main ${stamp}`,
  }));
  const targetThread = await withSession((session) => createThreadAction(session, {
    projectId: targetProject.projectId,
    name: `relay async target ${stamp}`,
  }));

  const firstSend = await withSession((session) => sendWaitAction(session, {
    threadId: targetThread.payload.threadId,
    message: makeReplyMessage("relay smoke ok 1"),
    timeoutSec: 120,
  }));
  assert.match(firstSend.payload.replyText, /relay smoke ok 1/i);

  const byThreadId = await withSession((session) => dispatchAction(session, {
    projectId: targetProject.projectId,
    threadId: targetThread.payload.threadId,
    message: makeReplyMessage("relay smoke ok 2"),
    timeoutSec: 120,
  }));
  assert.equal(byThreadId.payload.resolution, "by_thread_id");
  assert.match(byThreadId.payload.replyText, /relay smoke ok 2/i);

  const asyncCreated = await withSession((session) => dispatchAsyncAction(session, {
    projectId: targetProject.projectId,
    threadName: `relay async created ${stamp}`,
    createIfMissing: true,
    message: makeReplyMessage("relay async ok 3"),
    callbackThreadId: mainThread.payload.threadId,
    timeoutSec: 120,
  }));
  assert.equal(asyncCreated.payload.resolution, "created_new");
  assert.equal(asyncCreated.payload.created, true);

  const createdStatus = await waitForDispatchCompletion(
    asyncCreated.payload.dispatchId,
    (status) => status.dispatchStatus === "succeeded" && status.callbackStatus === "delivered",
  );
  assert.match(createdStatus.replyText, /relay async ok 3/i);

  const asyncReused = await withSession((session) => dispatchAsyncAction(session, {
    projectId: targetProject.projectId,
    threadId: targetThread.payload.threadId,
    message: makeReplyMessage("relay async ok 4"),
    callbackThreadId: mainThread.payload.threadId,
    timeoutSec: 120,
  }));
  assert.equal(asyncReused.payload.resolution, "by_thread_id");

  const reusedStatus = await waitForDispatchCompletion(
    asyncReused.payload.dispatchId,
    (status) => status.dispatchStatus === "succeeded" && status.callbackStatus === "delivered",
  );
  assert.match(reusedStatus.replyText, /relay async ok 4/i);

  const busyCallbackLease = await acquireThreadLease({
    threadId: mainThread.payload.threadId,
    projectId: targetProject.projectId,
    ttlMs: 60_000,
  });
  const pendingDispatch = await withSession((session) => dispatchAsyncAction(session, {
    projectId: targetProject.projectId,
    threadId: targetThread.payload.threadId,
    message: makeReplyMessage("relay async ok 5"),
    callbackThreadId: mainThread.payload.threadId,
    timeoutSec: 120,
  }));

  const pendingStatus = await waitForDispatchCompletion(
    pendingDispatch.payload.dispatchId,
    (status) => status.dispatchStatus === "succeeded" && status.callbackStatus === "pending",
  );
  assert.match(pendingStatus.replyText, /relay async ok 5/i);

  await releaseThreadLease({
    threadId: mainThread.payload.threadId,
    leaseId: busyCallbackLease.leaseId,
  });
  const deliveredAfterRetry = await recoverDispatchDelivery(pendingDispatch.payload.dispatchId);
  assert.equal(deliveredAfterRetry.callbackStatus, "delivered");

  const fakeTimeoutSession = {
    turnTimeoutMs: 1_000,
    async request(method) {
      if (method === "thread/resume") {
        return { ok: true };
      }
      if (method === "turn/start") {
        return {
          result: {
            turn: {
              id: "turn-timeout-smoke",
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async waitForTurn() {
      const error = new Error("Timed out while waiting for thread smoke-timeout turn turn-timeout-smoke");
      error.code = "timeout";
      throw error;
    },
  };

  try {
    await assert.rejects(
      () => deliverMessageToThread(fakeTimeoutSession, {
        project: targetProject,
        thread: {
          threadId: "smoke-timeout",
          name: "smoke timeout",
          status: "idle",
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        },
        message: makeReplyMessage("relay smoke timeout"),
        timeoutSec: 1,
        resolution: "by_thread_id",
        created: false,
      }),
      (error) => error instanceof RelayError && error.relayCode === "turn_timeout",
    );
  } finally {
    await releaseThreadLease({ threadId: "smoke-timeout" });
  }

  console.log("relay smoke passed");
}

await main();
