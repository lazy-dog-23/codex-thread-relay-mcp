import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RelayError } from "../src/errors.js";
import { deliverMessageToThread, resolveDispatchThread } from "../src/relay-service.js";
import { listActiveDispatches } from "../src/state-store.js";

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

test("deliverMessageToThread retries one transient empty-rollout failure", async (t) => {
  await withRelayHome(t);

  let waitAttempts = 0;
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
              id: "turn-retry",
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async waitForTurn() {
      waitAttempts += 1;
      if (waitAttempts === 1) {
        throw new Error("failed to load rollout `foo` for thread thread-1: rollout at foo is empty");
      }
      return {
        status: "completed",
        completedAt: "2026-04-13T00:10:00.000Z",
        items: [
          {
            type: "agentMessage",
            phase: "final_answer",
            text: "relay smoke retry ok",
          },
        ],
      };
    },
  };

  const result = await deliverMessageToThread(fakeSession, {
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
    message: "Reply exactly relay smoke retry ok",
    timeoutSec: 5,
    resolution: "by_thread_id",
    created: false,
  });

  assert.equal(waitAttempts, 2);
  assert.match(result.payload.replyText, /relay smoke retry ok/i);
});
