/**
 * Reads the tokens of many files of one application in worker threads. Each worker runs the same
 * pure `readFileTokens` that the sequential scan runs, and the scan merges the results in its
 * fixed file order, so the analysis is identical with or without the pool; only the wall time
 * changes. A file whose worker fails is simply left out and read by the scan itself.
 */
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileTokenFacts } from "./app.js";

/** Below this much source the threads cost more to start than they save. */
export const PARALLEL_MIN_BYTES = 4 << 20;

/** Worker threads for a scan: HEXVERO_JS_THREADS if set (0 turns the pool off), else up to 3. */
export function scanThreads(): number {
  const configured = Number(process.env["HEXVERO_JS_THREADS"]);
  if (process.env["HEXVERO_JS_THREADS"] !== undefined && Number.isFinite(configured))
    return Math.max(0, Math.min(16, Math.floor(configured)));
  return Math.max(0, Math.min(3, availableParallelism() - 1));
}

function workerEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built output sits next to this file; tests running from sources use the compiled one in dist.
  return (
    [
      join(here, "tokenWorker.js"),
      join(here, "..", "..", "dist", "javascript", "tokenWorker.js"),
    ].find((p) => existsSync(p)) ?? null
  );
}

export async function readTokensInParallel(
  input: ReadonlyArray<{ path: string; size: number; read: () => string | null }>,
  threads: number,
  /** Called with the number of files handed back so far, for a progress line. */
  onDone?: (done: number) => void,
): Promise<Map<string, FileTokenFacts>> {
  const out = new Map<string, FileTokenFacts>();
  // Largest first: the wall time is bounded by the largest file, so it must not start last.
  const files = input.toSorted((a, b) => b.size - a.size);
  const entry = workerEntry();
  if (!entry || threads < 1 || files.length < 2) return out;
  const workers: Worker[] = [];
  let next = 0;
  let finished = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(threads, files.length) }, async () => {
        const worker = new Worker(entry);
        workers.push(worker);
        worker.unref();
        while (next < files.length) {
          const id = next++;
          const file = files[id]!;
          const source = file.read();
          if (source === null) {
            onDone?.(++finished);
            continue;
          }
          const reply = await new Promise<{ facts?: FileTokenFacts } | null>((resolve) => {
            const onMessage = (m: { id: number; facts?: FileTokenFacts }): void => {
              if (m.id !== id) return;
              cleanup();
              resolve(m);
            };
            const onError = (): void => {
              cleanup();
              resolve(null);
            };
            const cleanup = (): void => {
              worker.off("message", onMessage);
              worker.off("error", onError);
              worker.off("exit", onError);
            };
            worker.on("message", onMessage);
            worker.once("error", onError);
            worker.once("exit", onError);
            worker.postMessage({ id, path: file.path, source });
          });
          onDone?.(++finished);
          // A worker that failed is not used again; its remaining files are read by the scan.
          if (!reply) return;
          if (reply.facts) out.set(file.path, reply.facts);
        }
      }),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return out;
}
