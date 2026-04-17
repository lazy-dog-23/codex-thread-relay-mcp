import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RelayError } from "../src/errors.js";
import {
  deliverMessageToThread,
  dispatchDeliverAction,
  dispatchRecoverAction,
  dispatchStatusAction,
  processAsyncDispatchWithSession,
  resolveDispatchThread,
  sendWaitAction,
} from "../src/relay-service.js";
import {
  acquireDispatchLease,
  acquireThreadLease,
  createDispatchRecord,
  getActiveThreadLease,
  getDispatchRecord,
  listActiveDispatches,
  rememberCreatedThread,
  relayStatePath,
  updateThreadLease,
} from "../src/state-store.js";

async function withRelayHome(t) {
  const previous = process.env.THREAD_RELAY_HOME;
  const relayHome = await fs.mkdtemp(path.join(os.tmpdir(), "thread-relay-service-"));
  process.env.THREAD_RELAY_HOME = relayHome;
  t.after(async () => {
    if (previous == null) {
      delete process.env.THREAD_RELAY_HOME;
    } else {
      process.env.THREAD_RELAY_HOME = previous;
    }
    await fs.rm(relayHome, { recursive: true, force: true });
  });
  return relayHome;
}

function makeAsyncSession({
  sourceStatus = "idle",
  sourceStatusSequence = null,
  targetTurnId = "turn-target-1",
  targetReplyText = "relay async ok",
  allowTargetTurnStart = true,
  hideTargetFromList = false,
  targetReadMissingCount = 0,
  turnTimeoutMs = 1_000,
  waitForTurnSpy = null,
} = {}) {
  let callbackEnvelope = null;
  let sourceStatusIndex = 0;
  let remainingTargetReadMisses = Math.max(0, targetReadMissingCount);
  const getSourceStatus = () => {
    if (!Array.isArray(sourceStatusSequence) || sourceStatusSequence.length === 0) {
      return sourceStatus;
    }
    const index = Math.min(sourceStatusIndex, sourceStatusSequence.length - 1);
    sourceStatusIndex += 1;
    return sourceStatusSequence[index];
  };
  return {
    turnTimeoutMs,
    async request(method, params) {
      if (method === "config/read") {
        return {
          result: {
            config: {
              projects: {
                "C:\\Trusted\\Relay": {
                  trust_level: "trusted",
                },
              },
            },
          },
        };
      }
      if (method === "thread/read") {
        if (params.threadId === "target-thread") {
          if (remainingTargetReadMisses > 0) {
            remainingTargetReadMisses -= 1;
            return {
              result: {
                thread: null,
              },
            };
          }
          return {
            result: {
              thread: {
                id: "target-thread",
                name: "relay target",
                status: { type: "idle" },
              },
            },
          };
        }
        if (params.threadId === "source-thread") {
          const currentSourceStatus = getSourceStatus();
          return {
            result: {
              thread: {
                id: "source-thread",
                name: "relay source",
                status: { type: currentSourceStatus },
              },
            },
          };
        }
      }
      if (method === "thread/resume") {
        return { ok: true };
      }
      if (method === "turn/start") {
        const threadId = params.threadId;
        if (threadId === "target-thread") {
          if (!allowTargetTurnStart) {
            throw new Error("turn/start should not be called for the target thread");
          }
          return {
            result: {
              turn: {
                id: targetTurnId,
              },
            },
          };
        }
        if (threadId === "source-thread") {
          callbackEnvelope = params.input?.[0]?.text ?? null;
          return {
            result: {
              turn: {
                id: "turn-callback-1",
              },
            },
          };
        }
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async listAllThreads() {
      return [
        ...(hideTargetFromList ? [] : [{
          id: "target-thread",
          name: "relay target",
          cwd: "C:\\Trusted\\Relay",
          status: { type: "idle" },
          updatedAt: 1_712_966_400,
        }]),
        {
          id: "source-thread",
          name: "relay source",
          cwd: "C:\\Trusted\\Relay",
          status: { type: getSourceStatus() },
          updatedAt: 1_712_966_401,
        },
      ];
    },
    async waitForTurn(threadId, turnId, timeoutMs) {
      if (typeof waitForTurnSpy === "function") {
        waitForTurnSpy({ threadId, turnId, timeoutMs });
      }
      if (threadId === "target-thread" && turnId === targetTurnId) {
        return {
          status: "completed",
          completedAt: "2026-04-13T00:10:00.000Z",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: targetReplyText,
            },
          ],
        };
      }
      if (threadId === "source-thread" && turnId === "turn-callback-1") {
        return {
          status: "completed",
          completedAt: "2026-04-13T00:11:00.000Z",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: "callback delivered",
            },
          ],
        };
      }
      throw new Error(`Unexpected waitForTurn: ${threadId} ${turnId}`);
    },
    get callbackEnvelope() {
      return callbackEnvelope;
    },
  };
}

