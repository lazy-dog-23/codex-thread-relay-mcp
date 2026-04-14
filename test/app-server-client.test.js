import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEnvelope,
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
