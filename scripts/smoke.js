import assert from "node:assert/strict";
import path from "node:path";

import { CodexAppServerSession } from "../src/app-server-client.js";
import { RelayError } from "../src/errors.js";
import {
  createThreadAction,
  deliverMessageToThread,
  dispatchAction,
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
  const initialThreadName = `relay smoke ${stamp}`;
  const created = await withSession((session) => createThreadAction(session, {
    projectId: targetProject.projectId,
    name: initialThreadName,
  }));
  assert.ok(created.payload.threadId, "relay_create_thread should return a thread id");

  const firstSend = await withSession((session) => sendWaitAction(session, {
    threadId: created.payload.threadId,
    message: makeReplyMessage("relay smoke ok 1"),
    timeoutSec: 120,
  }));
  assert.match(firstSend.payload.replyText, /relay smoke ok 1/i);

  const byThreadId = await withSession((session) => dispatchAction(session, {
    projectId: targetProject.projectId,
    threadId: created.payload.threadId,
    message: makeReplyMessage("relay smoke ok 2"),
    timeoutSec: 120,
  }));
  assert.equal(byThreadId.payload.resolution, "by_thread_id");
  assert.match(byThreadId.payload.replyText, /relay smoke ok 2/i);

  const byExactName = await withSession((session) => dispatchAction(session, {
    projectId: targetProject.projectId,
    threadName: created.payload.threadName,
    message: makeReplyMessage("relay smoke ok 3"),
    timeoutSec: 120,
  }));
  assert.equal(byExactName.payload.resolution, "by_exact_name");
  assert.match(byExactName.payload.replyText, /relay smoke ok 3/i);

  const createdByDispatch = await withSession((session) => dispatchAction(session, {
    projectId: targetProject.projectId,
    threadName: `relay dispatch smoke ${stamp}`,
    createIfMissing: true,
    message: makeReplyMessage("relay smoke ok 4"),
    timeoutSec: 120,
  }));
  assert.equal(createdByDispatch.payload.resolution, "created_new");
  assert.equal(createdByDispatch.payload.created, true);
  assert.match(createdByDispatch.payload.replyText, /relay smoke ok 4/i);

  const busyLease = await acquireThreadLease({
    threadId: created.payload.threadId,
    projectId: targetProject.projectId,
    ttlMs: 60_000,
  });
  try {
    await assert.rejects(
      () => withSession((session) => dispatchAction(session, {
        projectId: targetProject.projectId,
        threadId: created.payload.threadId,
        message: makeReplyMessage("relay smoke should not run"),
        timeoutSec: 30,
      })),
      (error) => error instanceof RelayError && error.relayCode === "target_busy",
    );
  } finally {
    await releaseThreadLease({
      threadId: created.payload.threadId,
      leaseId: busyLease.leaseId,
    });
  }

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

  console.log("relay smoke passed");
}

await main();
