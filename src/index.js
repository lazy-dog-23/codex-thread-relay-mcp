import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CodexAppServerSession } from "./app-server-client.js";
import { toMcpError } from "./errors.js";
import {
  createThreadAction,
  dispatchAction,
  listProjectsAction,
  listThreadsAction,
  sendWaitAction,
} from "./relay-service.js";

function makeToolResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

async function withSession(handler) {
  const session = new CodexAppServerSession();
  await session.open();
  try {
    return await handler(session);
  } finally {
    await session.close();
  }
}

async function runTool(handler) {
  try {
    const result = await withSession(handler);
    return makeToolResult(result.text, result.payload);
  } catch (error) {
    throw toMcpError(error);
  }
}

const server = new McpServer({
  name: "codex-thread-relay-mcp",
  version: "0.1.0",
});

server.tool(
  "relay_list_projects",
  "List trusted Windows Codex App projects available for cross-thread relay.",
  {},
  async () => runTool((session) => listProjectsAction(session)),
);

server.tool(
  "relay_list_threads",
  "List local threads for a trusted target project.",
  {
    projectId: z.string().min(1),
    query: z.string().optional(),
  },
  async ({ projectId, query }) =>
    runTool((session) => listThreadsAction(session, { projectId, query })),
);

server.tool(
  "relay_create_thread",
  "Create a new empty thread inside a trusted target project.",
  {
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
  },
  async ({ projectId, name }) =>
    runTool((session) => createThreadAction(session, { projectId, name })),
);

server.tool(
  "relay_send_wait",
  "Send one delegated request to an existing local target thread and wait for its final text reply.",
  {
    threadId: z.string().min(1),
    message: z.string().trim().min(1),
    timeoutSec: z.number().int().positive().max(3600).optional(),
  },
  async ({ threadId, message, timeoutSec }) =>
    runTool((session) => sendWaitAction(session, { threadId, message, timeoutSec })),
);

server.tool(
  "relay_dispatch",
  "Resolve or create a target thread inside a trusted project, send one delegated request, and wait for the final text reply.",
  {
    projectId: z.string().min(1),
    message: z.string().trim().min(1),
    threadId: z.string().trim().min(1).optional(),
    threadName: z.string().trim().min(1).max(120).optional(),
    query: z.string().trim().min(1).optional(),
    createIfMissing: z.boolean().optional(),
    timeoutSec: z.number().int().positive().max(3600).optional(),
  },
  async ({ projectId, message, threadId, threadName, query, createIfMissing, timeoutSec }) =>
    runTool((session) => dispatchAction(session, {
      projectId,
      message,
      threadId,
      threadName,
      query,
      createIfMissing,
      timeoutSec,
    })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
