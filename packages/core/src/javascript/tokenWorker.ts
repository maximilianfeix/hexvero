import { parentPort } from "node:worker_threads";
import { readFileTokens } from "./app.js";

/** One file at a time: `{ id, path, source }` in, `{ id, facts }` or `{ id, error }` out. */
parentPort?.on("message", (message: { id: number; path: string; source: string }) => {
  try {
    parentPort?.postMessage({
      id: message.id,
      facts: readFileTokens(message.path, message.source),
    });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
