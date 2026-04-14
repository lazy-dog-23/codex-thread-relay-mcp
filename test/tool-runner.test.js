import test from "node:test";
import assert from "node:assert/strict";

import { RelayError } from "../src/errors.js";
import { backgroundToolTaskCount, runLocalTool, runTool } from "../src/tool-runner.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("runTool closes the session after a successful tool invocation", async () => {
  const events = [];
  class FakeSession {
    async open() {
      events.push("open");
    }
    async close() {
      events.push("close");
    }
  }

  const result = await runTool(
    async () => ({
      text: "ok",
      payload: { ok: true },
    }),
    {
      sessionFactory: () => new FakeSession(),
    },
  );

  assert.equal(result.content[0].text, "ok");
  assert.deepEqual(events, ["open", "close"]);
});

test("runTool keeps the session alive while a timed out dispatch continues in background", async () => {
  const events = [];
  const gate = deferred();

  class FakeSession {
    async open() {
      events.push("open");
    }
    async close() {
      events.push("close");
    }
  }

  await assert.rejects(
    () => runTool(
      async () => {
        throw new RelayError("turn_timeout", "Timed out while waiting for thread thread-1 turn turn-1", {
          recoveryDispatchId: "dispatch-background",
        });
      },
      {
        sessionFactory: () => new FakeSession(),
        backgroundProcessor: async (_session, dispatchId) => {
          events.push(`background:${dispatchId}`);
          await gate.promise;
        },
      },
    ),
    (error) => error?.data?.relayCode === "turn_timeout",
  );

  assert.deepEqual(events, ["open", "background:dispatch-background"]);
  assert.equal(backgroundToolTaskCount(), 1);

  gate.resolve();
  await waitFor(() => events.includes("close") && backgroundToolTaskCount() === 0);

  assert.deepEqual(events, ["open", "background:dispatch-background", "close"]);
  assert.equal(backgroundToolTaskCount(), 0);
});

test("runLocalTool returns structured content without opening a session", async () => {
  const result = await runLocalTool(async () => ({
    text: "local",
    payload: { source: "local" },
  }));

  assert.equal(result.content[0].text, "local");
  assert.deepEqual(result.structuredContent, { source: "local" });
});
