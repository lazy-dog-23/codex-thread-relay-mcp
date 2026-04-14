import { CodexAppServerSession } from "./app-server-client.js";
import { toMcpError } from "./errors.js";
import { processAsyncDispatchWithSession } from "./relay-service.js";

export function makeToolResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

const backgroundToolTasks = new Set();

function scheduleBackgroundTask(task) {
  backgroundToolTasks.add(task);
  task.finally(() => {
    backgroundToolTasks.delete(task);
  });
}

export async function runTool(handler, options = {}) {
  const sessionFactory = options.sessionFactory ?? (() => new CodexAppServerSession());
  const backgroundProcessor = options.backgroundProcessor ?? ((session, dispatchId) =>
    processAsyncDispatchWithSession(session, dispatchId));
  const session = sessionFactory();
  let keepSessionOpen = false;

  try {
    await session.open();
    const result = await handler(session);
    return makeToolResult(result.text, result.payload);
  } catch (error) {
    const recoveryDispatchId = typeof error?.details?.recoveryDispatchId === "string"
      ? error.details.recoveryDispatchId.trim()
      : "";
    if (error?.relayCode === "turn_timeout" && recoveryDispatchId) {
      keepSessionOpen = true;
      const backgroundTask = Promise.resolve()
        .then(() => backgroundProcessor(session, recoveryDispatchId))
        .catch(() => {})
        .finally(async () => {
          try {
            await session.close();
          } catch {}
        });
      scheduleBackgroundTask(backgroundTask);
    }
    throw toMcpError(error);
  } finally {
    if (!keepSessionOpen) {
      await session.close();
    }
  }
}

export async function runLocalTool(handler) {
  try {
    const result = await handler();
    return makeToolResult(result.text, result.payload);
  } catch (error) {
    throw toMcpError(error);
  }
}

export function backgroundToolTaskCount() {
  return backgroundToolTasks.size;
}
