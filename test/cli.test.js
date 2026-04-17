import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RelayError } from "../src/errors.js";
import { loadCliParams, main, parseCliArgs, runCliCommand } from "../src/cli.js";

function createMemoryStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    read() {
      return chunks.join("");
    },
  };
}

test("parseCliArgs and loadCliParams merge json, file, and explicit flags", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-relay-cli-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const paramsFile = path.join(tempDir, "params.json");
  const messageFile = path.join(tempDir, "message.md");
  await fs.writeFile(paramsFile, JSON.stringify({ threadId: "thread-from-file", timeoutSec: 20 }), "utf8");
  await fs.writeFile(messageFile, "relay cli message", "utf8");

  const parsed = parseCliArgs([
    "relay_send_wait",
    "--params-json",
    "{\"timeoutSec\":15,\"query\":\"alpha\"}",
    "--params-file",
    paramsFile,
    "--message-file",
    messageFile,
    "--timeout-sec",
    "45",
    "--create-if-missing",
    "--json",
  ]);
  const params = await loadCliParams(parsed);

  assert.equal(parsed.commandName, "relay_send_wait");
  assert.equal(parsed.outputJson, true);
  assert.deepEqual(params, {
    timeoutSec: 45,
    query: "alpha",
    threadId: "thread-from-file",
    message: "relay cli message",
    createIfMissing: true,
  });
});

test("runCliCommand opens and closes a session for session-bound commands", async () => {
  const events = [];
  class FakeSession {
    async open() {
      events.push("open");
    }
    async close() {
      events.push("close");
    }
  }

  const result = await runCliCommand(
    "relay_list_projects",
    {},
    {
      commands: {
        relay_list_projects: {
          requiresSession: true,
          handler: async (session) => {
            assert.ok(session instanceof FakeSession);
            return {
              text: "ok",
              payload: { ok: true },
            };
          },
        },
      },
      sessionFactory: () => new FakeSession(),
    },
  );

  assert.equal(result.text, "ok");
  assert.deepEqual(events, ["open", "close"]);
});

test("main prints json success payloads", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await main(
    ["relay_dispatch_status", "--dispatch-id", "dispatch-1", "--json"],
    {
      stdout,
      stderr,
      commands: {
        relay_dispatch_status: {
          requiresSession: false,
          handler: async (_session, params) => ({
            text: `Dispatch ${params.dispatchId}`,
            payload: params,
          }),
        },
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");

  const parsed = JSON.parse(stdout.read());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "relay_dispatch_status");
  assert.equal(parsed.payload.dispatchId, "dispatch-1");
});

test("main prints json error payloads with relay metadata", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await main(
    ["relay_send_wait", "--thread-id", "thread-1", "--json"],
    {
      stdout,
      stderr,
      commands: {
        relay_send_wait: {
          requiresSession: false,
          handler: async () => {
            throw new RelayError("target_busy", "Thread is busy", {
              activeDispatchId: "dispatch-busy",
              usageRole: "bridge",
              recommendedSurface: "thread_automation",
              recommendedPattern: "move_to_bound_thread",
            });
          },
        },
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stderr.read(), "");

  const parsed = JSON.parse(stdout.read());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "relay_send_wait");
  assert.equal(parsed.relayCode, "target_busy");
  assert.equal(parsed.details.activeDispatchId, "dispatch-busy");
  assert.equal(parsed.details.usageRole, "bridge");
  assert.equal(parsed.details.recommendedSurface, "thread_automation");
  assert.equal(parsed.details.recommendedPattern, "move_to_bound_thread");
});

test("main help output prefers async/status/recover before send_wait examples", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await main(["--help"], { stdout, stderr });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  const output = stdout.read();
  assert.ok(output.indexOf("relay_dispatch_async") < output.indexOf("relay_send_wait"));
  assert.match(output, /relay_dispatch_async --project-id <project-id>/);
  assert.match(output, /relay_dispatch_status --dispatch-id <dispatch-id>/);
  assert.match(output, /relay_dispatch_recover --dispatch-id <dispatch-id>/);
  assert.match(output, /relay_send_wait --thread-id <thread-id> --message-file \.\\probe\.md/);
});
