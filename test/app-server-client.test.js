import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEnvelope,
  CodexAppServerSession,
  extractTurnReply,
  normalizeTimeoutSeconds,
} from "../src/app-server-client.js";

test("buildEnvelope preserves the delegated request body", () => {
  const envelope = buildEnvelope("Reply with exactly relay smoke ok");
  assert.match(envelope, /\[Codex Thread Relay\]/);
  assert.match(envelope, /Delegated request:/);
  assert.match(envelope, /Treat the delegated request below exactly as the current user request/i);
  assert.match(envelope, /Approval prompts may be disabled/);
  assert.match(envelope, /codex-autonomy flow from the repo root/i);
  assert.match(envelope, /Reply with exactly relay smoke ok/);
});

test("buildEnvelope adds codex-autonomy status guidance for report requests", () => {
  const envelope = buildEnvelope("汇报当前情况");
  assert.match(envelope, /Relay control-surface hint:/);
  assert.match(envelope, /Run `codex-autonomy status` from the repo root before answering\./);
  assert.match(envelope, /git_runtime_probe_deferred/);
  assert.match(envelope, /automation_state`, `ready_for_automation`, `next_automation_reason`, and `report_thread_id`/);
});

test("extractTurnReply prefers the final answer phase", () => {
  const reply = extractTurnReply({
    items: [
      { type: "agentMessage", phase: "commentary", text: "thinking" },
      { type: "agentMessage", phase: "final_answer", text: "final body" },
      { type: "agentMessage", phase: "final_answer", text: "final body 2" },
    ],
  });

  assert.equal(reply, "final body 2");
});

test("normalizeTimeoutSeconds validates and falls back to session defaults", () => {
  assert.equal(normalizeTimeoutSeconds(undefined, 90), 90);
  assert.equal(normalizeTimeoutSeconds(15, 90), 15);
  assert.throws(() => normalizeTimeoutSeconds(0, 90), /positive number/);
});

test("waitForTurn returns immediately when thread/read already shows a terminal historical turn", async () => {
  const session = new CodexAppServerSession({
    requestTimeoutMs: 50,
    pollIntervalMs: 10,
    turnTimeoutMs: 100,
  });

  session.request = async (method, params) => {
    assert.equal(method, "thread/read");
    assert.equal(params.threadId, "thread-1");
    return {
      result: {
        thread: {
          turns: [
            {
              id: "turn-1",
              status: "interrupted",
              completedAt: "2026-04-17T06:00:00.000Z",
              error: {
                message: "Interrupted by operator",
              },
              items: [
                {
                  id: "item-1",
                  type: "userMessage",
                  text: "hello",
                },
              ],
            },
          ],
        },
      },
    };
  };

  const turn = await session.waitForTurn("thread-1", "turn-1", 100);
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.error?.message, "Interrupted by operator");
  assert.equal(turn.items.length, 1);
});

test("waitForTurn polls thread/read so recovered historical turns can finish without a live notification", async () => {
  const session = new CodexAppServerSession({
    requestTimeoutMs: 50,
    pollIntervalMs: 10,
    turnTimeoutMs: 200,
  });

  let reads = 0;
  session.request = async (method) => {
    assert.equal(method, "thread/read");
    reads += 1;
    if (reads === 1) {
      return {
        result: {
          thread: {
            turns: [
              {
                id: "turn-2",
                status: "running",
                items: [],
              },
            ],
          },
        },
      };
    }

    return {
      result: {
        thread: {
          turns: [
            {
              id: "turn-2",
              status: "completed",
              completedAt: "2026-04-17T06:00:10.000Z",
              items: [
                {
                  id: "item-2",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "done",
                },
              ],
            },
          ],
        },
      },
    };
  };

  const turn = await session.waitForTurn("thread-1", "turn-2", 200);
  assert.equal(turn.status, "completed");
  assert.equal(extractTurnReply(turn), "done");
  assert.ok(reads >= 2);
});
