import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisError } from "../model.js";
import type { LoadedTarget } from "../target.js";
import type { AnalyzeOptions, AnyAnalysis } from "./dispatch.js";

export interface WorkerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** V8 old-space limit for the worker in MiB; the worker dies cleanly instead of taking the server down. */
  maxOldGenerationSizeMb?: number;
  /** Passed to the analyzer in the worker (e.g. how far to continue a JavaScript scan). */
  analyze?: AnalyzeOptions;
}

export const DEFAULT_ANALYSIS_TIMEOUT_MS = Number(
  process.env["HEXVERO_ANALYSIS_TIMEOUT_MS"] ?? 120_000,
);

interface WorkerMessage {
  ok: boolean;
  analysis?: AnyAnalysis;
  error?: { code: AnalysisError["code"]; message: string; details: Record<string, unknown> };
}

/**
 * Runs analyzeTarget in a dedicated worker so a 500 MB bundle never blocks
 * the MCP or HTTP event loop. Bytes are transferred, not copied, when the
 * caller allows it. Timeout and abort terminate the worker and surface a
 * structured error; the main process keeps serving. Abort is `cancelled`;
 * a timeout or heap exhaustion is `too_large` (a resource budget was
 * exceeded) with `details.reason` `"timeout"` or `"memory"`.
 */
export function analyzeInWorker(
  target: LoadedTarget,
  options: WorkerOptions = {},
): Promise<AnyAnalysis> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new AnalysisError("cancelled", "Analysis cancelled by the caller", {
        path: target.info.path,
      }),
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS;
  const here = dirname(fileURLToPath(import.meta.url));
  // Built output sits next to this file; when running from TypeScript sources (tests) use the compiled worker in dist.
  const entry = [
    join(here, "workerEntry.js"),
    join(here, "..", "..", "dist", "analyzers", "workerEntry.js"),
  ].find((p) => existsSync(p));
  if (!entry)
    throw new AnalysisError(
      "provider_unavailable",
      "Analysis worker is not built; run npm run build",
    );
  // An owned copy: Buffer.slice shares pooled storage, which cannot be transferred and would detach the session's bytes.
  const copy = new Uint8Array(target.bytes);
  const worker = new Worker(entry, {
    workerData: {
      info: target.info,
      bytes: copy,
      lazy: target.lazy ?? false,
      options: options.analyze ?? {},
    },
    transferList: [copy.buffer],
    resourceLimits: options.maxOldGenerationSizeMb
      ? { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb }
      : {},
  });
  return new Promise<AnyAnalysis>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new AnalysisError("too_large", `Analysis exceeded ${timeoutMs} ms and was stopped`, {
              reason: "timeout",
              timeoutMs,
              path: target.info.path,
            }),
          ),
        ),
      timeoutMs,
    );
    const onAbort = (): void =>
      finish(() =>
        reject(
          new AnalysisError("cancelled", "Analysis cancelled by the caller", {
            path: target.info.path,
          }),
        ),
      );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: WorkerMessage) => {
      finish(() => {
        if (message.ok && message.analysis) resolve(message.analysis);
        else {
          const e = message.error ?? {
            code: "malformed" as const,
            message: "worker returned no result",
            details: {},
          };
          reject(new AnalysisError(e.code, e.message, e.details));
        }
      });
    });
    worker.once("error", (error: Error) => {
      const oom = /heap|memory/i.test(error.message);
      finish(() =>
        reject(
          new AnalysisError(
            oom ? "too_large" : "malformed",
            `${oom ? "Analysis ran out of memory" : "Analysis failed"}: ${error.message}`,
            oom ? { reason: "memory", path: target.info.path } : { path: target.info.path },
          ),
        ),
      );
    });
    worker.once("exit", (code) => {
      if (code !== 0)
        finish(() =>
          reject(
            new AnalysisError("malformed", `Analysis worker exited with code ${code}`, {
              path: target.info.path,
            }),
          ),
        );
    });
  });
}
