import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireThreadLease,
  listActiveDispatches,
  listRememberedThreads,
  releaseThreadLease,
  relayStatePath,
  rememberCreatedThread,
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
});
