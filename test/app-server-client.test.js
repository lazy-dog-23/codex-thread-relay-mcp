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
  assert.match(envelope, /Reply with exactly relay smoke ok/);
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
