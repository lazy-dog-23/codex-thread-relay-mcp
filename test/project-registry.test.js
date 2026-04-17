import test from "node:test";
import assert from "node:assert/strict";

import {
  filterThreadsForProject,
  getTrustedProjects,
  normalizeWindowsPath,
  normalizeWindowsPathKey,
} from "../src/project-registry.js";

test("normalizeWindowsPath strips extended prefixes and normalizes slashes", () => {
  assert.equal(
    normalizeWindowsPath("\\\\?\\C:\\Users\\Administrator\\Desktop\\Project\\test\\codex-thread-relay-mcp\\"),
    "C:\\Users\\Administrator\\Desktop\\Project\\test\\codex-thread-relay-mcp",
  );
  assert.equal(
    normalizeWindowsPathKey("C:/Example/Project/Test/Repo"),
    "c:\\example\\project\\test\\repo",
  );
});

test("getTrustedProjects only returns trusted Windows Codex projects", () => {
  const config = {
    result: {
      config: {
        projects: {
          "C:\\Trusted\\A": { trust_level: "trusted" },
          "C:\\Untrusted\\B": { trust_level: "untrusted" },
          "C:\\Trusted\\C": { trust_level: "trusted" },
        },
      },
    },
  };

  const projects = getTrustedProjects(config);
  assert.deepEqual(
    projects.map((project) => project.projectId),
    ["C:\\Trusted\\A", "C:\\Trusted\\C"],
  );
});

test("filterThreadsForProject keeps only matching cwd rows and applies query text", () => {
  const project = {
    projectId: "C:\\Trusted\\Relay",
    path: "C:\\Trusted\\Relay",
    pathKey: "c:\\trusted\\relay",
    name: "Relay",
  };
  const threads = [
    { id: "thread-1", cwd: "C:\\Trusted\\Relay", name: "relay smoke" },
    { id: "thread-2", cwd: "C:\\Trusted\\Relay", name: "other" },
    { id: "thread-3", cwd: "C:\\Trusted\\Other", name: "relay smoke" },
  ];

  const filtered = filterThreadsForProject(threads, project, "smoke");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].threadId, "thread-1");
});
