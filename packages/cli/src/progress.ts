import type { AnalysisProgress } from "@hexvero/core";
import type { Io } from "./format.js";

const WORDS: Record<Parameters<AnalysisProgress>[0], string> = {
  reading: "reading JavaScript",
  scanning: "scanning JavaScript",
  linking: "linking modules",
};

/**
 * A status line for analyses that take a while: nothing for the first `delayMs`, then one line on
 * stderr that replaces itself ("hexvero: scanning JavaScript 120/840 files · 3 s"), redrawn at
 * most every 100 ms and cleared before anything else is printed. Without `io.status` (not a
 * terminal, --json, tests) it is a no-op. The analysis runs on this thread, so the line is drawn
 * from the progress callback itself as well as from a timer for the stretches that await.
 */
export function startProgress(
  io: Io,
  options: { delayMs?: number; now?: () => number } = {},
): { onProgress: AnalysisProgress | undefined; stop: () => void } {
  const status = io.status;
  if (!status) return { onProgress: undefined, stop: () => {} };
  const now = options.now ?? Date.now;
  const delay = options.delayMs ?? 1000;
  const started = now();
  let last = 0;
  let text = "reading the build";
  let drawn: string | null = null;
  let stopped = false;
  const draw = (force: boolean): void => {
    const t = now();
    if (stopped || t - started < delay || (!force && t - last < 100)) return;
    last = t;
    const line = `hexvero: ${text} · ${Math.floor((t - started) / 1000)} s`;
    if (line === drawn) return;
    drawn = line;
    status(line);
  };
  const timer = setInterval(() => draw(true), 250);
  timer.unref();
  return {
    onProgress: (phase, done, total) => {
      text =
        phase === "linking"
          ? `${WORDS[phase]} (${done} files read)`
          : `${WORDS[phase]} ${done}/${total} files`;
      draw(false);
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (drawn !== null) status(null);
      drawn = null;
    },
  };
}