test("resolveDispatchThread respects threadId, exact name, query, then createIfMissing", () => {
  const threads = [
    { threadId: "thread-1", name: "Alpha", status: "idle" },
    { threadId: "thread-2", name: "Bravo", status: "idle" },
  ];

  assert.equal(
    resolveDispatchThread(threads, { threadId: "thread-2" }).resolution,
    "by_thread_id",
  );
  assert.equal(
    resolveDispatchThread(threads, { threadName: "Alpha" }).resolution,
    "by_exact_name",
  );
  assert.equal(
    resolveDispatchThread(threads, { query: "brav" }).resolution,
    "by_query_match",
  );
  assert.equal(
    resolveDispatchThread(threads, { createIfMissing: true }).resolution,
    "created_new",
  );
});

test("resolveDispatchThread throws a structured ambiguity error for non-unique query matches", () => {
  const threads = [
    { threadId: "thread-1", name: "relay smoke alpha", status: "idle" },
    { threadId: "thread-2", name: "relay smoke beta", status: "idle" },
  ];

  assert.throws(
    () => resolveDispatchThread(threads, { query: "relay smoke" }),
    (error) => error instanceof RelayError && error.relayCode === "target_ambiguous",
  );
});

test("deliverMessageToThread surfaces timeout failures as turn_timeout", async (t) => {
  await withRelayHome(t);

  const fakeSession = {
    turnTimeoutMs: 1_000,
    async request(method) {
      if (method === "thread/resume") {
        return { ok: true };
      }
      if (method === "turn/start") {
        return {
          result: {
            turn: {
              id: "turn-timeout",
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async waitForTurn() {
      const error = new Error("Timed out while waiting for thread thread-1 turn turn-timeout");
      error.code = "timeout";
      throw error;
    },
  };

  await assert.rejects(
    () => deliverMessageToThread(fakeSession, {
      project: {
        projectId: "C:\\Trusted\\Relay",
        name: "Relay",
        path: "C:\\Trusted\\Relay",
      },
      thread: {
        threadId: "thread-1",
        name: "relay smoke",
        status: "idle",
        createdAt: "2026-04-13T00:00:00.000Z",
        lastUsedAt: "2026-04-13T00:00:00.000Z",
      },
      message: "Reply exactly relay smoke timeout",
      timeoutSec: 1,
      resolution: "by_thread_id",
      created: false,
    }),
    (error) => error instanceof RelayError && error.relayCode === "turn_timeout",
  );

  const activeDispatches = await listActiveDispatches("C:\\Trusted\\Relay");
  assert.equal(activeDispatches.length, 1);
  assert.equal(activeDispatches[0].threadId, "thread-1");
});

test("deliverMessageToThread records a recoverable dispatch for sync timeout when requested", async (t) => {
  await withRelayHome(t);

  const scheduledDispatches = [];
  const fakeSession = {
    turnTimeoutMs: 1_000,
    async request(method) {
      if (method === "thread/resume") {
        return { ok: true };
      }
      if (method === "turn/start") {
        return {
          result: {
            turn: {
              id: "turn-timeout-recovery",
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async waitForTurn() {
      const error = new Error("Timed out while waiting for thread thread-2 turn turn-timeout-recovery");
      error.code = "timeout";
      throw error;
    },
  };

  let thrown = null;
  try {
    await deliverMessageToThread(fakeSession, {
      project: {
        projectId: "C:\\Trusted\\Relay",
        name: "Relay",
        path: "C:\\Trusted\\Relay",
      },
      thread: {
        threadId: "thread-2",
        name: "relay timeout recovery",
        status: "idle",
        createdAt: "2026-04-13T00:00:00.000Z",
        lastUsedAt: "2026-04-13T00:00:00.000Z",
      },
      message: "Reply exactly relay timeout recovery",
      timeoutSec: 1,
      resolution: "by_thread_id",
      created: false,
      createRecoveryDispatchOnTimeout: true,
      scheduleRecoveryWorker: (dispatchId) => {
        scheduledDispatches.push(dispatchId);
      },
    });
    assert.fail("Expected turn_timeout");
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof RelayError);
  assert.equal(thrown.relayCode, "turn_timeout");
  assert.match(thrown.message, /Recovery dispatch/);
  assert.match(thrown.message, /official Codex thread automations/i);
  assert.equal(typeof thrown.details.recoveryDispatchId, "string");
  assert.equal(thrown.details.usageRole, "bridge");
  assert.equal(thrown.details.recommendedSurface, "thread_automation");
  assert.equal(thrown.details.recommendedPattern, "status_then_recover");
  assert.match(thrown.details.whenToUse, /official thread automation/i);
  assert.match(thrown.details.whenNotToUse, /same-thread work through relay/i);
  assert.match(thrown.details.selectionRule, /dispatch already exists/i);
  assert.match(thrown.details.nextActionSummary, /Check relay_dispatch_status first/i);
  assert.deepEqual(scheduledDispatches, [thrown.details.recoveryDispatchId]);

  const recoveryRecord = await getDispatchRecord(thrown.details.recoveryDispatchId);
  assert.ok(recoveryRecord);
  assert.equal(recoveryRecord.dispatchStatus, "running");
  assert.equal(recoveryRecord.errorCode, "turn_timeout");
  assert.equal(recoveryRecord.turnId, "turn-timeout-recovery");
  assert.equal(recoveryRecord.threadId, "thread-2");
  assert.match(recoveryRecord.warning ?? "", /sync relay timeout/i);
  const activeLease = await getActiveThreadLease("thread-2");
  assert.equal(activeLease?.turnId, "turn-timeout-recovery");
  assert.equal(activeLease?.dispatchId, thrown.details.recoveryDispatchId);
});

test("deliverMessageToThread surfaces the active recovery dispatch id when the thread lease is still busy", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-active-recovery",
    projectId: "C:\\Trusted\\Relay",
    threadId: "thread-busy",
    threadName: "relay busy",
    message: "Reply exactly relay busy",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-busy-1",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });
  const lease = await acquireThreadLease({
    threadId: "thread-busy",
    projectId: "C:\\Trusted\\Relay",
    ttlMs: 60_000,
  });
  await updateThreadLease({
    threadId: "thread-busy",
    leaseId: lease.leaseId,
    dispatchId: "dispatch-active-recovery",
    turnId: "turn-busy-1",
  });

  const fakeSession = {
    turnTimeoutMs: 1_000,
    async request() {
      throw new Error("Unexpected request");
    },
  };

  await assert.rejects(
    () => deliverMessageToThread(fakeSession, {
      project: {
        projectId: "C:\\Trusted\\Relay",
        name: "Relay",
        path: "C:\\Trusted\\Relay",
      },
      thread: {
        threadId: "thread-busy",
        name: "relay busy",
        status: "idle",
      },
      message: "Reply exactly relay busy probe",
      timeoutSec: 1,
      resolution: "by_thread_id",
      created: false,
    }),
    (error) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.relayCode, "target_busy");
      assert.equal(error.details.activeDispatchId, "dispatch-active-recovery");
      assert.equal(error.details.activeDispatchStatus, "running");
      assert.equal(error.details.usageRole, "bridge");
      assert.equal(error.details.recommendedSurface, "thread_automation");
      assert.equal(error.details.recommendedPattern, "move_to_bound_thread");
      assert.match(error.details.whenToUse, /official thread automation/i);
      assert.match(error.details.nextActionSummary, /Move the recurring work to the bound thread/i);
      assert.match(error.message, /dispatch-active-recovery/);
      assert.match(error.message, /relay_dispatch_status/);
      assert.match(error.message, /official Codex thread automations/i);
      return true;
    },
  );
});

test("sendWaitAction returns active dispatch status instead of target_busy when the thread is busy with a known dispatch", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-sendwait-busy",
    projectId: "C:\\Trusted\\Relay",
    threadId: "thread-sendwait-busy",
    threadName: "relay sendwait busy",
    message: "Reply exactly relay busy",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-sendwait-busy",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });
  const lease = await acquireThreadLease({
    threadId: "thread-sendwait-busy",
    projectId: "C:\\Trusted\\Relay",
    ttlMs: 60_000,
  });
  await updateThreadLease({
    threadId: "thread-sendwait-busy",
    leaseId: lease.leaseId,
    dispatchId: "dispatch-sendwait-busy",
    turnId: "turn-sendwait-busy",
  });

  const fakeSession = {
    turnTimeoutMs: 1_000,
    async request(method, params) {
      if (method === "config/read") {
        return {
          result: {
            config: {
              projects: {
                "C:\\Trusted\\Relay": {
                  trust_level: "trusted",
                },
              },
            },
          },
        };
      }
      if (method === "thread/read") {
        return {
          result: {
            thread: {
              id: params.threadId,
              name: "relay sendwait busy",
              status: { type: "running" },
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async listAllThreads() {
      return [
        {
          id: "thread-sendwait-busy",
          name: "relay sendwait busy",
          cwd: "C:\\Trusted\\Relay",
          status: { type: "running" },
          updatedAt: 1_712_966_400,
        },
      ];
    },
  };

  const result = await sendWaitAction(fakeSession, {
    threadId: "thread-sendwait-busy",
    message: "Status probe",
    timeoutSec: 1,
  });

  assert.equal(result.payload.busy, true);
  assert.equal(result.payload.newMessageDelivered, false);
  assert.equal(result.payload.dispatchId, "dispatch-sendwait-busy");
  assert.equal(result.payload.dispatchStatus, "running");
  assert.equal(result.payload.usageRole, "bridge");
  assert.equal(result.payload.recommendedSurface, "thread_automation");
  assert.equal(result.payload.recommendedPattern, "move_to_bound_thread");
  assert.match(result.payload.whenToUse, /official thread automation/i);
  assert.match(result.payload.nextActionSummary, /Move the recurring work to the bound thread/i);
  assert.match(result.text, /new message was not delivered/i);
  assert.match(result.text, /dispatch-sendwait-busy/);
  assert.match(result.text, /Recommended surface: thread_automation/);
});

test("processAsyncDispatchWithSession completes async dispatches and auto-delivers callbacks", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-success",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "pending",
    dispatchStatus: "queued",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  });

  const session = makeAsyncSession();
  const result = await processAsyncDispatchWithSession(session, "dispatch-success");

  assert.equal(result.dispatchStatus, "succeeded");
  assert.equal(result.callbackStatus, "delivered");
  assert.equal(result.replyText, "relay async ok");
  assert.equal(result.turnId, "turn-target-1");
  assert.equal(result.callbackTurnId, "turn-callback-1");
  assert.match(session.callbackEnvelope ?? "", /\[Codex Relay Callback\]/);
  assert.match(session.callbackEnvelope ?? "", /BEGIN_CODEX_RELAY_CALLBACK_JSON/);
  assert.match(session.callbackEnvelope ?? "", /END_CODEX_RELAY_CALLBACK_JSON/);
  const payloadMatch = session.callbackEnvelope?.match(/BEGIN_CODEX_RELAY_CALLBACK_JSON\s*([\s\S]*?)\s*END_CODEX_RELAY_CALLBACK_JSON/);
  assert.ok(payloadMatch);
  const callbackPayload = JSON.parse(payloadMatch[1]);
  assert.equal(callbackPayload.eventType, "codex.relay.dispatch.completed.v1");
  assert.equal(callbackPayload.dispatchId, "dispatch-success");
  assert.equal(callbackPayload.status, "succeeded");

  const status = await dispatchStatusAction({ dispatchId: "dispatch-success" });
  assert.equal(status.payload.dispatchStatus, "succeeded");
  assert.equal(status.payload.callbackStatus, "delivered");
  assert.equal(status.payload.replyText, "relay async ok");
  assert.equal(status.payload.usageRole, "bridge");
  assert.equal(status.payload.recommendedSurface, "async_relay");
  assert.equal(status.payload.recommendedPattern, "status_then_recover");
  assert.match(status.payload.whenToUse, /cross threads or projects/i);
  assert.match(status.payload.nextActionSummary, /Check relay_dispatch_status first/i);
});

test("dispatchStatusAction live-refreshes a running dispatch to succeeded when the recorded turn already completed", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-status-live-success",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-status-success-1",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  const status = await dispatchStatusAction({
    request: async (method, params) => {
      assert.equal(method, "thread/read");
      assert.equal(params.threadId, "target-thread");
      return {
        result: {
          thread: {
            turns: [
              {
                id: "turn-status-success-1",
                status: "completed",
                completedAt: "2026-04-13T00:00:09.000Z",
                items: [
                  {
                    id: "item-status-success-1",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "relay status refreshed",
                  },
                ],
              },
            ],
          },
        },
      };
    },
    requestTimeoutMs: 1_000,
  }, {
    dispatchId: "dispatch-status-live-success",
  });

  assert.equal(status.payload.dispatchStatus, "succeeded");
  assert.equal(status.payload.replyText, "relay status refreshed");

  const stored = await getDispatchRecord("dispatch-status-live-success");
  assert.equal(stored?.dispatchStatus, "succeeded");
  assert.equal(stored?.replyText, "relay status refreshed");
});

test("dispatchStatusAction live-refreshes a running dispatch to failed when the recorded turn was interrupted", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-status-live-failed",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-status-failed-1",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  const status = await dispatchStatusAction({
    request: async (method, params) => {
      assert.equal(method, "thread/read");
      assert.equal(params.threadId, "target-thread");
      return {
        result: {
          thread: {
            turns: [
              {
                id: "turn-status-failed-1",
                status: "interrupted",
                completedAt: "2026-04-13T00:00:09.000Z",
                error: {
                  message: "Interrupted by operator",
                },
                items: [],
              },
            ],
          },
        },
      };
    },
    requestTimeoutMs: 1_000,
  }, {
    dispatchId: "dispatch-status-live-failed",
  });

  assert.equal(status.payload.dispatchStatus, "failed");
  assert.equal(status.payload.errorCode, "target_turn_failed");
  assert.match(status.payload.errorMessage ?? "", /Interrupted by operator/);

  const stored = await getDispatchRecord("dispatch-status-live-failed");
  assert.equal(stored?.dispatchStatus, "failed");
  assert.equal(stored?.errorCode, "target_turn_failed");
});

test("dispatchStatusAction drops a stale dead-worker lease and exposes the dispatch as resumable", async (t) => {
  const relayHome = await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-status-stale-worker",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-status-stale-worker-1",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  await acquireDispatchLease({
    dispatchId: "dispatch-status-stale-worker",
    ttlMs: 60_000,
  });

  const impossiblePid = 999_999_999;
  const statePath = relayStatePath();
  const lockPath = path.join(
    relayHome,
    "locks",
    `dispatch-${Buffer.from("dispatch-status-stale-worker").toString("base64url")}.lease.json`,
  );
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.dispatchLeases = state.dispatchLeases.map((entry) =>
    entry.dispatchId === "dispatch-status-stale-worker"
      ? { ...entry, ownerPid: impossiblePid }
      : entry);
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const fileLease = JSON.parse(await fs.readFile(lockPath, "utf8"));
  fileLease.ownerPid = impossiblePid;
  await fs.writeFile(lockPath, JSON.stringify(fileLease, null, 2), "utf8");

  const status = await dispatchStatusAction({
    dispatchId: "dispatch-status-stale-worker",
  });

  assert.equal(status.payload.dispatchLeaseActive, false);
  assert.equal(status.payload.recoverySuggested, "resume_turn_wait");
  assert.match(status.payload.warning ?? "", /can be resumed/i);
});

test("processAsyncDispatchWithSession resumes a running recovery dispatch for a previously timed out sync turn", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-sync-timeout-running",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async recovered",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    errorCode: "turn_timeout",
    errorMessage: "Timed out while waiting for thread target-thread turn turn-target-2",
    turnId: "turn-target-2",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:10.000Z",
  });
  await acquireThreadLease({
    threadId: "target-thread",
    projectId: "C:\\Trusted\\Relay",
    ttlMs: 60_000,
    turnId: "turn-target-2",
  });

  const result = await processAsyncDispatchWithSession(makeAsyncSession({
    allowTargetTurnStart: false,
    targetTurnId: "turn-target-2",
    targetReplyText: "relay async recovered",
  }), "dispatch-sync-timeout-running");

  assert.equal(result.dispatchStatus, "succeeded");
  assert.equal(result.replyText, "relay async recovered");
  assert.equal(result.errorCode, null);
  assert.equal(await getActiveThreadLease("target-thread"), null);
});

test("processAsyncDispatchWithSession leaves callback delivery pending when the source thread is busy", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-pending",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "pending",
    dispatchStatus: "queued",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  });

  await processAsyncDispatchWithSession(makeAsyncSession({ sourceStatus: "running" }), "dispatch-pending");

  const stored = await getDispatchRecord("dispatch-pending");
  assert.ok(stored);
  assert.equal(stored.dispatchStatus, "succeeded");
  assert.equal(stored.callbackStatus, "pending");
  assert.equal(stored.callbackErrorCode, "target_busy");

  const retry = await dispatchDeliverAction(makeAsyncSession({ sourceStatus: "idle" }), {
    dispatchId: "dispatch-pending",
  });
  assert.equal(retry.payload.callbackStatus, "delivered");
});

