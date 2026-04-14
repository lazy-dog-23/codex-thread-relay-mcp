import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createThreadAction,
  dispatchAsyncAction,
  dispatchDeliverAction,
  dispatchRecoverAction,
  dispatchAction,
  dispatchStatusAction,
  listProjectsAction,
  listThreadsAction,
  sendWaitAction,
} from "./relay-service.js";
import { runLocalTool, runTool } from "./tool-runner.js";

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
  "Send one delegated request to an existing local target thread and wait for its final text reply. Long sync timeouts return a recoveryDispatchId for follow-up status or recovery.",
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
  "Resolve or create a target thread inside a trusted project, send one delegated request, and wait for the final text reply. Long sync timeouts return a recoveryDispatchId for follow-up status or recovery.",
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

server.tool(
  "relay_dispatch_async",
  "Resolve or create a target thread inside a trusted project, enqueue one delegated request asynchronously, and optionally callback another thread on completion.",
  {
    projectId: z.string().min(1),
    message: z.string().trim().min(1),
    threadId: z.string().trim().min(1).optional(),
    threadName: z.string().trim().min(1).max(120).optional(),
    query: z.string().trim().min(1).optional(),
    createIfMissing: z.boolean().optional(),
    callbackThreadId: z.string().trim().min(1).optional(),
    timeoutSec: z.number().int().positive().max(3600).optional(),
  },
  async ({ projectId, message, threadId, threadName, query, createIfMissing, callbackThreadId, timeoutSec }) =>
    runTool((session) => dispatchAsyncAction(session, {
      projectId,
      message,
      threadId,
      threadName,
      query,
      createIfMissing,
      callbackThreadId,
      timeoutSec,
    })),
);

server.tool(
  "relay_dispatch_status",
  "Read the durable status of a previously accepted async relay dispatch.",
  {
    dispatchId: z.string().trim().min(1),
  },
  async ({ dispatchId }) =>
    runLocalTool(() => dispatchStatusAction({ dispatchId })),
);

server.tool(
  "relay_dispatch_deliver",
  "Retry delivery of an async relay completion callback into a source thread.",
  {
    dispatchId: z.string().trim().min(1),
    callbackThreadId: z.string().trim().min(1).optional(),
  },
  async ({ dispatchId, callbackThreadId }) =>
    runTool((session) => dispatchDeliverAction(session, { dispatchId, callbackThreadId })),
);

server.tool(
  "relay_dispatch_recover",
  "Recover one async relay dispatch, or batch-recover pending/stale async relay dispatches when that is safe.",
  {
    dispatchId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
    callbackThreadId: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().max(20).optional(),
  },
  async ({ dispatchId, projectId, callbackThreadId, limit }) =>
    runTool((session) => dispatchRecoverAction(session, {
      dispatchId,
      projectId,
      callbackThreadId,
      limit,
    })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
