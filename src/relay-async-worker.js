import { CodexAppServerSession } from "./app-server-client.js";
import { processAsyncDispatchWithSession } from "./relay-service.js";

async function main() {
  const dispatchId = process.argv[2];
  if (!dispatchId) {
    process.exitCode = 1;
    return;
  }

  const session = new CodexAppServerSession();
  await session.open();
  try {
    await processAsyncDispatchWithSession(session, dispatchId);
  } finally {
    await session.close();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