test("processAsyncDispatchWithSession auto-retries a busy callback and eventually delivers it", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-auto-retry-callback",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "pending",
    dispatchStatus: "queued",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  });

  const result = await processAsyncDispatchWithSession(makeAsyncSession({
    sourceStatusSequence: ["idle", "running", "idle"],
  }), "dispatch-auto-retry-callback", {
    callbackRetryDelaysMs: [0],
  });

  assert.equal(result.dispatchStatus, "succeeded");
  assert.equal(result.callbackStatus, "delivered");
});

test("processAsyncDispatchWithSession waits for a newly created target thread to become visible in a fresh worker session", async (t) => {
  await withRelayHome(t);

  await rememberCreatedThread({
    threadId: "target-thread",
    projectId: "C:\\Trusted\\Relay",
    name: "relay target",
    createdAt: "2026-04-13T00:00:00.000Z",
    lastUsedAt: "2026-04-13T00:00:00.000Z",
    lastTurnId: null,
  });
  await createDispatchRecord({
    dispatchId: "dispatch-created-visible-late",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: true,
    resolution: "created_new",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "queued",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  });

  const result = await processAsyncDispatchWithSession(makeAsyncSession({
    hideTargetFromList: true,
    targetReadMissingCount: 2,
  }), "dispatch-created-visible-late");

  assert.equal(result.dispatchStatus, "succeeded");
  assert.equal(result.replyText, "relay async ok");
});

