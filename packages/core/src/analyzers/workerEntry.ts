import { parentPort, workerData } from "node:worker_threads";
import { AnalysisError } from "../model.js";
import type { LoadedTarget } from "../target.js";
import { analyzeTarget, type AnalyzeOptions } from "./dispatch.js";

const data = workerData as {
  info: LoadedTarget["info"];
  bytes: Uint8Array;
  lazy: boolean;
  unpacked?: Record<string, Uint8Array>;
  options?: AnalyzeOptions;
};
const target: LoadedTarget = {
  info: data.info,
  bytes: data.bytes,
  ...(data.lazy ? { lazy: true } : {}),
  ...(data.unpacked ? { unpacked: data.unpacked } : {}),
};

analyzeTarget(target, data.options ?? {}).then(
  (analysis) => parentPort?.postMessage({ ok: true, analysis }),
  (error: unknown) => {
    const e =
      error instanceof AnalysisError
        ? { code: error.code, message: error.message, details: error.details }
        : {
            code: "malformed" as const,
            message: error instanceof Error ? error.message : String(error),
            details: {},
          };
    parentPort?.postMessage({ ok: false, error: e });
  },
);
