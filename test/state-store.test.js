import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireDispatchLease,
  acquireThreadLease,
  createDispatchRecord,
  getActiveDispatchLease,
  getActiveThreadLease,
  getDispatchRecord,
  listDispatchRecords,
  listActiveDispatches,
  listRememberedThreads,
  releaseDispatchLease,
  releaseThreadLease,
  relayStatePath,
  rememberCreatedThread,
  updateDispatchRecord,
  updateThreadLease,
} from "../src/state-store.js";

async function withRelayHome(t) {
  const previous = process.env.THREAD_RELAY_HOME;
  const relayHome = await fs.mkdtemp(path.join(os.tmpdir(), "thread-relay-state-"));
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

test("rememberCreatedThread upserts metadata and persists last turn info", async (t) => {
  await withRelayHome(t);

  await rememberCreatedThread({
    threadId: "thread-1",
    projectId: "C:\\Trusted\\Relay",
    name: "relay smoke",
    createdAt: "2026-04-13T00:00:00.000Z",
    lastUsedAt: "2026-04-13T00:00:00.000Z",
    lastTurnId: null,
  });
  await rememberCreatedThread({
    threadId: "thread-1",
    projectId: "C:\\Trusted\\Relay",
    name: "relay smoke renamed",
    lastUsedAt: "2026-04-13T00:05:00.000Z",
    lastTurnId: "turn-1",
  });

  const remembered = await listRememberedThreads("C:\\Trusted\\Relay");
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].name, "relay smoke renamed");
  assert.equal(remembered[0].createdAt, "2026-04-13T00:00:00.000Z");
  assert.equal(remembered[0].lastUsedAt, "2026-04-13T00:05:00.000Z");
  assert.equal(remembered[0].lastTurnId, "turn-1");
  assert.equal(relayStatePath(), path.join(process.env.THREAD_RELAY_HOME, "state.json"));
});

test("acquireThreadLease persists a dispatch lease and rejects a second active lease", async (t) => {
  await withRelayHome(t);

  const lease = await acquireThreadLease({
    threadId: "thread-lease",
    projectId: "C:\\Trusted\\Relay",
    ttlMs: 60_000,
  });
  const active = await listActiveDispatches("C:\\Trusted\\Relay");
  assert.equal(active.length, 1);
  assert.equal(active[0].threadId, "thread-lease");
  assert.equal((await getActiveThreadLease("thread-lease"))?.threadId, "thread-lease");

  const updatedLease = await updateThreadLease({
    threadId: "thread-lease",
    leaseId: lease.leaseId,
    turnId: "turn-lease-1",
  });
  assert.equal(updatedLease?.turnId, "turn-lease-1");
  assert.equal((await getActiveThreadLease("thread-lease"))?.turnId, "turn-lease-1");

  await assert.rejects(
    () => acquireThreadLease({
      threadId: "thread-lease",
      projectId: "C:\\Trusted\\Relay",
      ttlMs: 60_000,
    }),
    (error) => error?.relayCode === "target_busy",
  );

  await releaseThreadLease({
    threadId: "thread-lease",
    leaseId: lease.leaseId,
  });
  const afterRelease = await listActiveDispatches("C:\\Trusted\\Relay");
  assert.equal(afterRelease.length, 0);
  assert.equal(await getActiveThreadLease("thread-lease"), null);
});

test("dispatch records persist async dispatch state and worker leases", async (t) => {
  await withRelayHome(t);

  const acceptedAt = "2026-04-13T02:00:00.000Z";
  await createDispatchRecord({
    dispatchId: "dispatch-1",
    projectId: "C:\\Trusted\\Relay",
    threadId: "thread-1",
    threadName: "relay target",
    message: "reply exactly relay async",
    timeoutSec: 90,
    created: false,
    resolution: "by_thread_id",
    callbackThreadId: "source-thread",
    callbackStatus: "pending",
    dispatchStatus: "queued",
    createdAt: acceptedAt,
    acceptedAt,
    updatedAt: acceptedAt,
  });

  const stored = await getDispatchRecord("dispatch-1");
  assert.ok(stored);
  assert.equal(stored.dispatchStatus, "queued");
  assert.equal(stored.callbackStatus, "pending");
  assert.equal(stored.callbackThreadId, "source-thread");
  assert.deepEqual(
    (await listDispatchRecords("C:\\Trusted\\Relay")).map((item) => item.dispatchId),
    ["dispatch-1"],
  );

  const lease = await acquireDispatchLease({
    dispatchId: "dispatch-1",
    ttlMs: 60_000,
  });
  assert.equal((await getActiveDispatchLease("dispatch-1"))?.dispatchId, "dispatch-1");

  await assert.rejects(
    () => acquireDispatchLease({
      dispatchId: "dispatch-1",
      ttlMs: 60_000,
    }),
    (error) => error?.relayCode === "target_busy",
  );

  const updated = await updateDispatchRecord("dispatch-1", (current) => ({
    ...current,
    dispatchStatus: "succeeded",
    callbackStatus: "delivered",
    turnId: "turn-123",
    replyText: "relay async ok",
    timingMs: 1234,
    updatedAt: "2026-04-13T02:00:02.000Z",
  }));

  assert.ok(updated);
  assert.equal(updated.dispatchStatus, "succeeded");
  assert.equal(updated.callbackStatus, "delivered");
  assert.equal(updated.turnId, "turn-123");
  assert.equal(updated.replyText, "relay async ok");

  await releaseDispatchLease({
    dispatchId: "dispatch-1",
    leaseId: lease.leaseId,
  });
  assert.equal(await getActiveDispatchLease("dispatch-1"), null);
});