test("processAsyncDispatchWithSession resumes a recorded target turn without replaying the message", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-resume",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async resume",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-existing-1",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  const result = await processAsyncDispatchWithSession(makeAsyncSession({
    allowTargetTurnStart: false,
    targetTurnId: "turn-existing-1",
    targetReplyText: "relay async resumed",
  }), "dispatch-resume");

  assert.equal(result.dispatchStatus, "succeeded");
  assert.equal(result.turnId, "turn-existing-1");
  assert.equal(result.replyText, "relay async resumed");
});

test("processAsyncDispatchWithSession marks a recorded interrupted turn as failed and clears the stale lease", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-resume-interrupted",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async resume",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-interrupted-1",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  await acquireThreadLease({
    threadId: "target-thread",
    projectId: "C:\\Trusted\\Relay",
    ttlMs: 60_000,
    turnId: "turn-interrupted-1",
  });

  const session = {
    turnTimeoutMs: 90_000,
    async request(method, params) {
      if (method === "config/read") {
        return {
          result: {
            config: {
              projects: {
                "C:\\Trusted\\Relay": {
                  trust_level: "trusted",
                },
              },
            },
          },
        };
      }
      if (method === "thread/read") {
        return {
          result: {
            thread: {
              id: params.threadId,
              name: "relay target",
              status: { type: "idle" },
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async listAllThreads() {
      return [
        {
          id: "target-thread",
          name: "relay target",
          cwd: "C:\\Trusted\\Relay",
          status: { type: "idle" },
          updatedAt: 1_712_966_400,
        },
      ];
    },
    async waitForTurn(threadId, turnId) {
      assert.equal(threadId, "target-thread");
      assert.equal(turnId, "turn-interrupted-1");
      return {
        id: turnId,
        status: "interrupted",
        completedAt: "2026-04-13T00:00:10.000Z",
        error: {
          message: "Interrupted by operator",
        },
        items: [],
      };
    },
  };

  const result = await processAsyncDispatchWithSession(session, "dispatch-resume-interrupted");
  assert.equal(result.dispatchStatus, "failed");
  assert.equal(result.errorCode, "target_turn_failed");
  assert.match(result.errorMessage ?? "", /Interrupted by operator/);
  assert.equal(await getActiveThreadLease("target-thread"), null);
});

test("processAsyncDispatchWithSession waits for a recorded target turn using the session turn timeout floor", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-resume-timeout-floor",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async resume",
    timeoutSec: 5,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    turnId: "turn-existing-timeout-floor",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  let observedTimeoutMs = null;
  await processAsyncDispatchWithSession(makeAsyncSession({
    allowTargetTurnStart: false,
    targetTurnId: "turn-existing-timeout-floor",
    targetReplyText: "relay async timeout floor",
    turnTimeoutMs: 90_000,
    waitForTurnSpy: ({ threadId, turnId, timeoutMs }) => {
      if (threadId === "target-thread" && turnId === "turn-existing-timeout-floor") {
        observedTimeoutMs = timeoutMs;
      }
    },
  }), "dispatch-resume-timeout-floor");

  assert.equal(observedTimeoutMs, 90_000);
});

test("processAsyncDispatchWithSession recovers a turn id from the active thread lease and clears the stale lease on success", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-turn-from-lease",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async resume",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "running",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:05.000Z",
  });

  const lease = await acquireThreadLease({
    threadId: "target-thread",
    projectId: "C:\\Trusted\\Relay",
    ttlMs: 60_000,
  });
  await updateThreadLease({
    threadId: "target-thread",
    leaseId: lease.leaseId,
    turnId: "turn-from-lease-1",
  });

  const result = await processAsyncDispatchWithSession(makeAsyncSession({
    allowTargetTurnStart: false,
    targetTurnId: "turn-from-lease-1",
    targetReplyText: "relay async from lease",
  }), "dispatch-turn-from-lease");

  assert.equal(result.dispatchStatus, "succeeded");
  assert.equal(result.turnId, "turn-from-lease-1");
  assert.equal(result.replyText, "relay async from lease");
  assert.equal(await getActiveThreadLease("target-thread"), null);
});

test("dispatchRecoverAction retries a failed callback delivery explicitly", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-recover-callback",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "failed",
    callbackErrorCode: "app_server_unavailable",
    callbackErrorMessage: "source thread callback failed previously",
    dispatchStatus: "succeeded",
    turnId: "turn-target-1",
    replyText: "relay async ok",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:10.000Z",
  });

  const recovered = await dispatchRecoverAction(makeAsyncSession(), {
    dispatchId: "dispatch-recover-callback",
  });

  assert.equal(recovered.payload.recoveryAction, "retry_callback");
  assert.equal(recovered.payload.callbackStatus, "delivered");
  assert.equal(recovered.payload.usageRole, "bridge");
  assert.equal(recovered.payload.recommendedSurface, "async_relay");
  assert.equal(recovered.payload.recommendedPattern, "status_then_recover");
  assert.match(recovered.payload.whenToUse, /cross threads or projects/i);
  assert.match(recovered.payload.nextActionSummary, /Check relay_dispatch_status first/i);
});

test("dispatchRecoverAction resumes a timed out target turn when the turn id is known", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-recover-timeout",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "pending",
    dispatchStatus: "timed_out",
    errorCode: "turn_timeout",
    errorMessage: "Timed out while waiting for thread target-thread turn turn-target-2",
    turnId: "turn-target-2",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:10.000Z",
  });

  const recovered = await dispatchRecoverAction(makeAsyncSession({
    allowTargetTurnStart: false,
    targetTurnId: "turn-target-2",
    targetReplyText: "relay async recovered",
  }), {
    dispatchId: "dispatch-recover-timeout",
  });

  assert.equal(recovered.payload.recoveryAction, "resume_timed_out_turn");
  assert.equal(recovered.payload.dispatchStatus, "succeeded");
  assert.equal(recovered.payload.callbackStatus, "delivered");
  assert.equal(recovered.payload.replyText, "relay async recovered");
  assert.equal(recovered.payload.usageRole, "bridge");
  assert.equal(recovered.payload.recommendedSurface, "async_relay");
  assert.equal(recovered.payload.recommendedPattern, "status_then_recover");
  assert.match(recovered.payload.whenToUse, /cross threads or projects/i);
  assert.match(recovered.payload.nextActionSummary, /Check relay_dispatch_status first/i);
});

test("dispatchRecoverAction batch-recovers actionable dispatches", async (t) => {
  await withRelayHome(t);

  await createDispatchRecord({
    dispatchId: "dispatch-batch-pending",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "pending",
    dispatchStatus: "succeeded",
    turnId: "turn-target-1",
    replyText: "relay async ok",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:10.000Z",
  });
  await createDispatchRecord({
    dispatchId: "dispatch-batch-timeout",
    projectId: "C:\\Trusted\\Relay",
    threadId: "target-thread",
    threadName: "relay target",
    message: "Reply exactly relay async ok",
    timeoutSec: 30,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: null,
    callbackStatus: "not_requested",
    dispatchStatus: "timed_out",
    turnId: "turn-target-2",
    errorCode: "turn_timeout",
    errorMessage: "Timed out while waiting for thread target-thread turn turn-target-2",
    createdAt: "2026-04-13T00:00:00.000Z",
    acceptedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:11.000Z",
  });

  const recovered = await dispatchRecoverAction(makeAsyncSession({
    allowTargetTurnStart: false,
    targetTurnId: "turn-target-2",
    targetReplyText: "relay async recovered",
  }), {
    projectId: "C:\\Trusted\\Relay",
    limit: 10,
  });

  assert.equal(recovered.payload.recoveredCount, 2);
  assert.equal(recovered.payload.recovered.length, 2);
  assert.equal(recovered.payload.usageRole, "bridge");
  assert.equal(recovered.payload.recommendedSurface, "async_relay");
  assert.equal(recovered.payload.recommendedPattern, "status_then_recover");
  assert.match(recovered.payload.whenToUse, /cross threads or projects/i);
  assert.match(recovered.payload.nextActionSummary, /Check relay_dispatch_status first/i);
  assert.ok(recovered.payload.recovered.some((item) => item.dispatchId === "dispatch-batch-pending" && item.callbackStatus === "delivered"));
  assert.ok(recovered.payload.recovered.some((item) => item.dispatchId === "dispatch-batch-timeout" && item.dispatchStatus === "succeeded"));
});
